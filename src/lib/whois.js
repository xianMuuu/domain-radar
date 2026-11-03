/**
 * WHOIS 文本查询与解析（纯函数，方便 Node 测试与 Worker 复用）。
 */

/** 不同注册局的查询格式差异。 */
export function buildWhoisQuery(domain, tld) {
  switch (tld) {
    case 'de':
      // DENIC 需要显式指定查询对象，否则只返回法律声明。
      return `-T dn ${domain}\r\n`;
    case 'jp':
      // JPRS 加 /e 返回英文记录，便于解析。
      return `${domain}/e\r\n`;
    default:
      return `${domain}\r\n`;
  }
}

/**
 * 判断 WHOIS 响应含义。
 * 返回 { status: 'available'|'registered'|'unknown', info, matched }
 */
export function parseWhois(text, tld = '') {
  if (!text || !text.trim()) return { status: 'unknown', info: null, matched: '' };

  const available = [
    /^[ \t]*not found/im,
    /^[ \t]*no match/im,
    /no matching record/i,
    /no entries found/i,
    /no data found/i,
    /no object found/i,
    /domain not found/i,
    /available domain:/i,
    /is available for registration/i,
    /the queried object does not exist/i,
    /status:[ \t]*free\b/i,
    /^%ERROR:101/im,
    /not registered/i,
    /is available/i,
  ];
  const registered = [
    /^domain name:/im,
    /^domain:/im,
    /^registrar:/im,
    /^registrant:/im,
    /^creation date/im,
    /^created:/im,
    /^registered on/im,
    /^nserver:/im,
    /^name server:/im,
    /^name servers:/im,
  ];

  const hitAvailable = available.find((re) => re.test(text));
  const hitRegistered = registered.find((re) => re.test(text));

  // 「Status: free」是 DENIC 的空闲标记，必须优先于 "Domain:" 行。
  if (/status:[ \t]*free\b/i.test(text)) {
    return { status: 'available', info: null, matched: 'Status: free' };
  }
  if (hitRegistered) {
    return { status: 'registered', info: extractInfo(text), matched: hitRegistered.source };
  }
  if (hitAvailable) {
    return { status: 'available', info: null, matched: hitAvailable.source };
  }
  return { status: 'unknown', info: null, matched: '' };
}

function firstLine(text, re) {
  const m = text.match(re);
  return m ? m[1].trim().replace(/\s+/g, ' ') : '';
}

function allLines(text, re, limit = 5) {
  const out = [];
  for (const m of text.matchAll(re)) {
    const v = m[1].trim().replace(/\.$/, '');
    if (v && !out.includes(v)) out.push(v);
    if (out.length >= limit) break;
  }
  return out;
}

export function extractInfo(text) {
  return {
    registrar: firstLine(text, /^[ \t]*registrar:[ \t]*(.+)$/im),
    created: firstLine(text, /^[ \t]*(?:creation date|created|registered on|registration time|created on):[ \t]*(.+)$/im),
    expires: firstLine(text, /^[ \t]*(?:registry expiry date|expiry date|expiration date|expires|paid-till|expire date):[ \t]*(.+)$/im),
    nameservers: allLines(text, /^[ \t]*(?:name servers?|nserver|ns):[ \t]*(\S+)/gim),
    statuses: allLines(text, /^[ \t]*(?:domain status|status):[ \t]*(\S+)/gim),
  };
}

/** 极简的 WHOIS 结果指纹，用于本地去重/调试。 */
export function whoisLooksTruncated(text) {
  return !text || text.length < 20;
}
