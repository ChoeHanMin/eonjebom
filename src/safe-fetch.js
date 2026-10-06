// 사용자가 입력한 iCal 주소를 서버가 대신 가져올 때, 내부망 주소로 요청을 보내지 못하도록(SSRF) 막는다.
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const MAX_BYTES = 5 * 1024 * 1024;
const TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;

export function normalizeCalendarUrl(input) {
  let url;
  try {
    url = new URL(String(input).trim().replace(/^webcals?:\/\//i, 'https://'));
  } catch {
    throw new Error('주소 형식이 올바르지 않습니다.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('http(s) 또는 webcal 주소만 사용할 수 있습니다.');
  }
  if (url.username || url.password) throw new Error('주소에 계정 정보를 넣을 수 없습니다.');
  return url;
}

export function isPrivateAddress(ip) {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  const v6 = ip.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
  if (mapped) return isPrivateAddress(mapped[1]);
  return (
    v6 === '::' ||
    v6 === '::1' ||
    v6.startsWith('fc') ||
    v6.startsWith('fd') ||
    v6.startsWith('fe80') ||
    v6.startsWith('ff')
  );
}

async function assertPublicHost(hostname, lookup) {
  const host = hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (addresses.length === 0 || addresses.some((a) => isPrivateAddress(a.address))) {
    throw new Error('이 주소는 사용할 수 없습니다.');
  }
}

/**
 * 공개 인터넷의 캘린더 파일을 가져온다.
 * @param {string} input
 * @param {{fetch?: typeof fetch, lookup?: typeof dnsLookup}} [deps]
 */
export async function fetchCalendarText(input, deps = {}) {
  const doFetch = deps.fetch ?? fetch;
  const lookup = deps.lookup ?? dnsLookup;
  let url = normalizeCalendarUrl(input);

  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    await assertPublicHost(url.hostname, lookup);
    const res = await doFetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { Accept: 'text/calendar, */*' },
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      url = normalizeCalendarUrl(new URL(res.headers.get('location'), url).href);
      continue;
    }
    if (!res.ok) throw new Error(`캘린더 주소에서 데이터를 가져오지 못했습니다 (HTTP ${res.status}).`);
    return readLimited(res);
  }
  throw new Error('리디렉션이 너무 많습니다.');
}

async function readLimited(res) {
  if (!res.body) return res.text();
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      await reader.cancel();
      throw new Error('캘린더 파일이 너무 큽니다 (최대 5MB).');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
