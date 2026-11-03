/**
 * 构建后缀目录 public/data/tlds.json
 *
 * 数据来源（全部为权威公开数据，构建期抓取一次）：
 *   1. https://data.iana.org/TLD/tlds-alpha-by-domain.txt  —— 全球根域后缀全集
 *   2. https://data.iana.org/rdap/dns.json                 —— IANA RDAP 引导（权威 RDAP 端点）
 *   3. data/whois-servers.json                             —— whois.iana.org 解析出的 WHOIS 服务器
 *   4. https://www.iana.org/domains/root/db                —— 后缀类型（cc / generic / sponsored …）
 *
 * 输出结构（紧凑字段，前端直接消费）：
 *   {
 *     "_meta": { version, generatedAt, counts... },
 *     "tlds": [
 *       { "n": "com", "t": "g", "l": 3, "r": ["https://rdap.verisign.com/com/v1/"] },
 *       { "n": "nz",  "t": "cc", "l": 2, "w": "whois.irs.net.nz" },
 *       { "n": "xn--fiqs8s", "u": "中国", "x": 1, "t": "cc", "l": 2 }
 *     ]
 *   }
 *
 * 字段：n 名 / u Unicode 展示名 / x 是否 IDN / t 类型 / l 长度 / r RDAP 端点 / w WHOIS 主机
 *       o=0 表示注册局限制公开注册（sponsored / generic-restricted / infrastructure）
 *       p=1 表示热门后缀（前端默认推荐位）
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, domainToUnicode } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'public', 'data', 'tlds.json');
const CACHE = path.join(ROOT, 'data', 'cache');
const UA = { 'user-agent': 'dotradar-catalog-builder/1.0 (+https://github.com/)' };

/** 一些常见后缀，用于前端「热门」快捷选择。 */
const POPULAR = new Set(
  `com net org io ai co me dev app xyz info online site shop top vip club live pro cc tv
   uk de cn jp nz au ca fr ru br in it nl se ch es eu us biz store tech cloud blog design art
   fun icu love wiki media agency digital studio email link click life world space website host
   press zone network today center group team plus chat fit games money law eco so gg ly to fm
   am tv me la id sg hk tw kr vn th my ph eu`
    .split(/\s+/)
    .filter(Boolean),
);

/** IANA 引导里没有、但人工验证确实提供 RDAP 的后缀。 */
const EXTRA_RDAP = {
  io: ['https://rdap.identitydigital.services/rdap/'],
};

const TYPE_MAP = {
  'country-code': 'cc',
  generic: 'g',
  sponsored: 's',
  'generic-restricted': 'r',
  infrastructure: 'i',
};

const TYPES_RESTRICTED = new Set(['s', 'r', 'i']);

/**
 * IANA 根域库目前把所有非 ccTLD 都标成 generic，无法据此判断注册限制，
 * 因此对公认「不向公众开放」的后缀单独维护一份清单。
 */
const RESTRICTED_TLDS = new Set([
  'gov', 'edu', 'mil', 'int', 'arpa', 'museum', 'aero', 'coop', 'jobs', 'post', 'cat', 'gov.uk',
]);

async function fetchText(url, { timeout = 60_000 } = {}) {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(timeout) });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.text();
}

async function fetchJson(url) {
  return JSON.parse(await fetchText(url));
}

async function cachedText(name, url, maxAgeMs = 7 * 24 * 3600_000) {
  const file = path.join(CACHE, name);
  try {
    const st = await fs.stat(file);
    if (Date.now() - st.mtimeMs < maxAgeMs) {
      return fs.readFile(file, 'utf8');
    }
  } catch {}
  const text = await fetchText(url, { timeout: 120_000 });
  await fs.mkdir(CACHE, { recursive: true });
  await fs.writeFile(file, text);
  return text;
}

/** 从 IANA 根域库页面解析每个后缀的类型。 */
export function parseRootDb(html) {
  const types = new Map();
  const marker = '<a href="/domains/root/db/';
  let idx = html.indexOf(marker);
  while (idx !== -1) {
    const start = idx + marker.length;
    const quote = html.indexOf('"', start);
    if (quote === -1) break;
    const name = html.slice(start, quote).toLowerCase();
    const next = html.indexOf(marker, quote);
    const chunk = html.slice(quote, next === -1 ? quote + 2600 : Math.min(next, quote + 2600));
    if (/^[a-z0-9-]+$/.test(name)) {
      const icon = chunk.match(/domain-([a-z-]+)\./);
      const type = icon && TYPE_MAP[icon[1]];
      if (type) types.set(name, type);
    }
    idx = next;
  }
  return types;
}

async function main() {
  console.log('→ 拉取 IANA 数据…');
  const [tldText, rdap, whoisRaw, whoisExtraRaw] = await Promise.all([
    fetchText('https://data.iana.org/TLD/tlds-alpha-by-domain.txt'),
    fetchJson('https://data.iana.org/rdap/dns.json'),
    fs.readFile(path.join(ROOT, 'data', 'whois-servers.json'), 'utf8').catch(() => '{"servers":{}}'),
    fs.readFile(path.join(ROOT, 'data', 'whois-extra.json'), 'utf8').catch(() => '{"servers":{}}'),
  ]);
  const whoisServers = { ...(JSON.parse(whoisExtraRaw).servers || {}), ...(JSON.parse(whoisRaw).servers || {}) };

  const versionLine = ((tldText.match(/^#\s*Version\s+(\S+)/m) || [])[1] || '').replace(/[^a-z0-9]/gi, '');
  const names = [
    ...new Set(
      tldText
        .split(/\r?\n/)
        .map((l) => l.trim().toLowerCase())
        .filter((l) => l && !l.startsWith('#'))
        .map((l) => l.replace(/^\./, '')),
    ),
  ];
  console.log(`  ${names.length} 个后缀（版本 ${versionLine}）`);

  // RDAP 引导：tld -> [https 端点]
  const rdapMap = new Map();
  for (const service of rdap.services || []) {
    const labels = service[0] || [];
    const urls = (service[1] || []).filter((u) => /^https?:\/\//i.test(u));
    if (!labels.length || !urls.length) continue;
    const https = urls.filter((u) => u.startsWith('https://'));
    const base = (https[0] || urls[0]).replace(/\/+$/, '') + '/';
    for (const label of labels) rdapMap.set(String(label).toLowerCase(), [base]);
  }
  for (const [tld, urls] of Object.entries(EXTRA_RDAP)) rdapMap.set(tld, urls);

  console.log('→ 拉取 IANA 根域库（类型）…');
  const rootHtml = await cachedText('rootdb.html', 'https://www.iana.org/domains/root/db');
  const types = parseRootDb(rootHtml);
  const typed = names.filter((n) => types.has(n)).length;
  console.log(`  ${typed}/${names.length} 个后缀识别出类型`);

  const tlds = [];
  for (const name of names) {
    const isIdn = name.startsWith('xn--');
    let unicode = '';
    if (isIdn) {
      try {
        unicode = domainToUnicode(name);
      } catch {}
      if (!unicode || unicode === name) unicode = '';
    }
    const display = unicode || name;
    const entry = { n: name };
    if (unicode) entry.u = unicode;
    if (isIdn) entry.x = 1;
    entry.t = types.get(name) || (isIdn ? 'cc' : 'g');
    entry.l = [...display].length;
    const rdapUrls = rdapMap.get(name);
    if (rdapUrls) entry.r = rdapUrls;
    const whois = whoisServers[name];
    if (whois && /^[a-z0-9.-]+$/.test(whois)) entry.w = whois;
    if (TYPES_RESTRICTED.has(entry.t) || RESTRICTED_TLDS.has(name)) entry.o = 0;
    if (POPULAR.has(name)) entry.p = 1;
    tlds.push(entry);
  }

  tlds.sort((a, b) => a.n.localeCompare(b.n));

  const ascii = tlds.filter((t) => !t.x);
  const byLength = {};
  for (const t of ascii) byLength[t.l] = (byLength[t.l] || 0) + 1;
  const counts = {
    total: tlds.length,
    ascii: ascii.length,
    idn: tlds.length - ascii.length,
    len1: byLength[1] || 0,
    len2: byLength[2] || 0,
    len3: byLength[3] || 0,
    len4: ascii.filter((t) => t.l >= 4).length,
    rdap: tlds.filter((t) => t.r).length,
    whois: tlds.filter((t) => t.w).length,
    dnsOnly: tlds.filter((t) => !t.r && !t.w).length,
    restricted: tlds.filter((t) => t.o === 0).length,
    popular: tlds.filter((t) => t.p).length,
  };

  const payload = {
    _meta: {
      version: versionLine,
      generatedAt: new Date().toISOString(),
      sources: {
        tlds: 'https://data.iana.org/TLD/tlds-alpha-by-domain.txt',
        rdap: 'https://data.iana.org/rdap/dns.json',
        whois: 'whois.iana.org',
        types: 'https://www.iana.org/domains/root/db',
      },
      counts,
    },
    tlds,
  };

  await fs.mkdir(path.dirname(OUT), { recursive: true });
  const json = JSON.stringify(payload);
  await fs.writeFile(OUT, json);
  console.log(`✓ ${OUT}`);
  console.log(`  ${(json.length / 1024).toFixed(1)} KB`, counts);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
