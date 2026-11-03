import puppeteer from 'puppeteer-core';

const BASE = process.env.BASE || 'https://domain-radar.1833179087.workers.dev';
const names = ['y2', 'u6', 'n4', 's8', 'f5', 'j7', 'o3', 'g6', 'i8', 'l4', 'q9', 'v2', 'z7', 'h5', 't3', 'w8', 'r6', 'm2', 'p7', 'k4'];

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--disable-gpu'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 1000 });
await page.goto(BASE + '/', { waitUntil: 'networkidle0' });

// 开局只保留两个后缀：.io 与 .com
await page.$eval('#tld-search', (el) => {
  el.value = 'io';
  el.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.$eval('.tld[data-tld="io"]', (el) => el.click());
await page.$eval('#tld-search', (el) => {
  el.value = 'com';
  el.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.$eval('.tld[data-tld="com"]', (el) => el.click());

// 取消默认的 .nz
await page.$eval('#tld-search', (el) => {
  el.value = 'nz';
  el.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.$eval('.tld[data-tld="nz"]', (el) => el.click());

// 清空搜索，输入名称
await page.$eval('#tld-search', (el) => {
  el.value = '';
  el.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.click('#names-input');
await page.type('#names-input', names.join('\n'));
await page.waitForFunction(() => document.querySelector('#est-total')?.textContent.replace(/,/g, '') === '40', { timeout: 8000 });

const started = Date.now();
await page.click('#run-btn');
await page.waitForFunction(() => document.querySelector('#results-sub')?.textContent.includes('扫描完成'), { timeout: 240000 });
const seconds = (Date.now() - started) / 1000;
const summary = await page.$eval('#results-sub', (el) => el.textContent);
const kpi = await page.$eval('#kpi-rate', (el) => el.textContent);
const rows = await page.$$eval('#results-body tr', (els) => els.length);
console.log(JSON.stringify({ seconds: +seconds.toFixed(1), summary, kpi, rows }, null, 2));
await browser.close();
