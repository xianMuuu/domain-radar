/**
 * 本地开发服务器：静态资源 + /api/*，与 Worker 行为一致但不是 Cloudflare 运行时。
 * 用途：本地验收、真实网络下的判定测试（RDAP / WHOIS / DoH 全部走真实请求）。
 *
 *   node src/dev-server.mjs            # http://127.0.0.1:8787
 *   PORT=9000 node src/dev-server.mjs
 */
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkBatch, normalizeDomain } from './lib/checker.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT || 8787);
const MAX_BATCH = 12;

const catalog = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'data', 'tlds.json'), 'utf8'));
const ENTRIES = new Map(catalog.tlds.map((t) => [t.n, t]));
const lookup = (tld) => ENTRIES.get(tld);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
};

async function rdapFetch(url, timeout = 6500) {
  const res = await fetch(url, {
    headers: { accept: 'application/rdap+json, application/json', 'user-agent': 'domainradar-dev/1.0' },
    signal: AbortSignal.timeout(timeout),
  });
  let json = null;
  if (res.status === 200) {
    try {
      json = await res.json();
    } catch {}
  }
  return { status: res.status, json };
}

function whoisQuery(host, query, timeoutMs = 7000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port: 43 });
    let text = '';
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(hard);
      socket.destroy();
      err ? reject(err) : resolve(text);
    };
    const hard = setTimeout(() => finish(new Error('whois timeout')), timeoutMs);
    socket.setTimeout(timeoutMs, () => finish(new Error('whois timeout')));
    socket.on('connect', () => socket.write(query));
    socket.on('data', (chunk) => {
      text += chunk.toString('utf8');
      if (text.length > 200_000) finish();
    });
    socket.on('end', () => finish());
    socket.on('error', (err) => finish(err));
  });
}

const DOH_PROVIDERS = [
  (d) => `https://doh.pub/dns-query?name=${encodeURIComponent(d)}&type=NS`,
  (d) => `https://dns.alidns.com/resolve?name=${encodeURIComponent(d)}&type=NS`,
  (d) => `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(d)}&type=NS`,
];

async function dnsNs(domain, timeout = 4000) {
  let lastErr = null;
  for (const build of DOH_PROVIDERS) {
    try {
      const res = await fetch(build(domain), {
        headers: { accept: 'application/dns-json' },
        signal: AbortSignal.timeout(timeout),
      });
      if (!res.ok) throw new Error(`DoH ${res.status}`);
      const data = await res.json();
      const status = Number(data.Status);
      if (status === 3) return { nxdomain: true, hasNs: false };
      if (status !== 0) throw new Error(`DoH status ${status}`);
      return { nxdomain: false, hasNs: (data.Answer || []).some((a) => a.type === 2) };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('DoH unavailable');
}

const io = { rdap: rdapFetch, whois: whoisQuery, dns: dnsNs };

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'access-control-allow-origin': '*',
    'cache-control': 'no-store',
  });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error('body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function handleApi(req, res, url) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
    });
    return res.end();
  }

  if (url.pathname === '/api/health') {
    return sendJson(res, 200, {
      ok: true,
      service: 'domainradar-dev',
      catalog: { version: catalog._meta.version, counts: catalog._meta.counts },
    });
  }

  if (url.pathname !== '/api/check') return sendJson(res, 404, { error: 'Not Found' });

  try {
    if (req.method === 'GET') {
      const norm = normalizeDomain(url.searchParams.get('domain') || '');
      if (norm.error) return sendJson(res, 400, { error: norm.error });
      const { results } = await checkBatch([norm.domain], lookup, io, { concurrency: 1 });
      console.log(`  GET ${norm.domain} → ${results[0].status} (${results[0].source}, ${results[0].ms}ms)`);
      return sendJson(res, 200, { result: results[0] });
    }

    if (req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const list = Array.isArray(body?.domains) ? body.domains : [];
      if (!list.length) return sendJson(res, 400, { error: 'domains 不能为空' });
      if (list.length > MAX_BATCH) return sendJson(res, 413, { error: `单次最多 ${MAX_BATCH} 个域名` });

      const normalized = [];
      const seen = new Set();
      for (const raw of list) {
        const norm = normalizeDomain(String(raw));
        if (norm.error || seen.has(norm.domain)) continue;
        seen.add(norm.domain);
        normalized.push(norm.domain);
      }
      if (!normalized.length) return sendJson(res, 400, { error: '没有合法的域名' });

      const started = Date.now();
      const { results, summary, elapsed } = await checkBatch(normalized, lookup, io, {
        concurrency: 4,
        onResult: (i, r) => console.log(`  [${i + 1}/${normalized.length}] ${r.domain} → ${r.status} (${r.source}, ${r.ms}ms)`),
      });
      return sendJson(res, 200, { results, summary, elapsed, catalogVersion: catalog._meta.version, totalMs: Date.now() - started });
    }

    return sendJson(res, 405, { error: 'Method Not Allowed' });
  } catch (err) {
    console.error('  ! API error', err);
    return sendJson(res, 500, { error: '服务异常', detail: String(err?.message || err) });
  }
}

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('404 Not Found');
    }
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const isData = rel.startsWith('/data/');
    res.writeHead(200, {
      'content-type': type,
      'content-length': st.size,
      'cache-control': isData ? 'public, max-age=60' : 'no-store',
    });
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url).catch((err) => sendJson(res, 500, { error: String(err?.message || err) }));
  } else {
    serveStatic(req, res, url);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`域名雷达 dev server → http://127.0.0.1:${PORT}`);
  console.log(`后缀目录：${catalog._meta.counts.total} 个（RDAP ${catalog._meta.counts.rdap} / WHOIS ${catalog._meta.counts.whois} / DNS ${catalog._meta.counts.dnsOnly}）`);
});
