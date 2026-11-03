import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDomain, checkOne, checkBatch } from '../src/lib/checker.js';
import { parseWhois, buildWhoisQuery } from '../src/lib/whois.js';
import { parseRdap } from '../src/lib/rdap.js';

const catalog = {
  nz: { n: 'nz', w: 'whois.irs.net.nz', l: 2 },
  com: { n: 'com', r: ['https://rdap.example/com/'], l: 3 },
  de: { n: 'de', w: 'whois.denic.de', l: 2 },
  xyz: { n: 'xyz', l: 3 },
};

const lookup = (tld) => catalog[tld];

test('normalizeDomain 基本规范化', () => {
  assert.equal(normalizeDomain('Example.COM').domain, 'example.com');
  assert.equal(normalizeDomain('  https://Foo.co.nz/path?x=1 ').domain, 'foo.co.nz');
  assert.equal(normalizeDomain('3l.nz').domain, '3l.nz');
  assert.equal(normalizeDomain('3l.nz').tld, 'nz');
  assert.equal(normalizeDomain('例子.中国').domain, 'xn--fsqu00a.xn--fiqs8s');
});

test('normalizeDomain 拒绝非法输入', () => {
  assert.ok(normalizeDomain('').error);
  assert.ok(normalizeDomain('localhost').error);
  assert.ok(normalizeDomain('-bad.com').error);
  assert.ok(normalizeDomain('bad..com').error);
  assert.ok(normalizeDomain('a b.com').error);
});

test('normalizeDomain 支持多级后缀', () => {
  assert.deepEqual(normalizeDomain('foo.co.nz'), { domain: 'foo.co.nz', label: 'foo.co', tld: 'nz' });
});

test('WHOIS 解析：.nz 未注册', () => {
  const r = parseWhois('Not found: 3l.nz\n\n% Terms of Use\n% By submitting a WHOIS query...');
  assert.equal(r.status, 'available');
});

test('WHOIS 解析：.nz 已注册', () => {
  const r = parseWhois(
    'Domain Name: nzherald.co.nz\nRegistrar: Netregistry PTY Ltd\nCreation Date: 1997-04-16T12:00:00Z\nName Server: ns1.example.net\n',
  );
  assert.equal(r.status, 'registered');
  assert.equal(r.info.registrar, 'Netregistry PTY Ltd');
  assert.match(r.info.created, /1997-04-16/);
});

test('WHOIS 解析：DENIC 空闲与已注册', () => {
  assert.equal(parseWhois('Domain: zzqqxx99zz.de\nStatus: free\n').status, 'available');
  assert.equal(parseWhois('% Restricted rights.\nDomain: google.de\nStatus: connect\n').status, 'registered');
  assert.equal(buildWhoisQuery('google.de', 'de'), '-T dn google.de\r\n');
});

test('WHOIS 解析：常见注册局文案', () => {
  assert.equal(parseWhois('Domain not found.').status, 'available');
  assert.equal(parseWhois('The queried object does not exist: DOMAIN NOT FOUND').status, 'available');
  assert.equal(parseWhois('No matching record.').status, 'available');
  assert.equal(parseWhois('No entries found for the selected source(s).').status, 'available');
  assert.equal(parseWhois('Some unknown text').status, 'unknown');
});

test('RDAP 解析', () => {
  const registered = parseRdap({
    objectClassName: 'domain',
    handle: 'D1',
    status: ['client transfer prohibited'],
    events: [
      { eventAction: 'registration', eventDate: '2013-03-08T19:12:48Z' },
      { eventAction: 'expiration', eventDate: '2027-03-08T19:12:48Z' },
    ],
    entities: [{ roles: ['registrar'], vcardArray: ['vcard', [['fn', {}, 'text', 'MarkMonitor Inc.']]] }],
    nameservers: [{ ldhName: 'NS1.EXAMPLE.COM' }],
  });
  assert.equal(registered.available, false);
  assert.equal(registered.info.registrar, 'MarkMonitor Inc.');
  assert.equal(registered.info.nameservers[0], 'NS1.EXAMPLE.COM');
  assert.equal(parseRdap({ errorCode: 404 }).available, true);
});

test('checkOne：RDAP 404 判定可注册', async () => {
  const io = {
    rdap: async () => ({ status: 404 }),
    whois: async () => assert.fail('不应回退 WHOIS'),
    dns: async () => ({ nxdomain: true, hasNs: false }),
  };
  const r = await checkOne('foo.com', lookup('com'), io);
  assert.equal(r.status, 'available');
  assert.equal(r.source, 'rdap');
  assert.equal(r.confidence, 1);
});

test('checkOne：RDAP 200 判定已注册', async () => {
  const io = {
    rdap: async () => ({ status: 200, json: { objectClassName: 'domain', events: [] } }),
    whois: async () => '',
    dns: async () => ({ nxdomain: false, hasNs: true }),
  };
  const r = await checkOne('foo.com', lookup('com'), io);
  assert.equal(r.status, 'registered');
  assert.equal(r.source, 'rdap');
});

test('checkOne：RDAP 故障回退 WHOIS', async () => {
  const io = {
    rdap: async () => ({ status: 503 }),
    whois: async (host, query) => {
      assert.equal(host, 'whois.irs.net.nz');
      assert.equal(query, '3l.nz\r\n');
      return 'Not found: 3l.nz';
    },
    dns: async () => ({ nxdomain: true, hasNs: false }),
  };
  const r = await checkOne('3l.nz', lookup('nz'), io);
  assert.equal(r.status, 'available');
  assert.equal(r.source, 'whois');
});

test('checkOne：无权威源时 DNS 兜底并降低置信度', async () => {
  const io = {
    rdap: async () => assert.fail('无 RDAP'),
    whois: async () => assert.fail('无 WHOIS'),
    dns: async () => ({ nxdomain: true, hasNs: false }),
  };
  const r = await checkOne('foo.xyz', lookup('xyz'), io);
  assert.equal(r.status, 'available');
  assert.equal(r.source, 'dns');
  assert.ok(r.confidence < 0.5);
  assert.match(r.note, /未配置 DNS|未注册/);
});

test('checkOne：目录外的后缀判为 invalid', async () => {
  const io = { rdap: async () => ({}), whois: async () => '', dns: async () => ({}) };
  const r = await checkOne('foo.nope', lookup('nope'), io);
  assert.equal(r.status, 'invalid');
});

test('checkBatch 去重并统计', async () => {
  const io = {
    rdap: async () => ({ status: 404 }),
    whois: async () => '',
    dns: async () => ({ nxdomain: true, hasNs: false }),
  };
  const { results, summary } = await checkBatch(['a.com', 'a.com', 'b.com'], lookup, io, { concurrency: 2 });
  assert.equal(results.length, 2);
  assert.equal(summary.available, 2);
});
