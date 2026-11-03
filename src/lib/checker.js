/**
 * 域名可用性检查核心（与运行环境无关）。
 *
 * 判定优先级：RDAP（权威） → WHOIS over TCP（权威） → DNS NS（推断，低置信度）
 * 所有网络能力通过注入的 io 适配器提供，Worker 与本地 Node 共用同一套逻辑。
 */
import { parseWhois, buildWhoisQuery } from './whois.js';
import { parseRdap } from './rdap.js';

export const SOURCE_LABEL = {
  rdap: 'RDAP',
  whois: 'WHOIS',
  dns: 'DNS 推断',
};

const HOST_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** 把用户输入规范成 punycode 小写域名；失败返回 { error }。 */
export function normalizeDomain(raw) {
  if (typeof raw !== 'string') return { error: '不是有效的域名' };
  let s = raw.trim().toLowerCase();
  if (!s) return { error: '空输入' };
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  s = s.split(/[/?#]/)[0];
  s = s.replace(/^\.+/, '').replace(/\.+$/, '');
  if (!s) return { error: '空输入' };
  if (/\s/.test(s)) return { error: '包含空格' };

  let ascii = s;
  try {
    // URL 解析同时完成 IDN → punycode 的转换。
    const host = new URL(`http://${s}`).hostname;
    if (host) ascii = host.replace(/\.$/, '');
  } catch {
    return { error: '域名格式不正确' };
  }
  if (/[^\x00-\x7f]/.test(ascii)) return { error: '国际化域名转换失败' };

  const labels = ascii.split('.');
  if (labels.length < 2) return { error: '至少需要一个后缀' };
  if (ascii.length > 253) return { error: '域名过长' };
  for (const label of labels) {
    if (!label || label.length > 63) return { error: '标签长度不合法' };
    if (!HOST_RE.test(label)) return { error: '包含非法字符' };
  }
  const tld = labels[labels.length - 1];
  return { domain: ascii, label: labels.slice(0, -1).join('.'), tld };
}

function ok(domain, status, source, confidence, extra = {}) {
  return { domain, status, source, confidence, ...extra };
}

/**
 * @param {string} domain 已规范化的域名
 * @param {object|undefined} entry 后缀目录条目
 * @param {{rdap:(url:string)=>Promise<{status:number,json:any}>, whois:(host:string,query:string)=>Promise<string>, dns:(name:string)=>Promise<{nxdomain:boolean,hasNs:boolean}>}} io
 */
export async function checkOne(domain, entry, io, { timeoutMs = 7000 } = {}) {
  const started = Date.now();
  const elapsed = () => Date.now() - started;

  if (!entry) {
    return ok(domain, 'invalid', 'catalog', 1, { reason: '后缀不在 IANA 全球根域列表中', ms: elapsed() });
  }

  const failures = [];
  let rdapFailed = false;

  // ① RDAP：权威、结构化，404 即「未注册」。
  if (Array.isArray(entry.r)) {
    rdapFailed = true;
    for (const base of entry.r.slice(0, 2)) {
      const url = `${base}domain/${domain}`;
      try {
        const res = await io.rdap(url, timeoutMs);
        const status = Number(res?.status);
        if (status === 404) return ok(domain, 'available', 'rdap', 1, { ms: elapsed() });
        if (status === 200 && res.json) {
          const parsed = parseRdap(res.json, domain);
          if (parsed?.available) return ok(domain, 'available', 'rdap', 1, { ms: elapsed() });
          if (parsed) return ok(domain, 'registered', 'rdap', 1, { info: parsed.info, ms: elapsed() });
        }
        if (status === 429 || status >= 500) {
          failures.push(`RDAP ${status}`);
          continue;
        }
        failures.push(`RDAP ${status || '无响应'}`);
        break;
      } catch (err) {
        failures.push(`RDAP ${err?.name === 'AbortError' ? '超时' : '不可达'}`);
      }
    }
  }

  // ② WHOIS：覆盖没有 RDAP 的 ccTLD（.nz/.co/.me/.de/.cn/.ru …）。
  if (entry.w) {
    try {
      const text = await io.whois(entry.w, buildWhoisQuery(domain, entry.n), timeoutMs);
      const parsed = parseWhois(text, entry.n);
      if (parsed.status === 'available') return ok(domain, 'available', 'whois', 0.95, { ms: elapsed() });
      if (parsed.status === 'registered' && parsed.info) {
        return ok(domain, 'registered', 'whois', 0.95, { info: parsed.info, ms: elapsed() });
      }
      failures.push('WHOIS 无法判定');
    } catch (err) {
      failures.push(`WHOIS ${err?.name === 'AbortError' ? '超时' : '不可达'}`);
    }
  }

  // ③ DNS：只有 NXDOMAIN 能给出弱信号，且可能是「已注册但未配置 NS」。
  try {
    const res = await io.dns(domain, timeoutMs);
    if (res?.nxdomain) {
      if (rdapFailed) {
        return ok(domain, 'unknown', 'none', 0, {
          note: `注册局 RDAP 暂时不可用（${failures.join(' / ')}），DNS 无记录不足以判定`,
          ms: elapsed(),
        });
      }
      return ok(domain, 'available', 'dns', 0.45, {
        note: '未检测到 NS 记录，可能未注册，也可能已注册但未配置 DNS',
        ms: elapsed(),
      });
    }
    if (res?.hasNs) {
      return ok(domain, 'registered', 'dns', 0.7, {
        note: '检测到 NS 记录，域名已注册（DNS 推断）',
        ms: elapsed(),
      });
    }
    failures.push('DNS 无记录');
  } catch (err) {
    failures.push(`DNS ${err?.name === 'AbortError' ? '超时' : '不可达'}`);
  }

  return ok(domain, 'unknown', 'none', 0, { note: failures.join(' / ') || '所有数据源均无响应', ms: elapsed() });
}

/** 并发池，保持结果顺序。 */
export async function pool(items, worker, concurrency = 4) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * 批量检查。lookup(tld) 返回目录条目。
 * onProgress(index, result) 用于流式反馈（本地调试）。
 */
export async function checkBatch(domains, lookup, io, { concurrency = 4, onResult } = {}) {
  const started = Date.now();
  const unique = [...new Set(domains)];
  const results = await pool(
    unique,
    async (domain, index) => {
      const tld = domain.slice(domain.lastIndexOf('.') + 1);
      let result;
      try {
        result = await checkOne(domain, lookup(tld), io);
      } catch (err) {
        result = ok(domain, 'unknown', 'none', 0, { note: String(err?.message || err) });
      }
      onResult?.(index, result);
      return result;
    },
    concurrency,
  );
  const summary = { total: results.length, available: 0, registered: 0, unknown: 0, invalid: 0 };
  for (const r of results) {
    if (summary[r.status] !== undefined) summary[r.status]++;
  }
  return { results, summary, elapsed: Date.now() - started };
}
