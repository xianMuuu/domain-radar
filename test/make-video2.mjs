import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';

const BUILD = path.resolve('test/video2');
const TTS_DIR = path.join(BUILD, 'tts');
const FRAMES = path.join(BUILD, 'frames');
const OUT = path.resolve('docs/video/dotradar-tour.mp4');
const FFMPEG = path.resolve('node_modules/@ffmpeg-installer/win32-x64/ffmpeg.exe');
const VOICE = 'zh-CN-XiaoxiaoNeural';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ script */
const SCENES = [
  {
    id: 'title', chip: '01 · 开场',
    lines: [
      ['s1a', '全世界一共有一千四百三十六个根域后缀，两位、三位、四位，一直到十几位。'],
      ['s1b', '想挑一个短名字，靠手动一个个查，基本查不过来。'],
      ['s1c', '所以我做了这个工具：域名雷达。'],
    ],
  },
  {
    id: 'names', chip: '02 · 名称规则',
    lines: [
      ['s2a', '第一步，先把名字定下来。默认是模式生成，输入 N、L，就是一个数字加一个字母。'],
      ['s2b', '右边立刻算出两百六十个名字；也能换成组合生成，或者直接粘贴自己的清单。'],
    ],
  },
  {
    id: 'tlds', chip: '03 · 后缀范围',
    lines: [
      ['s3a', '第二步，挑后缀。一千四百三十六个后缀按长度分成两位、三位、四位，还有国际化分组。'],
      ['s3b', '两位有二百四十八个，三位有二百一十六个，正是短域名里最值钱的两档。'],
      ['s3c', '支持搜索和多选，比如输入 nz；默认还会隐藏政府和教育这类不能公开注册的后缀。'],
    ],
  },
  {
    id: 'scan', chip: '04 · 开始扫描',
    lines: [
      ['s4a', '名字乘以后缀，就是这次要扫的数量，这里是两百六十个域名。'],
      ['s4b', '点开始扫描，前端分片并发请求，结果一边查一边回填，随时可以暂停或者停止。'],
    ],
  },
  {
    id: 'results', chip: '05 · 结果方格',
    lines: [
      ['s5a', '结果是方格阵列：绿色可注册，灰色已注册，黄色是暂时无法判定。'],
      ['s5b', '上千条也不卡，因为只渲染屏幕里看得到的格子。'],
      ['s5c', '可以按状态筛选、在结果里搜索，点一下方格就能复制域名。'],
      ['s5d', '也能一键复制所有可注册的，或者导出 CSV 和 TXT。'],
    ],
  },
  {
    id: 'lookup', chip: '06 · 单域名查询',
    lines: [
      ['s6a', '只想查一个域名，页面最下面就是单查入口。'],
      ['s6b', '输入完整域名回车，立刻给出结果，还会把查询写进链接，发给别人直接就能看到。'],
    ],
  },
  {
    id: 'signals', chip: '07 · 判定原理',
    lines: [
      ['s7a', '判定不是靠猜。先问注册局的 RDAP 接口，覆盖一千两百零四个后缀。'],
      ['s7b', '没有 RDAP 的，就走四十三端口的 WHOIS，直连注册局，再覆盖一百六十五个。'],
      ['s7c', '最后只剩六十七个后缀，才用 DNS 推断，并且明确标注低置信度。'],
      ['s7d', '每条结果都带来源和可信度，查不到就说查不到。'],
    ],
  },
  {
    id: 'arch', chip: '08 · 部署与开源',
    lines: [
      ['s8a', '整个站点是一个 Cloudflare Worker，加一份静态资源，没有数据库，也不需要登录。'],
      ['s8b', '免费额度就够用，部署只要一条 wrangler deploy。'],
      ['s8c', '代码用 MIT 协议开源，fork 之后改个名字，就能部署成你自己的。'],
    ],
  },
  {
    id: 'end', chip: '09 · 结尾',
    lines: [['s9a', '域名雷达，一千四百三十六个后缀，一次扫完。']],
  },
];

const ALL = SCENES.flatMap((s) => s.lines.map(([k, t]) => ({ key: k, text: t, scene: s.id })));
const CAPTION = {
  s1a: '全世界 1,436 个根域后缀，两位到十几位都有',
  s1b: '手动一个个查？基本查不过来',
  s1c: '所以我做了「域名雷达」',
  s2a: '第一步：先把名字定下来 — 模式生成 NL = 数字 + 字母',
  s2b: '260 个名字实时算出；也能组合生成或粘贴清单',
  s3a: '第二步：挑后缀 — 1,436 个按长度分成 2 / 3 / 4 位 / 国际化',
  s3b: '两位 248 个、三位 216 个，短域名最值钱的两档',
  s3c: '可搜索、可多选（例：nz）；默认隐藏 .gov / .edu 等受限后缀',
  s4a: '名称 × 后缀 = 本次要扫的域名数量',
  s4b: '开始扫描：分片并发、实时回填，可暂停 / 停止',
  s5a: '方格阵列：绿=可注册 · 灰=已注册 · 黄=待定',
  s5b: '虚拟滚动，上千条也不卡',
  s5c: '状态筛选 + 结果内搜索 + 点一下复制',
  s5d: '一键复制可注册 / 导出 CSV / TXT',
  s6a: '只想查一个？页面最下面是单查入口',
  s6b: '输入回车即查，结果写进链接可直接分享',
  s7a: 'RDAP 优先：覆盖 1,204 个后缀，404 即未注册',
  s7b: 'WHOIS 兜底：43 端口直连注册局，再覆盖 165 个',
  s7c: 'DNS 推断：仅剩 67 个后缀，明确标注低置信度',
  s7d: '每条结果都标来源与可信度，查不到就说查不到',
  s8a: '一个 Cloudflare Worker + 一份静态资源，零数据库、无登录',
  s8b: '免费额度够用，一条 wrangler deploy 上线',
  s8c: 'MIT 开源，fork 后改名即可部署成自己的',
  s9a: '域名雷达 · 1,436 个后缀，一次扫完',
};

/* --------------------------------------------------------------------- tts */
fs.mkdirSync(TTS_DIR, { recursive: true });
fs.mkdirSync(FRAMES, { recursive: true });

const manifestPath = path.join(TTS_DIR, 'manifest.json');
const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : {};

function wavDuration(file) {
  const size = fs.statSync(file).size;
  return (size - 44) / (24000 * 2);
}

for (const item of ALL) {
  const wav = path.join(TTS_DIR, `${item.key}.wav`);
  if (manifest[item.key] && fs.existsSync(wav)) continue;
  const dir = path.join(TTS_DIR, item.key);
  fs.mkdirSync(dir, { recursive: true });
  const tts = new MsEdgeTTS();
  await tts.setMetadata(VOICE, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
  await tts.toFile(dir, item.text);
  const mp3 = path.join(dir, 'audio.mp3');
  const res = spawnSync(FFMPEG, ['-y', '-loglevel', 'error', '-i', mp3, '-ar', '24000', '-ac', '1', '-c:a', 'pcm_s16le', wav], { stdio: 'inherit' });
  if (res.status !== 0) throw new Error(`wav convert failed: ${item.key}`);
  manifest[item.key] = wavDuration(wav);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  process.stdout.write(`tts ${item.key} ${manifest[item.key].toFixed(1)}s\n`);
}

/* ------------------------------------------------------------------ browser */
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  defaultViewport: { width: 1600, height: 900, deviceScaleFactor: 1 },
  args: ['--hide-scrollbars', '--force-device-scale-factor=1'],
});
await browser.defaultBrowserContext().overridePermissions('http://127.0.0.1:8787', ['clipboard-read', 'clipboard-write']);
const page = await browser.newPage();
await page.goto('http://127.0.0.1:8787/', { waitUntil: 'networkidle0' });
await page.waitForFunction(() => document.querySelectorAll('#tld-list .tld').length > 1000, { timeout: 30000 });

await page.addStyleTag({
  content: `
  #stage{position:fixed;inset:0;z-index:9000;display:none;background:
    radial-gradient(1100px 700px at 26% 18%,rgba(99,102,241,.30),transparent 70%),
    radial-gradient(900px 700px at 78% 84%,rgba(34,211,238,.18),transparent 70%),#04050a;
    opacity:0;transition:opacity .45s ease}
  #stage.on{display:block;opacity:1}
  #stage .grid-lines{position:absolute;inset:0;background-image:linear-gradient(rgba(255,255,255,.05) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.05) 1px,transparent 1px);background-size:72px 72px;mask-image:radial-gradient(ellipse at 45% 45%,#000 35%,transparent 75%)}
  #stage .inner{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:0 120px}
  .sc{display:none;width:100%;max-width:1500px}
  .sc.on{display:block}
  .brand{display:inline-flex;align-items:center;gap:14px;font-size:22px;letter-spacing:.18em;color:#9aa6bf;opacity:0;transform:translateY(14px);transition:.7s}
  .brand.on{opacity:1;transform:none}
  .brand .mark{width:14px;height:14px;border-radius:50%;background:#67e8f9;box-shadow:0 0 22px #67e8f9}
  .big{font-size:104px;line-height:1.16;font-weight:800;letter-spacing:-2px;color:#f2f5fb;margin-top:26px}
  .big .ln{display:block;opacity:0;transform:translateY(22px);transition:.8s cubic-bezier(.2,.8,.2,1)}
  .big .ln.on{opacity:1;transform:none}
  .big .accent{background:linear-gradient(100deg,#a5b4fc,#67e8f9 55%,#f0abfc);-webkit-background-clip:text;background-clip:text;color:transparent}
  .sub2{margin-top:22px;font-size:30px;color:#93a0b8;opacity:0;transform:translateY(14px);transition:.7s}
  .sub2.on{opacity:1;transform:none}
  .stats{display:flex;gap:90px;margin-top:56px}
  .statx b{display:block;font-size:64px;font-weight:800;letter-spacing:-1px;color:#e8ecf5}
  .statx span{font-size:20px;color:#7f8ba6;letter-spacing:.08em}
  .statx{opacity:0;transform:translateY(14px);transition:.6s}
  .statx.on{opacity:1;transform:none}
  .cards{display:grid;grid-template-columns:repeat(3,1fr);gap:26px;margin-top:34px}
  .cd{border:1px solid rgba(255,255,255,.12);background:linear-gradient(160deg,rgba(255,255,255,.055),rgba(255,255,255,.015));
      border-radius:22px;padding:34px 30px 32px;opacity:0;transform:translateY(26px);transition:.6s}
  .cd.on{opacity:1;transform:none}
  .cd.hot{border-color:rgba(103,232,249,.45);box-shadow:0 0 60px rgba(103,232,249,.12) inset}
  .cd b{font-size:34px;font-weight:800;color:#eef2fa}
  .cd .pct{display:inline-block;margin-top:10px;font:600 17px/1 ui-monospace,Consolas,monospace;color:#67e8f9;
    border:1px solid rgba(103,232,249,.3);border-radius:8px;padding:7px 10px;background:rgba(103,232,249,.07)}
  .cd p{margin-top:18px;font-size:21px;line-height:1.7;color:#9aa6bf}
  .h2{font-size:56px;font-weight:800;letter-spacing:-1px;color:#eef2fa}
  .h2sub{margin-top:14px;font-size:24px;color:#8d99b2}
  .arch{display:flex;align-items:center;gap:26px;margin-top:64px}
  .node{flex:1;border:1px solid rgba(255,255,255,.13);border-radius:20px;padding:26px 22px;text-align:center;
    background:rgba(255,255,255,.03);opacity:0;transform:translateY(20px);transition:.6s}
  .node.on{opacity:1;transform:none}
  .node b{display:block;font-size:26px;color:#eef2fa}
  .node span{display:block;margin-top:8px;font-size:17px;color:#8d99b2}
  .arrow{color:#4b5872;font-size:30px;opacity:0;transition:.5s}
  .arrow.on{opacity:1}
  .sig{display:grid;gap:12px;flex:1.1}
  .sig div{border:1px solid rgba(255,255,255,.1);border-radius:14px;padding:14px 18px;font-size:20px;color:#cfd6e6;
    background:rgba(255,255,255,.03);opacity:0;transform:translateX(16px);transition:.5s}
  .sig div.on{opacity:1;transform:none}
  .repo{margin-top:44px;display:flex;flex-direction:column;gap:16px;align-items:flex-start}
  .repo .row{display:flex;align-items:center;gap:14px;font:600 22px/1 ui-monospace,Consolas,monospace;color:#e5e9f5;
    border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.04);padding:16px 22px;border-radius:12px;
    opacity:0;transform:translateY(14px);transition:.55s}
  .repo .row.on{opacity:1;transform:none}
  .endwrap{text-align:center}
  .endwrap .et{font-size:88px;font-weight:800;letter-spacing:-2px;line-height:1.18;color:#f4f6fb}
  .endwrap .et em{font-style:normal;background:linear-gradient(100deg,#a5b4fc,#67e8f9 55%,#f0abfc);-webkit-background-clip:text;background-clip:text;color:transparent}
  .endwrap .eu{margin-top:30px;font:600 24px/1 ui-monospace,Consolas,monospace;color:#c7d2fe}
  .endwrap .eg{margin-top:14px;font:600 24px/1 ui-monospace,Consolas,monospace;color:#9fb4d8}
  #ptr{position:fixed;z-index:99998;width:64px;height:64px;border-radius:50%;border:2px solid #67e8f9;
    box-shadow:0 0 0 8px rgba(103,232,249,.14),0 0 34px rgba(103,232,249,.55);
    transform:translate(-50%,-50%) scale(.6);opacity:0;transition:left .5s cubic-bezier(.2,.8,.2,1),top .5s cubic-bezier(.2,.8,.2,1),opacity .25s,transform .25s;pointer-events:none}
  #ptr.on{opacity:1;transform:translate(-50%,-50%) scale(1)}
  #ptr::after{content:'';position:absolute;left:50%;top:50%;width:10px;height:10px;border-radius:50%;background:#67e8f9;
    transform:translate(-50%,-50%);box-shadow:0 0 14px #67e8f9}
  #ptip{position:fixed;z-index:99999;transform:translate(-50%,-190%);padding:9px 14px;border-radius:10px;
    background:rgba(9,12,20,.95);border:1px solid rgba(103,232,249,.35);color:#d7f6ff;font-size:19px;
    white-space:nowrap;opacity:0;transition:opacity .25s;pointer-events:none}
  #ptip.on{opacity:1}
  #sub{position:fixed;z-index:99997;left:50%;bottom:54px;transform:translateX(-50%) translateY(8px);max-width:1420px;
    display:flex;gap:16px;align-items:flex-start;padding:18px 28px;border-radius:16px;background:rgba(4,6,11,.86);
    border:1px solid rgba(255,255,255,.12);box-shadow:0 20px 70px rgba(0,0,0,.6);opacity:0;transition:opacity .25s,transform .25s}
  #sub.on{opacity:1;transform:translateX(-50%) translateY(0)}
  #sub .chip{flex:none;font:700 15px/26px ui-monospace,Consolas,monospace;letter-spacing:.06em;color:#081018;
    background:linear-gradient(120deg,#a5b4fc,#67e8f9);border-radius:8px;padding:0 10px;margin-top:3px}
  #sub .txt{font-size:33px;line-height:1.55;color:#f3f6fc;font-weight:650;letter-spacing:.3px}
  .dim .txt{color:#b9c2d6}
  `,
});

await page.evaluate(() => {
  const stage = document.createElement('div');
  stage.id = 'stage';
  stage.innerHTML = `
    <div class="grid-lines"></div>
    <div class="inner">
      <div class="sc" id="sc-title">
        <div class="brand"><span class="mark"></span>域名雷达 · DOTRADAR</div>
        <div class="big"><span class="ln">1,436 个后缀</span><span class="ln accent">一次扫完。</span></div>
        <div class="sub2">全球根域全量 · 方格阵列 · 注册局直连判定</div>
        <div class="stats">
          <div class="statx"><b data-to="1436">0</b><span>全球后缀</span></div>
          <div class="statx"><b data-to="248">0</b><span>两位后缀</span></div>
          <div class="statx"><b data-to="216">0</b><span>三位后缀</span></div>
          <div class="statx"><b data-to="1204">0</b><span>RDAP 直连</span></div>
        </div>
      </div>

      <div class="sc" id="sc-signals">
        <div class="h2">三种权威信号，一个诚实的结论</div>
        <div class="h2sub">RDAP → WHOIS → DNS，逐级兜底，结果标注来源与置信度</div>
        <div class="cards">
          <div class="cd" data-i="0"><b>RDAP</b><div class="pct">覆盖 1,204 个后缀</div>
            <p>注册局结构化接口。返回 404 即未注册，还能拿到注册商、注册时间、NS。</p></div>
          <div class="cd" data-i="1"><b>WHOIS</b><div class="pct">覆盖 165 个后缀</div>
            <p>43 端口直连注册局，补上 .nz .co .me .de .cn .ru 这些没有 RDAP 的国家后缀。</p></div>
          <div class="cd" data-i="2"><b>DNS 推断</b><div class="pct">仅剩 67 个后缀</div>
            <p>NXDOMAIN 只能说明「没有解析」，所以这类结果明确标注为低置信度。</p></div>
        </div>
      </div>

      <div class="sc" id="sc-arch">
        <div class="h2">一个 Worker，一份静态资源</div>
        <div class="h2sub">没有数据库、没有登录，免费额度就能跑</div>
        <div class="arch">
          <div class="node" data-i="0"><b>浏览器</b><span>原生 HTML / CSS / JS</span></div>
          <div class="arrow" data-i="1">→</div>
          <div class="node" data-i="2"><b>Cloudflare Worker</b><span>/api/check · 边缘缓存</span></div>
          <div class="arrow" data-i="3">→</div>
          <div class="sig">
            <div data-i="4">RDAP · 1,204 个后缀</div>
            <div data-i="5">WHOIS · 43 端口 · 165 个后缀</div>
            <div data-i="6">DoH DNS · 仅 67 个后缀</div>
          </div>
        </div>
        <div class="repo">
          <div class="row" data-i="7">github.com/xianMuuu/domain-radar</div>
          <div class="row" data-i="8">MIT License · 免费开源</div>
        </div>
      </div>

      <div class="sc" id="sc-end">
        <div class="endwrap">
          <div class="et">1,436 个后缀<br><em>一次扫完。</em></div>
          <div class="eu">domain-radar.1833179087.workers.dev</div>
          <div class="eg">github.com/xianMuuu/domain-radar</div>
        </div>
      </div>
    </div>`;
  document.body.appendChild(stage);

  const ptr = document.createElement('div');
  ptr.id = 'ptr';
  document.body.appendChild(ptr);
  const tip = document.createElement('div');
  tip.id = 'ptip';
  document.body.appendChild(tip);

  const sub = document.createElement('div');
  sub.id = 'sub';
  sub.innerHTML = '<span class="chip">01</span><div class="txt"></div>';
  document.body.appendChild(sub);
});

const client = await page.createCDPSession();
const frames = [];
let base = 0;
client.on('Page.screencastFrame', async (e) => {
  const i = frames.length;
  const name = `frames/f${String(i).padStart(5, '0')}.jpg`;
  fs.writeFileSync(path.join(BUILD, name), Buffer.from(e.data, 'base64'));
  if (!base) base = e.metadata.timestamp;
  frames.push({ name, t: e.metadata.timestamp - base });
  try { await client.send('Page.screencastFrameAck', { sessionId: e.sessionId }); } catch {}
});

const now = () => (frames.length ? frames[frames.length - 1].t : 0);
const marks = {};

const setChip = (chip) => page.evaluate((chip) => {
  document.querySelector('#sub .chip').textContent = chip;
}, chip);

const say = async (key) => {
  const s = ALL.find((x) => x.key === key);
  marks[key] = now();
  await page.evaluate((text, scene) => {
    const sub = document.querySelector('#sub');
    sub.querySelector('.txt').textContent = text;
    sub.classList.toggle('dim', scene === 'arch');
    sub.classList.add('on');
  }, CAPTION[key], s.scene);
  await sleep(manifest[key] * 1000 + 260);
};

const point = async (sel, label, dy = 0) => {
  const box = await page.evaluate((sel, dy) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 + dy };
  }, sel, dy);
  if (!box) return;
  await page.evaluate((b, label) => {
    const p = document.querySelector('#ptr');
    const t = document.querySelector('#ptip');
    p.style.left = `${b.x}px`;
    p.style.top = `${b.y}px`;
    p.classList.add('on');
    t.textContent = label;
    t.style.left = `${b.x}px`;
    t.style.top = `${b.y}px`;
    t.classList.add('on');
  }, box, label);
  await sleep(260);
};

const unpoint = () => page.evaluate(() => {
  document.querySelector('#ptr').classList.remove('on');
  document.querySelector('#ptip').classList.remove('on');
});

const jump = (sel, offset = 110) => page.evaluate((sel, offset) => {
  const el = document.querySelector(sel);
  if (!el) return;
  window.scrollTo(0, Math.max(0, el.getBoundingClientRect().top + scrollY - offset));
}, sel, offset);

const showStage = async (id) => {
  await page.evaluate((id) => {
    const st = document.querySelector('#stage');
    st.classList.add('on');
    document.querySelectorAll('.sc').forEach((s) => s.classList.toggle('on', s.id === id));
    st.dataset.cur = id;
  }, id);
  await sleep(420);
};

const hideStage = async () => {
  await page.evaluate(() => {
    document.querySelector('#stage').classList.remove('on');
    document.querySelectorAll('.sc').forEach((s) => s.classList.remove('on'));
  });
  await sleep(380);
};

const reveal = async (sel, delay = 0) => {
  await sleep(delay);
  await page.evaluate((sel) => {
    document.querySelectorAll(sel).forEach((el) => el.classList.add('on'));
  }, sel);
};

const countUp = async (ms = 1400) => {
  await page.evaluate((ms) => {
    const els = [...document.querySelectorAll('.statx b')];
    const t0 = performance.now();
    const tick = (t) => {
      const p = Math.min(1, (t - t0) / ms);
      const e = 1 - Math.pow(1 - p, 3);
      els.forEach((el) => {
        const to = Number(el.dataset.to);
        el.textContent = Math.round(to * e).toLocaleString('en-US');
      });
      if (p < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, ms);
};

const clickSel = (sel) => page.$eval(sel, (el) => el.click());

/* ---------------------------------------------------------------- recording */
await client.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 });
await sleep(900);

/* 01 title animation */
await setChip(SCENES[0].chip);
await showStage('sc-title');
await reveal('#sc-title .brand', 120);
await reveal('#sc-title .big .ln', 380);
await reveal('#sc-title .sub2', 300);
await reveal('#sc-title .statx', 260);
await countUp(1500);
await sleep(500);
await say('s1a');
await say('s1b');
await say('s1c');
await sleep(500);

/* 02 names */
await setChip(SCENES[1].chip);
await hideStage();
await page.evaluate(() => { document.querySelector('#clear-selection')?.click(); });
await jump('#names', 130);
await sleep(500);
await point('#pattern-input', '默认：模式生成 NL');
await say('s2a');
await clickSel('.mode-tab[data-mode="gen"]');
await unpoint();
await point('#gen-count', '组合生成：按长度 + 字符集');
await say('s2b');
await unpoint();
await clickSel('.mode-tab[data-mode="pattern"]');
await sleep(400);

/* 03 tlds */
await setChip(SCENES[2].chip);
await jump('#tlds', 100);
await sleep(500);
await clickSel('.group-tab[data-group="2"]');
await point('.group-tab[data-group="3"]', '按长度分组');
await say('s3a');
await unpoint();
await point('.group-tab[data-group="2"]', '两位：248 个');
await say('s3b');
await unpoint();
await setInputAsync('#tld-search', 'nz');
await sleep(500);
await point('.tld[data-tld="nz"]', '搜索 nz 并勾选');
await say('s3c');
await clickSel('.tld[data-tld="nz"]');
await sleep(450);
await setInputAsync('#tld-search', '');
await unpoint();
await sleep(300);
await point('#only-open', '默认隐藏受限后缀');
await sleep(1500);
await clickSel('#only-open');
await sleep(700);
await clickSel('#only-open');
await unpoint();
await sleep(300);

/* 04 scan */
await setChip(SCENES[3].chip);
await jump('.runbar', 300);
await sleep(600);
await point('#run-btn', '260 个域名，开始扫描');
await say('s4a');
await unpoint();
await clickSel('#run-btn');
await page.waitForSelector('#results-canvas .tile', { timeout: 20000 });
await point('#pause-btn', '可暂停 / 继续 / 停止');
await say('s4b');
await clickSel('#pause-btn');
await sleep(900);
await clickSel('#pause-btn');
await unpoint();
await page.waitForFunction(() => {
  const sub = document.querySelector('#results-sub');
  const badge = document.querySelector('#results-badge');
  return sub && /扫描完成/.test(sub.textContent) && badge && /^260 \/ 260/.test(badge.textContent.trim());
}, { timeout: 300000, polling: 400 });

/* 05 results */
await setChip(SCENES[4].chip);
await jump('#results', 100);
await sleep(600);
await say('s5a');
await page.evaluate(() => { document.querySelector('#results-scroll').scrollTop = 420; });
await sleep(900);
await point('#results-scroll', '只渲染可视区域');
await say('s5b');
await unpoint();
await page.evaluate(() => { document.querySelector('#results-scroll').scrollTop = 0; });
await clickSel('.filter[data-filter="available"]');
await sleep(700);
await point('.filter[data-filter="available"]', '只看可注册');
await say('s5c');
await unpoint();
const tile = await page.$('#results-canvas .tile.is-available');
if (tile) { await tile.click(); await sleep(400); }
await point('#copy-btn', '一键复制可注册 / 导出');
await say('s5d');
await clickSel('#copy-btn');
await sleep(700);
await point('#export-csv', 'CSV 带 BOM，Excel 直开');
await sleep(700);
await unpoint();
await clickSel('.filter[data-filter="all"]');
await sleep(500);

/* 06 lookup */
await setChip(SCENES[5].chip);
await jump('#lookup', 90);
await sleep(500);
await point('#quick-input', '输入完整域名');
await say('s6a');
await setInputAsync('#quick-input', '3l.nz');
await sleep(400);
await clickSel('#quick-btn');
await page.waitForFunction(() => {
  const el = document.querySelector('#quick-result');
  return el && !el.hidden && el.textContent.trim().length > 4;
}, { timeout: 30000 });
await unpoint();
await point('#quick-result', '结果 + 可分享链接');
await say('s6b');
await unpoint();
await sleep(300);

/* 07 signals */
await setChip(SCENES[6].chip);
await jump('#lookup', 90);
await showStage('sc-signals');
await reveal('#sc-signals .h2', 100);
await reveal('#sc-signals .h2sub', 220);
await sleep(300);
await reveal('#sc-signals .cd[data-i="0"]', 200);
await say('s7a');
await reveal('#sc-signals .cd[data-i="1"]', 120);
await say('s7b');
await reveal('#sc-signals .cd[data-i="2"]', 120);
await say('s7c');
await page.evaluate(() => { document.querySelector('#sc-signals .cd[data-i="1"]').classList.add('hot'); });
await say('s7d');

/* 08 arch */
await setChip(SCENES[7].chip);
await showStage('sc-arch');
await reveal('#sc-arch .h2', 100);
await reveal('#sc-arch .h2sub', 200);
await sleep(200);
await reveal('#sc-arch .node[data-i="0"]', 150);
await reveal('#sc-arch .arrow[data-i="1"]', 200);
await reveal('#sc-arch .node[data-i="2"]', 250);
await reveal('#sc-arch .arrow[data-i="3"]', 300);
await refreveal(150);
async function refreveal(d) {
  await sleep(d);
  await page.evaluate(() => { document.querySelectorAll('#sc-arch .sig div').forEach((el) => el.classList.add('on')); });
}
await say('s8a');
await reveal('#sc-arch .repo .row[data-i="7"]', 100);
await say('s8b');
await reveal('#sc-arch .repo .row[data-i="8"]', 100);
await say('s8c');
await sleep(400);

/* 09 end */
await setChip(SCENES[8].chip);
await showStage('sc-end');
await say('s9a');
await page.evaluate(() => { document.querySelector('#sub').classList.remove('on'); });
await sleep(2600);

await client.send('Page.stopScreencast');
await browser.close();

fs.writeFileSync(path.join(BUILD, 'meta.json'), JSON.stringify({ frames, marks }, null, 0));
console.log(`frames=${frames.length} raw=${now().toFixed(1)}s`);

/* ----------------------------------------------------------------- compose */
const FADE_IN = 0.6;
const FADE_OUT = 0.8;
const total = frames[frames.length - 1].t + 1.2;

const list = [];
for (let i = 0; i < frames.length; i += 1) {
  const cur = frames[i];
  const next = frames[i + 1];
  const d = Math.max((next ? next.t : cur.t + 1.0) - cur.t, 0.001);
  list.push(`file '${path.join(FRAMES, cur.name).replace(/\\/g, '/')}'`, `duration ${d.toFixed(4)}`);
}
list.push(`file '${path.join(FRAMES, frames[frames.length - 1].name).replace(/\\/g, '/')}'`);
fs.writeFileSync(path.join(BUILD, 'list.txt'), list.join('\n'));

/* mix narration into one 24k mono wav */
const RATE = 24000;
const mix = new Int16Array(Math.ceil(total * RATE) + RATE);
for (const item of ALL) {
  const wav = fs.readFileSync(path.join(TTS_DIR, `${item.key}.wav`));
  const pcm = new Int16Array(wav.buffer, wav.byteOffset + 44, (wav.length - 44) / 2);
  const off = Math.round((marks[item.key] || 0) * RATE);
  for (let i = 0; i < pcm.length; i += 1) {
    const idx = off + i;
    if (idx >= mix.length) break;
    const v = mix[idx] + pcm[i];
    mix[idx] = Math.max(-32768, Math.min(32767, v));
  }
}
const header = Buffer.alloc(44);
header.write('RIFF', 0);
header.writeUInt32LE(36 + mix.length * 2, 4);
header.write('WAVE', 8);
header.write('fmt ', 12);
header.writeUInt32LE(16, 16);
header.writeUInt16LE(1, 20);
header.writeUInt16LE(1, 22);
header.writeUInt32LE(RATE, 24);
header.writeUInt32LE(RATE * 2, 28);
header.writeUInt16LE(2, 32);
header.writeUInt16LE(16, 34);
header.write('data', 36);
header.writeUInt32LE(mix.length * 2, 40);
fs.writeFileSync(path.join(BUILD, 'mix.wav'), Buffer.concat([header, Buffer.from(mix.buffer)]));

const fadeOutStart = Math.max(0, total - FADE_OUT).toFixed(2);
const vf = `fade=t=in:st=0:d=${FADE_IN},fade=t=out:st=${fadeOutStart}:d=${FADE_OUT},scale=1920:1080,format=yuv420p`;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
const res = spawnSync(FFMPEG, [
  '-y', '-f', 'concat', '-safe', '0', '-i', path.join(BUILD, 'list.txt'),
  '-i', path.join(BUILD, 'mix.wav'),
  '-vf', vf, '-r', '30',
  '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
  '-c:a', 'aac', '-b:a', '160k', '-ar', '48000',
  '-movflags', '+faststart', '-shortest',
  OUT,
], { stdio: 'inherit' });
console.log('ffmpeg', res.status, OUT);

function setInputAsync(sel, value) {
  return page.$eval(sel, (el, v) => {
    el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}
