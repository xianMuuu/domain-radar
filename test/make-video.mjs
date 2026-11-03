import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'test/video';
const FRAMES = path.join(ROOT, 'frames');
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(FRAMES, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  defaultViewport: { width: 1600, height: 900, deviceScaleFactor: 1 },
  args: ['--hide-scrollbars', '--force-device-scale-factor=1'],
});
const page = await browser.newPage();
await page.goto('http://127.0.0.1:8787/', { waitUntil: 'networkidle0' });
await page.waitForFunction(() => document.querySelectorAll('#tld-list .tld').length > 1000, { timeout: 30000 });

await page.addStyleTag({
  content: `
  .cap{position:fixed;left:44px;bottom:40px;z-index:99999;display:flex;gap:13px;align-items:flex-start;
    padding:15px 22px 16px 18px;border-radius:15px;background:rgba(7,9,14,.9);
    border:1px solid rgba(255,255,255,.13);box-shadow:0 18px 60px rgba(0,0,0,.6);
    opacity:0;transform:translateY(10px);transition:opacity .3s ease,transform .3s ease;max-width:790px}
  .cap.on{opacity:1;transform:none}
  .cap-n{font:600 13px/24px ui-monospace,Consolas,monospace;color:#0b0d13;background:linear-gradient(120deg,#a5b4fc,#67e8f9);
    border-radius:7px;padding:0 8px;margin-top:2px}
  .cap-t b{display:block;font-size:25px;line-height:1.35;font-weight:750;color:#f4f6fb;letter-spacing:-.2px}
  .cap-t i{display:block;font-style:normal;margin-top:4px;font-size:15px;color:#9aa6bf;letter-spacing:.2px}
  .endcard{position:fixed;inset:0;z-index:999999;display:none;flex-direction:column;align-items:center;justify-content:center;
    background:radial-gradient(900px 600px at 28% 18%,rgba(99,102,241,.30),transparent 70%),
               radial-gradient(800px 620px at 76% 82%,rgba(34,211,238,.20),transparent 70%),#05060a;
    opacity:0;transition:opacity .5s ease}
  .endcard.on{display:flex;opacity:1}
  .endcard .card-title{font-size:76px;font-weight:800;letter-spacing:-1px;line-height:1.16;text-align:center}
  .endcard .card-title em{font-style:normal;background:linear-gradient(100deg,#a5b4fc,#67e8f9 55%,#f0abfc);
    -webkit-background-clip:text;background-clip:text;color:transparent}
  .endcard .tag{margin-top:16px;font-size:23px;color:#9aa6bf}
  .endcard .urls{margin-top:40px;display:flex;gap:22px;align-items:center}
  .endcard .u{font:600 20px/1 ui-monospace,Consolas,monospace;color:#e5e9f5;
    border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.045);padding:13px 18px;border-radius:11px}
  .endcard .badge{margin-top:30px;font-size:18px;color:#c7d2fe;border:1px solid rgba(255,255,255,.16);
    border-radius:999px;padding:8px 17px;background:rgba(255,255,255,.04)}
  `,
});

await page.evaluate(() => {
  const cap = document.createElement('div');
  cap.id = 'cap';
  cap.className = 'cap';
  cap.innerHTML = '<span class="cap-n">01</span><div class="cap-t"><b></b><i></i></div>';
  document.body.appendChild(cap);

  const ec = document.createElement('div');
  ec.id = 'endcard';
  ec.className = 'endcard';
  ec.innerHTML = `
    <div class="card-title">1,436 个后缀<br><em>一次扫完。</em></div>
    <div class="tag">域名雷达 DotRadar · 无登录 · 秒打开 · 免费开源</div>
    <div class="urls">
      <span class="u">domain-radar.1833179087.workers.dev</span>
      <span class="u">github.com/xianMuuu/domain-radar</span>
    </div>
    <div class="badge">开源 · MIT · Cloudflare Workers</div>`;
  document.body.appendChild(ec);
});

const client = await page.createCDPSession();
const frames = [];
let base = 0;
client.on('Page.screencastFrame', async (e) => {
  const i = frames.length;
  const name = `frames/f${String(i).padStart(5, '0')}.jpg`;
  fs.writeFileSync(path.join(ROOT, name), Buffer.from(e.data, 'base64'));
  if (!base) base = e.metadata.timestamp;
  frames.push({ name, t: e.metadata.timestamp - base });
  try { await client.send('Page.screencastFrameAck', { sessionId: e.sessionId }); } catch {}
});

const cap = (n, t, s) => page.evaluate((n, t, s) => {
  const c = document.querySelector('#cap');
  c.querySelector('.cap-n').textContent = n;
  c.querySelector('b').textContent = t;
  c.querySelector('i').textContent = s;
  c.classList.add('on');
}, n, t, s);

const jump = (sel, offset = 96) => page.evaluate((sel, offset) => {
  const el = document.querySelector(sel);
  if (!el) return;
  const y = el.getBoundingClientRect().top + scrollY - offset;
  window.scrollTo(0, Math.max(0, y));
}, sel, offset);

const clickSel = (sel) => page.$eval(sel, (el) => el.click());
const setInput = (sel, value) => page.$eval(sel, (el, v) => {
  el.value = v;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}, value);
const text = (sel) => page.$eval(sel, (el) => el.textContent.trim());

await client.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: 1600, maxHeight: 900, everyNthFrame: 1 });
await sleep(900);

// 01 hero
await cap('01', '全世界 1,436 个根域后缀', 'IANA 根域全量 · 自动同步版本');
await sleep(4200);

// 02 names
await jump('#names');
await sleep(700);
await cap('02', '先定名字', '模式生成 NL：一个数字 + 一个字母 = 260 个');
await sleep(3800);

// 03 suffixes
await jump('#tlds');
await sleep(700);
await cap('03', '再挑后缀', '1,436 个后缀按长度分组，可搜索、可多选');
await sleep(1200);
await clickSel('.group-tab[data-group="2"]');
await sleep(600);
await setInput('#tld-search', 'nz');
await sleep(700);
await clickSel('.tld[data-tld="nz"]');
await sleep(500);
await setInput('#tld-search', '');
await page.waitForFunction(() => document.querySelector('#est-tlds')?.textContent.trim() === '1', { timeout: 5000 });
await sleep(600);

// 04 estimate
await cap('04', '260 个名字 × 1 个后缀', '一次扫描 260 个域名，结果实时回填');
await jump('.runbar');
await sleep(1800);

// 05 scan
await clickSel('#run-btn');
const scanStart = frames.length ? frames[frames.length - 1].t : 0;
await page.waitForSelector('#results-canvas .tile', { timeout: 20000 });
await sleep(800);
await cap('05', '扫描中', 'RDAP 优先 · WHOIS 兜底 · 最后 DNS 推断');
await page.waitForFunction(() => {
  const sub = document.querySelector('#results-sub');
  const badge = document.querySelector('#results-badge');
  return sub && /扫描完成/.test(sub.textContent) && badge && /^260 \/ 260/.test(badge.textContent.trim());
}, { timeout: 300000, polling: 400 });
const scanEnd = frames.length ? frames[frames.length - 1].t : scanStart;
await sleep(900);

// 06 grid
await jump('#results');
await sleep(900);
await cap('06', '结果铺成方格', '绿 = 可注册 · 灰 = 已注册 · 黄 = 待定');
await sleep(2400);
await page.evaluate(() => { document.querySelector('#results-scroll').scrollTop = 320; });
await sleep(1100);
await page.evaluate(() => { document.querySelector('#results-scroll').scrollTop = 760; });
await sleep(900);

// 07 filter
await page.evaluate(() => { document.querySelector('#results-scroll').scrollTop = 0; });
await sleep(400);
await clickSel('.filter[data-filter="available"]');
await sleep(1100);
await cap('07', '一键筛出可注册', '上千条也不用一条条翻，只看能下手的');
await sleep(2400);

// 08 copy
const tile = await page.$('#results-canvas .tile.is-available');
if (tile) {
  await tile.click();
  await sleep(500);
  await cap('08', '点一下方格', '域名直接复制，拿去注册商粘贴');
  await sleep(2800);
}
await clickSel('.filter[data-filter="all"]');
await sleep(600);

// 09 quick lookup
await jump('#lookup');
await sleep(800);
await cap('09', '只想查一个？', '页面最下面，输入完整域名回车即查');
await setInput('#quick-input', '3l.nz');
await sleep(500);
await clickSel('#quick-btn');
await page.waitForFunction(() => {
  const el = document.querySelector('#quick-result');
  return el && !el.hidden && el.textContent.trim().length > 4;
}, { timeout: 30000 });
await sleep(4200);

// 10 coverage
await cap('10', '判定透明', '每条结果都标注来源与置信度，不猜');
await jump('#coverage');
await sleep(2600);

// 11 endcard
await page.evaluate(() => {
  document.querySelector('#cap').classList.remove('on');
  document.querySelector('#endcard').classList.add('on');
});
await sleep(5200);

await client.send('Page.stopScreencast');
await browser.close();

fs.writeFileSync(path.join(ROOT, 'meta.json'), JSON.stringify({ frames, scanStart, scanEnd }));
console.log(`frames=${frames.length} raw=${frames[frames.length - 1].t.toFixed(1)}s scan=${(scanEnd - scanStart).toFixed(1)}s`);
