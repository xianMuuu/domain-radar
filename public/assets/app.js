/**
 * 域名雷达 · 前端
 * 零依赖，原生 ES Module。所有状态集中在一个 state 对象里，渲染函数只读状态。
 */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const fmt = new Intl.NumberFormat('zh-CN');
const nf = (n) => fmt.format(n);

const BATCH_SIZE = 10;
const CLIENT_WORKERS = 2;
const GEN_CAP = 60_000;
const CONFIRM_THRESHOLD = 3000;
const GRID = { gap: 8, rowH: 44, minW: 148, pad: 12 };

const STATUS_TEXT = {
  available: '可注册',
  registered: '已注册',
  unknown: '待定',
  invalid: '无效',
};

const LETTERS = 'abcdefghijklmnopqrstuvwxyz';
const DIGITS = '0123456789';

const state = {
  catalog: null,
  entries: [],
  byName: new Map(),
  selected: new Set(),
  group: 'all',
  query: '',
  onlyOpen: true,
  mode: 'pattern',
  gen: { len: 2, letter: true, digit: true, hyphen: false, noLeading: true },
  genNames: [],
  genTruncated: false,
  pattern: 'NL',
  patternNames: [],
  patternTruncated: false,
  results: [],
  filter: 'all',
  resultQuery: '',
  cols: 1,
  tileW: GRID.minW,
  currentList: [],
  gridCols: 0,
  rendered: [],
  running: false,
  paused: false,
  runId: 0,
  queue: [],
  inFlight: 0,
  done: 0,
  total: 0,
  startedAt: 0,
  finishedAt: 0,
  confirmedBig: false,
  cache: new Map(),
  renderScheduled: false,
};

/* ------------------------------- 工具函数 ------------------------------- */

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 2200);
}

function cleanToken(raw) {
  let s = String(raw || '').trim().toLowerCase();
  if (!s || s.startsWith('#')) return '';
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  s = s.split(/[/?#]/)[0];
  s = s.replace(/^\.+/, '').replace(/\.+$/, '');
  if (!s || /\s/.test(s)) return '';
  try {
    const host = new URL(`http://${s}`).hostname;
    return host.replace(/\.$/, '');
  } catch {
    return '';
  }
}

function isValidDomain(domain) {
  if (!domain || domain.length > 253) return false;
  const labels = domain.split('.');
  if (labels.length < 2) return false;
  return labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}

function tldLabel(entry) {
  return '.' + (entry.u || entry.n);
}

/* ------------------------------- 目录加载 ------------------------------- */

async function loadCatalog() {
  const res = await fetch('/data/tlds.json', { cache: 'force-cache' });
  if (!res.ok) throw new Error('后缀目录加载失败');
  const data = await res.json();
  state.catalog = data;
  state.entries = data.tlds;
  state.byName = new Map(data.tlds.map((t) => [t.n, t]));
  return data;
}

function visibleEntries() {
  const q = state.query.trim().toLowerCase().replace(/^\./, '');
  return state.entries.filter((t) => {
    if (state.onlyOpen && t.o === 0) return false;
    if (state.group === '2' && (t.x || t.l !== 2)) return false;
    if (state.group === '3' && (t.x || t.l !== 3)) return false;
    if (state.group === '4' && (t.x || t.l < 4)) return false;
    if (state.group === 'idn' && !t.x) return false;
    if (state.group === 'hot' && !t.p) return false;
    if (q) {
      const hay = `${t.n} ${t.u || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

/* --------------------------------- 渲染 --------------------------------- */

function paintGroupCounts() {
  const c = state.catalog?._meta?.counts || {};
  const map = {
    all: c.total || 0,
    2: c.len2 || 0,
    3: c.len3 || 0,
    4: c.len4 || 0,
    idn: c.idn || 0,
    hot: c.popular || 0,
  };
  $$('.group-tab').forEach((btn) => {
    const em = $('em', btn);
    if (em) em.textContent = nf(map[btn.dataset.group] || 0);
  });
}

function paintTldList() {
  const list = $('#tld-list');
  const items = visibleEntries();
  if (!items.length) {
    const msg = state.query.trim()
      ? `没有匹配「${state.query.trim()}」的后缀`
      : '这个分组里没有可选后缀。';
    list.innerHTML = `<div class="picker-empty">${msg}</div>`;
    $('#picker-count').textContent = '0 个后缀';
    return;
  }

  const frag = document.createDocumentFragment();
  for (const t of items) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tld' + (state.selected.has(t.n) ? ' is-on' : '');
    btn.dataset.tld = t.n;
    btn.setAttribute('role', 'option');
    btn.setAttribute('aria-selected', state.selected.has(t.n) ? 'true' : 'false');
    btn.title = t.n + (t.o === 0 ? ' · 注册局限制公开注册' : '');
    btn.innerHTML = `<span class="box"></span><span class="name">${tldLabel(t)}</span>${t.o === 0 ? '<span class="flag">限</span>' : ''}`;
    frag.appendChild(btn);
  }
  list.replaceChildren(frag);
  $('#picker-count').textContent = `${nf(items.length)} 个后缀`;
}

function paintSelected() {
  const wrap = $('#selected-chips');
  const names = [...state.selected];
  const MAX = 16;
  wrap.replaceChildren();
  if (!names.length) {
    wrap.innerHTML = '<span class="sel-more">尚未选择后缀——从上方列表点选，或用快捷按钮。</span>';
    $('#selection-badge').textContent = '未选择后缀';
    return;
  }
  for (const n of names.slice(0, MAX)) {
    const t = state.byName.get(n);
    const chip = document.createElement('span');
    chip.className = 'sel-chip';
    chip.innerHTML = `${tldLabel(t || { n })}<button type="button" aria-label="移除 ${n}">×</button>`;
    $('button', chip).addEventListener('click', () => toggleTld(n));
    wrap.appendChild(chip);
  }
  if (names.length > MAX) {
    const more = document.createElement('span');
    more.className = 'sel-more';
    more.textContent = `+ ${nf(names.length - MAX)} 个`;
    wrap.appendChild(more);
  }
  $('#selection-badge').textContent = `已选 ${nf(names.length)} 个后缀`;
}

/* ------------------------------- 名称计划 ------------------------------- */

function manualTokens() {
  return $('#names-input')
    .value.split(/[\n,，；\s]+/)
    .map(cleanToken)
    .filter(Boolean);
}

function generateNames() {
  const g = state.gen;
  let chars = '';
  if (g.letter) chars += 'abcdefghijklmnopqrstuvwxyz';
  if (g.digit) chars += '0123456789';
  if (g.hyphen) chars += '-';
  if (!chars) return { names: [], truncated: false };

  const out = [];
  let truncated = false;
  const L = g.len;

  const walk = (prefix) => {
    if (truncated) return;
    if (prefix.length === L) {
      out.push(prefix);
      if (out.length >= GEN_CAP) truncated = true;
      return;
    }
    for (const ch of chars) {
      if (!prefix.length) {
        if (g.noLeading && /[0-9-]/.test(ch)) continue;
      }
      if (ch === '-' && prefix.length === L - 1) continue; // 不能以连字符结尾
      walk(prefix + ch);
      if (truncated) return;
    }
  };
  if (L === 1 && g.hyphen) {
    // 单字符连字符本身不合法。
  }
  walk('');
  return { names: out, truncated };
}

function ensureGenNames() {
  const { names, truncated } = generateNames();
  state.genNames = names;
  state.genTruncated = truncated;
  $('#gen-count').textContent = truncated ? `${nf(names.length)}+` : nf(names.length);
}

/**
 * 模式生成：L = 任意字母，N = 任意数字，W = 字母或数字，其他字符原样保留。
 * 例：NL 生成 3l、a7…（260 个）；L-L 生成 a-b 形式；abc 生成仅一个固定名称。
 */
function generatePattern() {
  const raw = ($('#pattern-input')?.value || '').trim();
  const out = [];
  let truncated = false;

  const walk = (i, prefix) => {
    if (truncated) return;
    if (i >= raw.length) {
      if (prefix.length && prefix.length <= 63) out.push(prefix);
      if (out.length >= GEN_CAP) truncated = true;
      return;
    }
    const ch = raw[i];
    const set = ch === 'L' ? LETTERS : ch === 'N' ? DIGITS : ch === 'W' ? LETTERS + DIGITS : null;
    if (!set) {
      walk(i + 1, prefix + ch);
      return;
    }
    for (const c of set) {
      // W 是字母或数字通配，才需要排除数字开头；显式 N 允许 3l 这种写法。
      if (!prefix.length && ch === 'W' && /[0-9-]/.test(c)) continue;
      walk(i + 1, prefix + c);
      if (truncated) return;
    }
  };

  if (raw) walk(0, '');
  return { names: [...new Set(out)], truncated };
}

function ensurePatternNames() {
  const { names, truncated } = generatePattern();
  state.patternNames = names;
  state.patternTruncated = truncated;
  $('#pattern-count').textContent = truncated ? `${nf(names.length)}+` : nf(names.length);
  $('#pattern-count').classList.toggle('is-warn', truncated);
}

function buildPlan() {
  const tlds = [...state.selected];
  const mode = state.mode;
  if (mode === 'gen') ensureGenNames();
  if (mode === 'pattern') ensurePatternNames();
  const tokens = mode === 'gen' ? state.genNames : mode === 'pattern' ? state.patternNames : manualTokens();
  if (!tokens.length) return { names: 0, domains: [], truncated: false, capped: false };

  const domains = [];
  const seen = new Set();
  let capped = false;
  const push = (d) => {
    if (seen.has(d)) return;
    if (domains.length >= 100_000) {
      capped = true;
      return;
    }
    seen.add(d);
    domains.push(d);
  };

  for (const token of tokens) {
    const lastDot = token.lastIndexOf('.');
    const isFull = lastDot > 0 && state.byName.has(token.slice(lastDot + 1)) && isValidDomain(token);
    if (isFull) push(token);
    else for (const tld of tlds) push(`${token}.${tld}`);
    if (capped) break;
  }
  return {
    names: tokens.length,
    domains,
    truncated: (mode === 'gen' && state.genTruncated) || (mode === 'pattern' && state.patternTruncated),
    capped,
  };
}

/* -------------------------------- 预估 -------------------------------- */

let estimateTimer = null;
function scheduleEstimate() {
  clearTimeout(estimateTimer);
  estimateTimer = setTimeout(updateEstimate, 120);
}

function etaText(total) {
  const seconds = Math.round(total / 8);
  if (seconds < 60) return `${Math.max(1, seconds)} 秒`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  return `${(minutes / 60).toFixed(1)} 小时`;
}

function updateEstimate() {
  const plan = buildPlan();
  const tldCount = state.selected.size;
  const total = plan.domains.length;
  $('#est-names').textContent = nf(plan.names);
  $('#est-tlds').textContent = nf(tldCount);
  $('#est-total').textContent = nf(total);
  $('#names-badge').textContent = `${nf(plan.names)} 个名称`;

  const btn = $('#run-btn');
  const warn = $('#run-warn');
  let sub = '选好名称与后缀后，点右侧开始扫描';
  let canRun = total > 0 && !state.running;

  if (!tldCount && !plan.truncated && !plan.capped) {
    sub = '还差一步：在下面「02 后缀范围」里选择后缀';
  }

  if (plan.truncated) {
    warn.hidden = false;
    warn.innerHTML = `名称组合超过 <b>${nf(GEN_CAP)}</b> 个上限，请缩短名称长度或减少字符集。`;
    canRun = false;
    sub = '名称组合过多，已暂停';
  } else if (plan.capped) {
    warn.hidden = false;
    warn.innerHTML = `域名组合超过 <b>100,000</b> 个上限，请减少后缀数量或缩短名称。`;
    canRun = false;
    sub = '域名组合过多，已暂停';
  } else if (total > 0) {
    sub = `预计约 ${etaText(total)} · 并发 ${CLIENT_WORKERS * BATCH_SIZE} 条通道 · 结果实时回填`;
    if (total > CONFIRM_THRESHOLD) {
      warn.hidden = false;
      warn.innerHTML = `本轮将查询 <b>${nf(total)}</b> 个域名，预计约 ${etaText(total)}。开始前会再向你确认一次，扫描中可以随时暂停或停止。`;
    } else {
      warn.hidden = true;
    }
  } else {
    warn.hidden = true;
  }
  if (state.running) canRun = false;
  btn.disabled = !canRun;
  $('#est-sub').textContent = sub;
}

/* --------------------------------- 选择 --------------------------------- */

function toggleTld(name) {
  if (state.selected.has(name)) state.selected.delete(name);
  else state.selected.add(name);
  state.confirmedBig = false;
  const btn = $(`.tld[data-tld="${CSS.escape(name)}"]`);
  if (btn) {
    btn.classList.toggle('is-on', state.selected.has(name));
    btn.setAttribute('aria-selected', state.selected.has(name) ? 'true' : 'false');
  }
  paintSelected();
  scheduleEstimate();
  persistSelection();
}

function setSelection(list) {
  state.selected = new Set(list.filter((n) => state.byName.has(n)));
  state.confirmedBig = false;
  paintTldList();
  paintSelected();
  scheduleEstimate();
  persistSelection();
}

function persistSelection() {
  try {
    const list = [...state.selected].slice(0, 400);
    localStorage.setItem('dotradar:selection', JSON.stringify(list));
  } catch {}
}

function restoreSelection() {
  try {
    const raw = localStorage.getItem('dotradar:selection');
    if (!raw) return false;
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return false;
    state.selected = new Set(list.filter((n) => state.byName.has(n)));
    return state.selected.size > 0;
  } catch {
    return false;
  }
}

/* -------------------------------- 快速查询 ------------------------------- */

async function quickCheck(input) {
  const raw = String(input || '').trim();
  if (!raw) return;
  const btn = $('#quick-btn');
  const box = $('#quick-result');
  btn.classList.add('is-loading');
  btn.disabled = true;
  box.hidden = true;

  try {
    const res = await fetch(`/api/check?domain=${encodeURIComponent(raw)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '查询失败');
    renderQuick(data.result);
    const url = new URL(location.href);
    url.searchParams.set('d', data.result.domain);
    history.replaceState(null, '', url);
  } catch (err) {
    box.hidden = false;
    box.innerHTML = `<div class="qr-error">查询失败：${escapeHtml(err.message)}</div>`;
  } finally {
    btn.classList.remove('is-loading');
    btn.disabled = false;
  }
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function renderQuick(r) {
  const box = $('#quick-result');
  box.hidden = false;
  const cls = r.status;
  const source = { rdap: 'RDAP 权威数据', whois: 'WHOIS 权威数据', dns: 'DNS 推断', none: '无响应', catalog: '目录校验' }[r.source] || r.source;
  const conf = r.confidence ? `${Math.round(r.confidence * 100)}% 置信` : '';
  const bits = [];
  if (r.info?.registrar) bits.push(`注册商 ${escapeHtml(r.info.registrar)}`);
  if (r.info?.created) bits.push(`注册于 ${escapeHtml(r.info.created.slice(0, 10))}`);
  if (r.info?.expires) bits.push(`到期 ${escapeHtml(r.info.expires.slice(0, 10))}`);
  if (r.reason) bits.push(escapeHtml(r.reason));

  box.innerHTML = `
    <div class="qr-top">
      <span class="qr-domain">${escapeHtml(r.domain)}</span>
      <span class="qr-status ${cls}">${STATUS_TEXT[cls] || cls}</span>
      <span class="qr-meta">${source}${conf ? ' · ' + conf : ''} · ${r.ms}ms${r.cached ? ' · 缓存' : ''}</span>
    </div>
    ${bits.length ? `<div class="qr-meta">${bits.join(' · ')}</div>` : ''}
    ${r.note ? `<div class="qr-note">${escapeHtml(r.note)}</div>` : ''}
    ${cls === 'available' ? `<div class="qr-meta">下一步：到任意注册商查询实时价格与保留状态。</div>` : ''}
  `;
}

/* --------------------------------- 扫描 --------------------------------- */

const STATUS_ORDER = { available: 0, unknown: 1, registered: 2, invalid: 3 };

function filteredResults() {
  const q = state.resultQuery.trim().toLowerCase();
  const arr = state.results.filter((r) => {
    if (state.filter !== 'all' && r.status !== state.filter) return false;
    if (q && !r.domain.includes(q)) return false;
    return true;
  });
  arr.sort((a, b) => {
    const d = (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9);
    if (d) return d;
    return a.domain < b.domain ? -1 : a.domain > b.domain ? 1 : 0;
  });
  return arr;
}

function scheduleResultsRender() {
  if (state.renderScheduled) return;
  state.renderScheduled = true;
  requestAnimationFrame(() => {
    state.renderScheduled = false;
    renderResults();
  });
}

/* 方格阵列：所有结果按状态排好，滚动时只渲染可视范围内的格子 */
function gridMetrics() {
  const wrap = $('#results-scroll');
  const inner = Math.max(120, wrap.clientWidth - GRID.pad * 2);
  const cols = Math.max(1, Math.floor((inner + GRID.gap) / (GRID.minW + GRID.gap)));
  const tileW = Math.max(90, Math.floor((inner - GRID.gap * (cols - 1)) / cols));
  return { cols, tileW };
}

let gridTick = 0;
function scheduleGridRender() {
  if (gridTick) return;
  gridTick = requestAnimationFrame(() => {
    gridTick = 0;
    renderGrid(state.currentList);
  });
}

function renderGrid(list) {
  const wrap = $('#results-scroll');
  const canvas = $('#results-canvas');
  const { cols, tileW } = gridMetrics();
  state.cols = cols;
  state.tileW = tileW;
  const rowH = GRID.rowH + GRID.gap;
  const rows = Math.max(1, Math.ceil(list.length / cols));
  canvas.style.height = `${Math.max(0, rows * rowH - GRID.gap + GRID.pad * 2)}px`;

  const top = Math.max(0, wrap.scrollTop - GRID.pad);
  const first = Math.max(0, Math.floor(top / rowH) - 2);
  const last = Math.min(rows - 1, Math.ceil((top + wrap.clientHeight) / rowH) + 1);

  const frag = document.createDocumentFragment();
  for (let row = first; row <= last; row++) {
    for (let col = 0; col < cols; col++) {
      const i = row * cols + col;
      if (i >= list.length) break;
      const r = list[i];
      const el = document.createElement('button');
      el.type = 'button';
      el.className = `tile is-${r.status}`;
      el.style.cssText = `left:${GRID.pad + col * (tileW + GRID.gap)}px;top:${GRID.pad + row * rowH}px;width:${tileW}px`;
      el.dataset.domain = r.domain;
      const src = r.source === 'none' ? '' : String(r.source).toUpperCase();
      el.innerHTML = `<span class="tile-name">${escapeHtml(r.domain)}</span>`;
      const tip = [`${r.domain} · ${STATUS_TEXT[r.status] || r.status}`, src, r.ms ? `${r.ms}ms` : '', detailText(r)]
        .filter(Boolean)
        .join(' · ');
      el.title = tip;
      frag.appendChild(el);
    }
  }
  canvas.replaceChildren(frag);
}

function renderResults() {
  const all = state.results;
  const counts = { available: 0, registered: 0, unknown: 0, invalid: 0 };
  let latency = 0;
  for (const r of all) {
    counts[r.status] = (counts[r.status] || 0) + 1;
    latency += r.ms || 0;
  }
  const list = filteredResults();
  state.currentList = list;

  $('#kpi-available').textContent = nf(counts.available);
  $('#kpi-registered').textContent = nf(counts.registered);
  $('#kpi-unknown').textContent = nf(counts.unknown);
  $('#kpi-latency').textContent = all.length ? `${Math.round(latency / all.length)}ms` : '—';
  const endedAt = state.finishedAt || Date.now();
  const elapsed = state.startedAt ? (endedAt - state.startedAt) / 1000 : 0;
  const cachedAll = all.length > 0 && all.every((r) => r.cached);
  $('#kpi-rate').textContent = !all.length
    ? '—'
    : elapsed > 0.2
      ? `${(all.length / elapsed).toFixed(1)}/s`
      : cachedAll
        ? '缓存'
        : '—';

  $$('.filter').forEach((f) => {
    const k = f.dataset.filter;
    $('em', f).textContent = nf(k === 'all' ? all.length : counts[k] || 0);
    f.classList.toggle('is-active', state.filter === k);
  });

  $('#progress-bar').style.width = state.total ? `${Math.min(100, (state.done / state.total) * 100)}%` : '0%';
  $('#results-badge').textContent = `${nf(state.done)} / ${nf(state.total)}`;
  $('#results-sub').textContent = state.running
    ? state.paused
      ? '已暂停 · 在途请求完成后停止'
      : `扫描中 · 已完成 ${nf(state.done)} 个，剩余 ${nf(Math.max(0, state.total - state.done))} 个`
    : state.done
      ? state.done < state.total
        ? `已停止 · 已完成 ${nf(state.done)} / ${nf(state.total)} · 用时 ${elapsed.toFixed(1)} 秒`
        : `扫描完成 · 共 ${nf(state.total)} 个域名 · 用时 ${elapsed.toFixed(1)} 秒`
      : '等待扫描…';

  const wrap = $('#results-scroll');
  const changed = state.gridCols !== undefined && state.gridCols !== gridMetrics().cols;
  if (changed) wrap.scrollTop = 0;
  state.gridCols = gridMetrics().cols;

  renderGrid(list);
  $('#results-empty').hidden = list.length > 0;
  $('#grid-count').textContent = `${nf(list.length)} 个域名${list.length !== all.length ? `（已过滤）` : ''}`;
  $('#results').hidden = false;
}

function detailText(r) {
  if (r.status === 'registered' && r.info) {
    const bits = [];
    if (r.info.registrar) bits.push(r.info.registrar);
    if (r.info.created) bits.push('注册于' + String(r.info.created).slice(0, 10));
    if (r.info.nameservers?.length) bits.push(r.info.nameservers[0]);
    if (bits.length) return bits.join(' · ');
  }
  return r.note || r.reason || '—';
}

/* -------------------------------- 执行区 -------------------------------- */

async function startRun() {
  if (state.running) return;
  const plan = buildPlan();
  if (!plan.domains.length) return;
  if (plan.capped) return toast('域名组合过多，请减少后缀或名称');
  if (plan.domains.length > CONFIRM_THRESHOLD) {
    const minutes = Math.ceil(plan.domains.length / 8 / 60);
    const ok = window.confirm(`即将查询 ${nf(plan.domains.length)} 个域名，预计约 ${minutes} 分钟。\n\n扫描过程中可随时暂停或停止。确定开始吗？`);
    if (!ok) return;
  }
  state.confirmedBig = false;
  state.runId++;
  const runId = state.runId;
  state.queue = plan.domains.slice();
  state.total = plan.domains.length;
  state.done = 0;
  state.results = [];
  state.running = true;
  state.paused = false;
  state.startedAt = Date.now();
  state.finishedAt = 0;
  state.currentList = [];
  state.gridCols = 0;
  $('#results-scroll').scrollTop = 0;

  $('#run-btn').disabled = true;
  $('#run-btn').querySelector('span:last-child').textContent = '扫描中…';
  $('#pause-btn').hidden = false;
  $('#pause-btn').textContent = '暂停';
  $('#stop-btn').hidden = false;
  $('#results').hidden = false;
  $('#results-sub').textContent = '准备中…';
  renderResults();
  scheduleResultsRender();

  for (let i = 0; i < CLIENT_WORKERS; i++) pump(runId);
}

async function pump(runId) {
  while (state.runId === runId && state.running && !state.paused && state.queue.length) {
    const chunk = state.queue.splice(0, BATCH_SIZE);
    const fresh = chunk.filter((d) => !state.cache.has(d));
    for (const d of chunk) {
      if (state.cache.has(d)) {
        state.results.push({ ...state.cache.get(d), cached: true });
        state.done++;
      }
    }
    if (!fresh.length) {
      scheduleResultsRender();
      continue;
    }

    state.inFlight++;
    try {
      const res = await fetch('/api/check', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ domains: fresh }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      for (const r of data.results || []) {
        state.results.push(r);
        state.done++;
        if (r.status === 'available' || r.status === 'registered') state.cache.set(r.domain, r);
      }
      // 服务端去重后可能少于请求数，补齐进度避免卡住
      state.done = Math.min(state.done, state.total);
    } catch (err) {
      if (err.name !== 'AbortError') {
        for (const d of fresh) {
          state.results.push({ domain: d, status: 'unknown', source: 'none', confidence: 0, ms: 0, note: '请求失败：' + err.message });
          state.done++;
        }
      }
    } finally {
      state.inFlight--;
      scheduleResultsRender();
    }
  }
  maybeFinish(runId);
}

function maybeFinish(runId) {
  if (state.runId !== runId) return;
  if (!state.queue.length && state.inFlight === 0 && state.running && !state.paused) {
    state.running = false;
    state.startedAt = state.startedAt || Date.now();
    state.finishedAt = Date.now();
    $('#run-btn').disabled = false;
    $('#run-btn').querySelector('span:last-child').textContent = '开始扫描';
    $('#pause-btn').hidden = true;
    $('#stop-btn').hidden = true;
    renderResults();
    updateEstimate();
    const ok = state.results.filter((r) => r.status === 'available').length;
    toast(`扫描完成：${nf(ok)} 个可注册`);
  }
}

function pauseRun() {
  if (!state.running) return;
  state.paused = !state.paused;
  $('#pause-btn').textContent = state.paused ? '继续' : '暂停';
  if (!state.paused) for (let i = 0; i < CLIENT_WORKERS; i++) pump(state.runId);
  renderResults();
}

function stopRun() {
  state.running = false;
  state.paused = false;
  state.queue = [];
  state.runId++;
  state.finishedAt = Date.now();
  $('#run-btn').disabled = false;
  $('#run-btn').querySelector('span:last-child').textContent = '开始扫描';
  $('#pause-btn').hidden = true;
  $('#stop-btn').hidden = true;
  renderResults();
  updateEstimate();
}

/* --------------------------------- 导出 --------------------------------- */

function download(name, text, type) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function exportCsv() {
  const rows = [['domain', 'status', 'source', 'confidence', 'latency_ms', 'registrar', 'created', 'expires', 'nameservers', 'note']];
  for (const r of filteredResults()) {
    rows.push([
      r.domain,
      r.status,
      r.source,
      r.confidence ?? '',
      r.ms ?? '',
      r.info?.registrar || '',
      r.info?.created || '',
      r.info?.expires || '',
      (r.info?.nameservers || []).join(' '),
      r.note || r.reason || '',
    ]);
  }
  const csv = '\ufeff' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
  download(`dotradar-${stamp()}.csv`, csv, 'text/csv;charset=utf-8');
  toast(`已导出 ${rows.length - 1} 条结果`);
}

function exportTxt() {
  const lines = filteredResults()
    .filter((r) => r.status === 'available')
    .map((r) => r.domain);
  if (!lines.length) return toast('当前没有可注册的域名');
  download(`dotradar-available-${stamp()}.txt`, lines.join('\n'), 'text/plain;charset=utf-8');
  toast(`已导出 ${lines.length} 个可注册域名`);
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}

async function copyAvailable() {
  const list = filteredResults().filter((r) => r.status === 'available').map((r) => r.domain);
  if (!list.length) return toast('当前没有可注册的域名');
  await copyText(list.join('\n'));
  toast(`已复制 ${list.length} 个可注册域名`);
}

/* --------------------------------- 事件 --------------------------------- */

function bindEvents() {
  // 分组切换
  $$('.group-tab').forEach((btn) =>
    btn.addEventListener('click', () => {
      $$('.group-tab').forEach((b) => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      state.group = btn.dataset.group;
      state.query = '';
      $('#tld-search').value = '';
      paintTldList();
    }),
  );

  // 后缀列表（事件委托）
  $('#tld-list').addEventListener('click', (e) => {
    const btn = e.target.closest('.tld');
    if (btn) toggleTld(btn.dataset.tld);
  });

  $('#tld-search').addEventListener('input', (e) => {
    state.query = e.target.value;
    paintTldList();
  });

  $('#only-open').addEventListener('change', (e) => {
    state.onlyOpen = e.target.checked;
    paintTldList();
  });

  $('#select-visible').addEventListener('click', () => {
    const items = visibleEntries();
    for (const t of items) state.selected.add(t.n);
    state.confirmedBig = false;
    paintTldList();
    paintSelected();
    updateEstimate();
    persistSelection();
    toast(`已选中 ${nf(items.length)} 个后缀`);
  });

  $('#clear-selection').addEventListener('click', () => setSelection([]));

  // 快捷
  $$('.preset').forEach((btn) =>
    btn.addEventListener('click', () => {
      const pick = (pred) => state.entries.filter(pred).map((t) => t.n);
      const open = (t) => t.o !== 0;
      const map = {
        hot: pick((t) => t.p && open(t)).slice(0, 20),
        len2: pick((t) => !t.x && t.l === 2 && open(t)),
        len3: pick((t) => !t.x && t.l === 3 && open(t)),
        'len3-plus': pick((t) => !t.x && (t.l === 2 || t.l === 3) && open(t)),
      };
      setSelection(map[btn.dataset.preset] || []);
      toast(`已选择 ${nf(state.selected.size)} 个后缀`);
    }),
  );

  // 模式
  $$('.mode-tab').forEach((btn) =>
    btn.addEventListener('click', () => {
      $$('.mode-tab').forEach((b) => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      state.mode = btn.dataset.mode;
      $('#pane-manual').hidden = state.mode !== 'manual';
      $('#pane-gen').hidden = state.mode !== 'gen';
      $('#pane-pattern').hidden = state.mode !== 'pattern';
      if (state.mode === 'gen') ensureGenNames();
      if (state.mode === 'pattern') ensurePatternNames();
      updateEstimate();
    }),
  );

  $('#names-input').addEventListener('input', scheduleEstimate);
  $('#pattern-input')?.addEventListener('input', () => {
    ensurePatternNames();
    scheduleEstimate();
  });

  $$('#gen-length button').forEach((btn) =>
    btn.addEventListener('click', () => {
      $$('#gen-length button').forEach((b) => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      state.gen.len = Number(btn.dataset.len);
      ensureGenNames();
      updateEstimate();
    }),
  );

  for (const [id, key] of [
    ['cs-letter', 'letter'],
    ['cs-digit', 'digit'],
    ['cs-hyphen', 'hyphen'],
    ['gen-no-leading', 'noLeading'],
  ]) {
    $('#' + id).addEventListener('change', (e) => {
      state.gen[key] = e.target.checked;
      ensureGenNames();
      updateEstimate();
    });
  }

  // 扫描控制
  $('#run-btn').addEventListener('click', startRun);
  $('#pause-btn').addEventListener('click', pauseRun);
  $('#stop-btn').addEventListener('click', stopRun);

  // 结果过滤
  $$('.filter').forEach((btn) =>
    btn.addEventListener('click', () => {
      state.filter = btn.dataset.filter;
      renderResults();
    }),
  );

  $('#result-search').addEventListener('input', (e) => {
    state.resultQuery = e.target.value;
    renderResults();
  });

  $('#results-scroll').addEventListener('scroll', scheduleGridRender, { passive: true });
  window.addEventListener('resize', scheduleResultsRender);

  $('#results-canvas').addEventListener('click', (e) => {
    const tile = e.target.closest('.tile');
    if (!tile) return;
    copyText(tile.dataset.domain).then(() => toast(`已复制 ${tile.dataset.domain}`));
  });

  $('#export-csv').addEventListener('click', exportCsv);
  $('#export-txt').addEventListener('click', exportTxt);
  $('#copy-btn').addEventListener('click', copyAvailable);

  // 快速查询
  $('#quick-form').addEventListener('submit', (e) => {
    e.preventDefault();
    quickCheck($('#quick-input').value);
  });

  // 键盘
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
      e.preventDefault();
      $('#quick-input').focus();
    }
  });
}

/* --------------------------------- 初始化 -------------------------------- */

function revealOnScroll() {
  const els = $$('.reveal');
  if (!('IntersectionObserver' in window)) {
    els.forEach((el) => el.classList.add('is-in'));
    return;
  }
  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-in');
          io.unobserve(entry.target);
        }
      }
    },
    { threshold: 0.12 },
  );
  els.forEach((el) => io.observe(el));
}

function paintMeta() {
  const c = state.catalog._meta.counts;
  $('#hero-total').textContent = nf(c.total);
  $('#nav-version').textContent = `${nf(c.total)} 个后缀 · IANA ${state.catalog._meta.version}`;
  $('#stat-total').textContent = nf(c.total);
  $('#stat-len2').textContent = nf(c.len2);
  $('#stat-len3').textContent = nf(c.len3);
  $('#stat-rdap').textContent = nf(c.rdap);
  $('#stat-whois').textContent = nf(c.whois);
  $('#cov-rdap').textContent = `覆盖 ${nf(c.rdap)} 个后缀`;
  $('#cov-whois').textContent = `覆盖 ${nf(c.whois)} 个后缀`;
  $('#cov-dns').textContent = `覆盖 ${nf(c.dnsOnly)} 个后缀`;
  $('#footer-meta').innerHTML = `IANA ${state.catalog._meta.version}<br>RDAP ${nf(c.rdap)} · WHOIS ${nf(c.whois)} · DNS ${nf(c.dnsOnly)}<br>构建于 ${new Date(state.catalog._meta.generatedAt).toLocaleDateString('zh-CN')}`;
}

async function init() {
  bindEvents();
  revealOnScroll();
  try {
    await loadCatalog();
  } catch (err) {
    $('#tld-list').innerHTML = `<div class="picker-empty">后缀目录加载失败：${escapeHtml(err.message)}<br>请刷新重试。</div>`;
    return;
  }
  paintMeta();
  paintGroupCounts();

  if (!restoreSelection()) {
    state.selected = new Set();
  }
  paintTldList();
  paintSelected();
  ensureGenNames();
  ensurePatternNames();
  updateEstimate();

  const q = new URLSearchParams(location.search).get('d');
  if (q) {
    $('#quick-input').value = q;
    quickCheck(q);
  }
}

init();
