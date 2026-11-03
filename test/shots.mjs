/** 视觉验收截图（开发用） */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find((p) => fs.existsSync(p));
const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-first-run', '--disable-gpu', '--hide-scrollbars'],
  defaultViewport: { width: 1440, height: 1000, deviceScaleFactor: 1 },
});
const page = await browser.newPage();
await page.goto(BASE + '/', { waitUntil: 'networkidle0' });
await page.waitForFunction(() => document.querySelector('#stat-total')?.textContent === '1,436');

const pick = async (tld) => {
  await page.$eval(`.tld[data-tld="${tld}"]`, (el) => el.click());
  await sleep(100);
};

// 首屏
await page.screenshot({ path: 'test/shot-top.png' });

// 造 6 条结果：3l / zzqqxx99zz × .io/.com/.de
await page.$eval('.mode-tab[data-mode="manual"]', (el) => el.click());
await page.$eval('#names-input', (el) => {
  el.value = '3l\nzzqqxx99zz';
  el.dispatchEvent(new Event('input', { bubbles: true }));
});
await sleep(300);
await page.screenshot({ path: 'test/shot-names.png' });

await pick('io');
await pick('com');
await pick('de');
await sleep(300);
await page.screenshot({ path: 'test/shot-tlds.png' });

await page.$eval('#run-btn', (el) => el.click());
await page.waitForFunction(() => document.querySelectorAll('#results-canvas .tile').length >= 6, { timeout: 60000 });
await page.waitForFunction(() => document.querySelector('#results-sub')?.textContent.includes('扫描完成'), { timeout: 60000 });
await sleep(600);
await page.evaluate(() => document.querySelector('#results').scrollIntoView({ block: 'start' }));
await sleep(400);
await page.screenshot({ path: 'test/shot-results.png' });

// 大网格：260 名称 × .io
await page.$eval('#results', (el) => { el.hidden = true; });
await page.$eval('.mode-tab[data-mode="pattern"]', (el) => el.click());
await page.$eval('#pattern-input', (el) => {
  el.value = 'NL';
  el.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.$eval('#clear-selection', (el) => el.click());
await pick('io');
await page.$eval('#run-btn', (el) => el.click());
await page.waitForFunction(() => document.querySelector('#results-sub')?.textContent.includes('扫描完成'), { timeout: 240000 });
await sleep(500);
await page.evaluate(() => document.querySelector('#results').scrollIntoView({ block: 'start' }));
await sleep(400);
await page.screenshot({ path: 'test/shot-grid.png' });

// 判定原理
await page.evaluate(() => document.querySelector('#coverage').scrollIntoView({ block: 'start' }));
await sleep(400);
await page.screenshot({ path: 'test/shot-coverage.png' });

// 单域名查询
await page.evaluate(() => document.querySelector('#lookup').scrollIntoView({ block: 'start' }));
await sleep(400);
await page.screenshot({ path: 'test/shot-lookup.png' });

// 移动端
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true });
await sleep(500);
await page.evaluate(() => window.scrollTo(0, 0));
await sleep(300);
await page.screenshot({ path: 'test/shot-mobile.png', fullPage: false });

await browser.close();
console.log('✓ 截图已写入 test/');
