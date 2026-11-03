/** RDAP 响应解析（纯函数）。 */

function vcardFn(entity) {
  const items = entity?.vcardArray?.[1];
  if (!Array.isArray(items)) return '';
  const fn = items.find((x) => Array.isArray(x) && x[0] === 'fn');
  const value = fn?.[3];
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * @param {object} json RDAP domain 对象
 * @param {string} [domain]
 */
export function parseRdap(json, domain = '') {
  if (!json || typeof json !== 'object') return null;
  if (json.errorCode === 404) return { available: true };

  const info = {
    registrar: '',
    created: '',
    expires: '',
    nameservers: [],
    statuses: [],
  };

  for (const event of json.events || []) {
    const action = String(event.eventAction || '').toLowerCase();
    if (action === 'registration') info.created = event.eventDate || info.created;
    else if (action === 'expiration') info.expires = event.eventDate || info.expires;
  }

  for (const entity of json.entities || []) {
    if (Array.isArray(entity.roles) && entity.roles.includes('registrar')) {
      info.registrar = vcardFn(entity) || info.registrar;
      if (info.registrar) break;
    }
  }

  info.nameservers = (json.nameservers || [])
    .map((ns) => ns.ldhName || ns.unicodeName || '')
    .filter(Boolean)
    .slice(0, 4);

  info.statuses = (json.status || []).filter((s) => typeof s === 'string').slice(0, 4);

  return {
    available: false,
    handle: json.handle || domain,
    info,
  };
}
