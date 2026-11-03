/**
 * Cloudflare Worker：域名雷达 API
 *
 * 路由：
 *   GET  /api/health              运行状态与目录版本
 *   GET  /api/check?domain=...    单个域名（带边缘缓存）
 *   POST /api/check               批量，body = { domains: string[] }（≤ 12 个/次）
 *
 * 其余请求交给静态资源（public/）。
 */
import { connect } from 'cloudflare:sockets';
import catalog from '../public/data/tlds.json';
import { checkBatch, normalizeDomain } from './lib/checker.js';

const MAX_BATCH = 12;
const CONCURRENCY = 6;
const RDAP_TIMEOUT = 5000;
const WHOIS_TIMEOUT = 6000;
const DNS_TIMEOUT = 3000;

const ENTRIES = new Map(catalog.tlds.map((t) => [t.n, t]));
const lookup = (tld) => ENTRIES.get(tld);

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '86400',
};

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS, ...extra },
  });
}

/* ------------------------------- IO 适配器 ------------------------------- */

async function rdapFetch(url, timeout = RDAP_TIMEOUT) {
  const res = await fetch(url, {
    headers: { accept: 'application/rdap+json' },
    signal: AbortSignal.timeout(timeout),
    cf: { cacheTtl: 300 },
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return { status: res.status, json: data };
}

/** 通过 TCP 43 端口直连注册局 WHOIS，读到连接关闭或静默 700ms 为止。 */
function whoisQuery(host, query, timeout = WHOIS_TIMEOUT) {
  return new Promise((resolve, reject) => {
    let socket = null;
    let settled = false;
    let quiet = null;
    const chunks = [];
    const timer = setTimeout(() => finish(new Error('WHOIS 超时')), timeout);

    function finish(err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (quiet) clearTimeout(quiet);
      try {
        socket?.close();
      } catch {
        /* 忽略关闭异常 */
      }
      if (err) reject(err);
      else resolve(chunks.join(''));
    }

    try {
      socket = connect({ hostname: host, port: 43 });
    } catch (err) {
      finish(err);
      return;
    }

    (async () => {
      try {
        await socket.opened;
        const writer = socket.writable.getWriter();
        await writer.write(new TextEncoder().encode(query));
        writer.releaseLock();

        const reader = socket.readable.getReader();
        const decoder = new TextDecoder();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) chunks.push(decoder.decode(value, { stream: true }));
          if (quiet) clearTimeout(quiet);
          quiet = setTimeout(() => finish(), 700);
        }
        chunks.push(decoder.decode());
        finish();
      } catch (err) {
        finish(err);
      }
    })();
  });
}

const DNS_PROVIDERS = [
  (d) => `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(d)}&type=NS`,
  (d) => `https://doh.pub/dns-query?name=${encodeURIComponent(d)}&type=NS`,
  (d) => `https://dns.alidns.com/resolve?name=${encodeURIComponent(d)}&type=NS`,
];

/** DoH 三路并发竞速：任一返回明确结果即采用，全部失败才报错。 */
async function dnsNs(domain, timeout = DNS_TIMEOUT) {
  const attempts = DNS_PROVIDERS.map(async (build) => {
    const res = await fetch(build(domain), {
      headers: { accept: 'application/dns-json' },
      signal: AbortSignal.timeout(timeout),
      cf: { cacheTtl: 120 },
    });
    if (!res.ok) throw new Error(`DoH ${res.status}`);
    const data = await res.json();
    const status = Number(data.Status);
    if (status === 0) {
      const answers = (data.Answer || []).filter((a) => a.type === 2);
      return { nxdomain: false, hasNs: answers.length > 0 };
    }
    if (status === 3) return { nxdomain: true, hasNs: false };
    throw new Error(`DoH status ${status}`);
  });
  return Promise.any(attempts);
}

const io = { rdap: rdapFetch, whois: whoisQuery, dns: dnsNs };

/* -------------------------------- 缓存 -------------------------------- */

function cacheKey(domain) {
  return new Request(`https://cache.dotradar.internal/v1/${domain}`, { method: 'GET' });
}

async function readCache(domain) {
  try {
    if (!caches?.default) return null;
    const res = await caches.default.match(cacheKey(domain));
    if (!res) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function writeCache(domain, result) {
  if (!result || (result.status !== 'available' && result.status !== 'registered')) return;
  const ttl = result.status === 'available' ? 1800 : 21600;
  try {
    if (!caches?.default) return;
    await caches.default.put(
      cacheKey(domain),
      new Response(JSON.stringify(result), {
        headers: { 'content-type': 'application/json', 'cache-control': `max-age=${ttl}` },
      }),
    );
  } catch {
    /* 缓存失败不影响结果 */
  }
}

async function checkWithCache(domain) {
  const hit = await readCache(domain);
  if (hit) return { ...hit, cached: true };
  const { results } = await checkBatch([domain], lookup, io, { concurrency: 1 });
  const result = results[0];
  await writeCache(domain, result);
  return result;
}

/* -------------------------------- 路由 -------------------------------- */

async function handleApi(request, url) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  if (url.pathname === '/api/health') {
    return json({
      ok: true,
      service: 'domainradar',
      catalog: {
        version: catalog._meta.version,
        generatedAt: catalog._meta.generatedAt,
        counts: catalog._meta.counts,
      },
      limits: { maxBatch: MAX_BATCH, concurrency: CONCURRENCY },
    });
  }

  if (url.pathname !== '/api/check') return json({ error: 'Not Found' }, 404);

  if (request.method === 'GET') {
    const raw = url.searchParams.get('domain') || '';
    const norm = normalizeDomain(raw);
    if (norm.error) return json({ error: norm.error }, 400);
    const result = await checkWithCache(norm.domain);
    return json({ result });
  }

  if (request.method === 'POST') {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: '请求体不是合法 JSON' }, 400);
    }
    const list = Array.isArray(body?.domains) ? body.domains : [];
    if (!list.length) return json({ error: 'domains 不能为空' }, 400);
    if (list.length > MAX_BATCH) return json({ error: `单次最多 ${MAX_BATCH} 个域名` }, 413);

    const normalized = [];
    const seen = new Set();
    for (const raw of list.slice(0, MAX_BATCH)) {
      const norm = normalizeDomain(String(raw));
      if (norm.error || seen.has(norm.domain)) continue;
      seen.add(norm.domain);
      normalized.push(norm.domain);
    }
    if (!normalized.length) return json({ error: '没有合法的域名' }, 400);

    const cachedMap = new Map();
    const fresh = [];
    await Promise.all(
      normalized.map(async (domain) => {
        const hit = await readCache(domain);
        if (hit) cachedMap.set(domain, { ...hit, cached: true });
        else fresh.push(domain);
      }),
    );

    let checked = [];
    let elapsed = 0;
    if (fresh.length) {
      const batch = await checkBatch(fresh, lookup, io, { concurrency: CONCURRENCY });
      checked = batch.results;
      elapsed = batch.elapsed;
      await Promise.all(checked.map((r) => writeCache(r.domain, r)));
    }

    const byDomain = new Map([...cachedMap, ...checked.map((r) => [r.domain, r])]);
    const results = normalized.map((d) => byDomain.get(d)).filter(Boolean);
    const summary = { total: results.length, available: 0, registered: 0, unknown: 0, invalid: 0 };
    for (const r of results) summary[r.status] = (summary[r.status] || 0) + 1;
    return json({ results, summary, elapsed, cached: cachedMap.size, catalogVersion: catalog._meta.version });
  }

  return json({ error: 'Method Not Allowed' }, 405);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith('/api/')) return await handleApi(request, url);
      if (env?.ASSETS) return await env.ASSETS.fetch(request);
      return json({ error: 'Not Found' }, 404);
    } catch (err) {
      return json({ error: '服务异常', detail: String(err?.message || err) }, 500);
    }
  },
};
