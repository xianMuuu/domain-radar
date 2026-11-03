/**
 * 为「既没有 RDAP、IANA 也没登记 WHOIS」的后缀探测真实可用的 WHOIS 服务器。
 *
 * 候选顺序：人工已知清单 → whois.nic.<tld> → whois.<tld>
 * 判定标准：能建立 TCP 连接、返回 >30 字符、且解析结果不是 unknown。
 *
 * 输出：data/whois-extra.json  { "_meta": {...}, "servers": { "vn": "whois.vnnic.vn" } }
 */
import net from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWhois } from '../src/lib/whois.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'data', 'whois-extra.json');

const KNOWN = {
  vn: 'whois.vnnic.vn',
  gr: 'whois.ics.forth.gr',
  za: 'whois.registry.net.za',
  ph: 'whois.dot.ph',
  al: 'whois.ak.net.al',
  mt: 'whois.nic.mt',
  cy: 'whois.nic.cy',
  tt: 'whois.nic.tt',
  pa: 'whois.nic.pa',
  lk: 'whois.nic.lk',
  np: 'whois.nic.np',
  bz: 'whois.nic.bz',
  eg: 'whois.nic.eg',
  py: 'whois.nic.py',
  gt: 'whois.nic.gt',
  sv: 'whois.nic.sv',
  ni: 'whois.nic.ni',
  jm: 'whois.nic.jm',
  kh: 'whois.nic.kh',
  mm: 'whois.nic.mm',
  bn: 'whois.bnnic.bn',
  bt: 'whois.nic.bt',
  mv: 'whois.nic.mv',
  ne: 'whois.nic.ne',
  tj: 'whois.nic.tj',
  tm: 'whois.nic.tm',
  uz: 'whois.uz',
  va: 'whois.nic.va',
  ps: 'whois.nic.ps',
  cu: 'whois.nic.cu',
  cw: 'whois.nic.cw',
  gm: 'whois.nic.gm',
  gw: 'whois.nic.gw',
  lr: 'whois.nic.lr',
  sl: 'whois.nic.sl',
  sz: 'whois.nic.sz',
  dj: 'whois.nic.dj',
  er: 'whois.nic.er',
  et: 'whois.nic.et',
  ga: 'whois.nic.ga',
  cg: 'whois.nic.cg',
  cd: 'whois.nic.cd',
  km: 'whois.nic.km',
  mg: 'whois.nic.mg',
  mu: 'whois.nic.mu',
  sc: 'whois.nic.sc',
  so: 'whois.nic.so',
  ss: 'whois.nic.ss',
  sd: 'whois.nic.sd',
  td: 'whois.nic.td',
  tg: 'whois.nic.tg',
  zm: 'whois.zicta.zm',
  zw: 'whois.zispa.co.zw',
};

const CONCURRENCY = 6;
const TIMEOUT = 7000;

function query(host, payload, timeout = TIMEOUT) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port: 43 });
    let text = '';
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      err ? reject(err) : resolve(text);
    };
    const timer = setTimeout(() => finish(new Error('timeout')), timeout);
    socket.on('connect', () => socket.write(payload));
    socket.on('data', (chunk) => {
      text += chunk.toString('utf8');
      if (text.length > 100_000) finish();
    });
    socket.on('end', () => finish());
    socket.on('error', (err) => finish(err));
  });
}

async function probe(tld) {
  const candidates = new Set();
  if (KNOWN[tld]) candidates.add(KNOWN[tld]);
  candidates.add(`whois.nic.${tld}`);
  candidates.add(`whois.${tld}`);

  for (const host of candidates) {
    try {
      const text = await query(host, `zzqqxx99zz-${Date.now().toString(36)}.${tld}\r\n`);
      if (text.trim().length < 30) continue;
      const parsed = parseWhois(text, tld);
      if (parsed.status === 'unknown') continue;
      return { host, sampleStatus: parsed.status, sample: text.slice(0, 160).replace(/\s+/g, ' ') };
    } catch {
      /* 尝试下一个候选 */
    }
  }
  return null;
}

const catalog = JSON.parse(await fs.readFile(path.join(ROOT, 'public', 'data', 'tlds.json'), 'utf8'));
const targets = catalog.tlds.filter((t) => !t.r && !t.w).map((t) => t.n);
console.log(`→ 待探测后缀 ${targets.length} 个（无 RDAP、无已知 WHOIS）`);

const servers = {};
const details = {};
let cursor = 0;
let done = 0;
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (cursor < targets.length) {
      const tld = targets[cursor++];
      const hit = await probe(tld);
      done++;
      if (hit) {
        servers[tld] = hit.host;
        details[tld] = { host: hit.host, sampleStatus: hit.sampleStatus, sample: hit.sample };
        console.log(`  ✓ .${tld} → ${hit.host} (${hit.sampleStatus})`);
      }
      if (done % 10 === 0) console.log(`  ${done}/${targets.length}`);
    }
  }),
);

await fs.writeFile(
  OUT,
  JSON.stringify({
    _meta: { generatedAt: new Date().toISOString(), probed: targets.length, found: Object.keys(servers).length },
    servers,
    details,
  }, null, 2) + '\n',
);
console.log(`✓ ${OUT}：${Object.keys(servers).length}/${targets.length} 个后缀找到 WHOIS`);
