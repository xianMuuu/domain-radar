/**
 * 端到端验收（开发用，不参与部署）：
 *   npm run e2e    需要本机 Chrome，且 dev server 已在 8787 运行。
 *   线上验收：$env:BASE='https://domain-radar.1833179087.workers.dev'; node test/e2e.mjs
 */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((p) => fs.existsSync(p));

const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;

function check(name, cond, extra = '') {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${extra ? ' — ' + extra : ''}`);
  }
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-first-run', '--disable-gpu', '--hide-scrollbars', '--window-size=1440,1000'],
  defaultViewport: { width: 1440, height: 1000, deviceScaleFactor: 1 },
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push('console: ' + m.text());
});

console.log('→ 打开首页');
await page.goto(BASE + '/', { waitUntil: 'networkidle0' });
await page.waitForFunction(() => document.querySelector('#stat-total')?.textContent === '1,436', { timeout: 15000 });

check('标题正确', (await page.title()).includes('域名雷达'));
check('统计条 1,436', (await page.$eval('#stat-total', (el) => el.textContent)) === '1,436');
check('WHOIS 覆盖显示 165', (await page.$eval('#stat-whois', (el) => el.textContent)) === '165');
check('目录列表已渲染', (await page.$$('.tld')).length > 1400, String((await page.$$('.tld')).length));

// 新的信息架构：名称规则在前，后缀范围其次，单域名查询在最后
console.log('→ 版式顺序');
const order = await page.$$eval('section[id]', (els) => els.map((e) => e.id));
check('顺序为 names → tlds → lookup', order.indexOf('names') < order.indexOf('tlds') && order.indexOf('tlds') < order.indexOf('lookup'), order.join(','));
check('默认模式为「模式生成」', await page.$eval('.mode-tab[data-mode="pattern"]', (el) => el.classList.contains('is-active')));
check('模式面板默认可见', await page.$eval('#pane-pattern', (el) => !el.hidden));
check('名称徽标显示 260', (await page.$eval('#names-badge', (el) => el.textContent)).includes('260'));

// 没有「1 位」分组
const groups = await page.$$eval('.group-tab', (els) => els.map((e) => e.dataset.group));
check('分组不含 1 位', !groups.includes('1'), groups.join(','));
check('分组含 2/3/4+/idn/hot', ['2', '3', '4', 'idn', 'hot'].every((g) => groups.includes(g)), groups.join(','));

// 单后缀批量扫描：abc.io
console.log('→ 批量扫描 abc.io');
await page.$eval('#pattern-input', (el) => {
  el.value = 'abc';
  el.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.waitForFunction(() => document.querySelector('#est-names')?.textContent === '1', { timeout: 8000 });
await page.click('.tld[data-tld="io"]');
await page.waitForFunction(() => document.querySelector('#est-total')?.textContent === '1', { timeout: 8000 });
check('预估 1 个域名', (await page.$eval('#est-total', (el) => el.textContent)) === '1');
check('后缀徽标显示 1 个', (await page.$eval('#selection-badge', (el) => el.textContent)).includes('1 个'));

await page.$eval('#run-btn', (el) => el.click());
await page.waitForSelector('#results .tile', { timeout: 30000 });
await page.waitForFunction(() => document.querySelector('#results-sub')?.textContent.includes('扫描完成'), { timeout: 30000 });
await sleep(300);
const tiles = await page.$$eval('#results-canvas .tile', (els) => els.map((e) => e.textContent));
check('结果以方格呈现', tiles.length === 1, tiles.join('|'));
check('方格含 abc.io', tiles[0].includes('abc.io'), tiles[0]);
check('KPI 已注册 = 1', (await page.$eval('#kpi-registered', (el) => el.textContent)) === '1');
check('方格计数已更新', (await page.$eval('#grid-count', (el) => el.textContent)).startsWith('1'), await page.$eval('#grid-count', (el) => el.textContent));

// 点击方格复制
await page.$eval('#results-canvas .tile', (el) => el.click());
await page.waitForFunction(() => document.querySelector('#toast')?.classList.contains('show'), { timeout: 5000 });
check('点击方格提示已复制', (await page.$eval('#toast', (el) => el.textContent)).includes('已复制'));

// 单域名查询
console.log('→ 单域名查询 google.com');
await page.$eval('#quick-input', (el) => {
  el.value = 'google.com';
  el.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.$eval('#quick-btn', (el) => el.click());
await page.waitForFunction(() => !document.querySelector('#quick-result').hidden, { timeout: 30000 });
await sleep(300);
const qr = await page.$eval('#quick-result', (el) => el.innerText);
check('google.com 已注册', qr.includes('已注册'), qr);
check('URL 带上 ?d=', page.url().includes('d=google.com'));

// 组合生成器
console.log('→ 组合生成器');
await page.$eval('.mode-tab[data-mode="gen"]', (el) => el.click());
await page.$eval('#gen-length button[data-len="1"]', (el) => el.click());
await page.waitForFunction(() => document.querySelector('#gen-count')?.textContent === '26', { timeout: 5000 });
check('1 位字母生成 26 个', (await page.$eval('#gen-count', (el) => el.textContent)) === '26');

// 分组切换
console.log('→ 分组切换');
await page.$eval('.group-tab[data-group="2"]', (el) => el.click());
await sleep(250);
const count2 = await page.$eval('#picker-count', (el) => el.textContent);
check('2 位分组 248 个', count2.startsWith('248'), count2);

// 模式生成器：NL = 数字 + 字母
console.log('→ 模式生成器');
await page.$eval('.mode-tab[data-mode="pattern"]', (el) => el.click());
await page.$eval('#pattern-input', (el) => {
  el.value = 'NL';
  el.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.waitForFunction(() => document.querySelector('#pattern-count')?.textContent === '260', { timeout: 5000 });
check('模式 NL 生成 260 个', (await page.$eval('#pattern-count', (el) => el.textContent)) === '260');

check('无 JS 报错', errors.length === 0, errors.join(' | '));

await browser.close();
console.log(failures ? `\n✗ ${failures} 项未通过` : '\n✓ 全部通过');
process.exit(failures ? 1 : 0);
