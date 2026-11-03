/**
 * 生成 WHOIS 服务器映射（仅针对没有 RDAP 的后缀）。
 *
 * 数据来源：whois.iana.org —— 对每个后缀查询 IANA 的 WHOIS 记录，
 * 取出其中的 "whois:" 主机名。IANA 是权威来源，且每个后缀只查一次。
 *
 * 输出：data/whois-servers.json
 *   { "_meta": {...}, "servers": { "nz": "whois.irs.net.nz", ... } }
 */
import net from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'data', 'whois-servers.json');

const CONCURRENCY = 5;
const TIMEOUT_MS = 9000;
const UA_HEADERS = { 'user-agent': 'dotradar-catalog-builder/1.0' };

function query(host, port, payload, timeout = TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    let data = '';
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      socket.destroy();
      err ? reject(err) : resolve(data);
    };
    socket.setTimeout(timeout, () => finish(new Error('timeout')));
    socket.on('connect', () => socket.write(payload));
    socket.on('data', (chunk) => {
      data += chunk.toString('utf8');
      if (data.length > 200_000) finish();
    });
    socket.on('end', () => finish());
    socket.on('error', (err) => finish(err));
  });
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: UA_HEADERS });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

async function fetchText(url) {
  const res = await fetch(url, { headers: UA_HEADERS });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.text();
}

export function parseIanaWhois(text) {
  // 注意：[ \t]* 而不是 \s*，否则空字段会把下一行的内容吞进来。
  const get = (key) => {
    const m = text.match(new RegExp(`^${key}:[ \\t]*(\\S.*)$`, 'im'));
    return m ? m[1].trim() : '';
  };
  return {
    whois: get('whois'),
    status: get('status'),
    organisation: get('organisation'),
  };
}

async function pool(items, worker, concurrency) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: concurrency }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

async function main() {
  console.log('→ 拉取 IANA 后缀列表与 RDAP 引导文件…');
  const [tldText, rdap] = await Promise.all([
    fetchText('https://data.iana.org/TLD/tlds-alpha-by-domain.txt'),
    fetchJson('https://data.iana.org/rdap/dns.json'),
  ]);

  const tlds = tldText
    .split(/\r?\n/)
    .map((l) => l.trim().toLowerCase())
    .filter((l) => l && !l.startsWith('#'));

  const rdapTlds = new Set();
  for (const [labels] of rdap.services) for (const t of labels) rdapTlds.add(t);

  // 已知的「未列入 IANA 引导、但确实提供 RDAP」的后缀（人工验证过）。
  const extraRdap = new Set(['io']);

  const targets = tlds.filter((t) => !rdapTlds.has(t) && !extraRdap.has(t));
  console.log(`→ 共 ${tlds.length} 个后缀；无 RDAP 的 ${targets.length} 个，逐个查询 IANA WHOIS…`);

  let done = 0;
  const servers = {};
  await pool(
    targets,
    async (tld) => {
      let entry = { whois: '', status: '', organisation: '' };
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const text = await query('whois.iana.org', 43, `${tld}\r\n`);
          entry = parseIanaWhois(text);
          break;
        } catch (err) {
          if (attempt === 1) console.warn(`  ! ${tld}: ${err.message}`);
        }
      }
      if (entry.whois && /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(entry.whois.toLowerCase())) {
        servers[tld] = entry.whois.toLowerCase();
      }
      done++;
      if (done % 20 === 0) process.stdout.write(`  ${done}/${targets.length}\n`);
    },
    CONCURRENCY,
  );

  const payload = {
    _meta: {
      source: 'whois.iana.org',
      generatedAt: new Date().toISOString(),
      totalTlds: tlds.length,
      queried: targets.length,
      withWhois: Object.keys(servers).length,
    },
    servers,
  };
  await fs.mkdir(path.dirname(OUT), { recursive: true });
  await fs.writeFile(OUT, JSON.stringify(payload, null, 2) + '\n');
  console.log(`✓ 写入 ${OUT}（${Object.keys(servers).length} 个 WHOIS 服务器）`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
