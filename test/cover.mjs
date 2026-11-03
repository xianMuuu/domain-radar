import puppeteer from 'puppeteer-core';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const b = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  defaultViewport: { width: 1920, height: 1080, deviceScaleFactor: 1 },
});
const p = await b.newPage();
await p.goto(pathToFileURL(path.resolve('docs/cover.html')).href, { waitUntil: 'networkidle0' });
await new Promise((r) => setTimeout(r, 500));
await p.screenshot({ path: 'docs/bilibili-cover.png' });
await b.close();
console.log('ok');
