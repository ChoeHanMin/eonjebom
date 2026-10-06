// 서버 없이 시간표를 친구에게 보내기 위해, 시간표를 통째로 문자열 '시간표 코드'에 담는다.
//
// 형식: 'EB1.' + base64url(바이트)
//   [0]     버전 (1)
//   [1..4]  사람 id (임의 4바이트, 같은 사람이 새 코드를 보내면 이전 것을 바꾸는 데 씀)
//   [5]     이름 길이 n (UTF-8 바이트, 최대 60)
//   [6..]   이름
//   다음 2  기간 시작일 (1970-01-01부터 며칠째, uint16)
//   다음 1  기간 일수 d
//   나머지  칸 값 스트림: 매주 기본 시간표 7×48칸 + 기간 d일×48칸(캘린더·날짜별 수정까지 반영한 실제 값)
//           연속된 같은 값을 1바이트로: (값 << 6) | (길이 - 1)  값 0 = 미입력, 1~3 = 가능도, 길이 1~64
//
// 받은 쪽은 기간 안의 날짜는 실제 값을, 기간 밖의 날짜는 기본 시간표를 쓴다.
import { SLOTS_PER_DAY, DAY_MS } from './time.js';

export const CODE_PREFIX = 'EB1.';
const VERSION = 1;
const WEEKLY_SLOTS = 7 * SLOTS_PER_DAY;
const MAX_NAME_BYTES = 60;
const MAX_DAYS = 42;

/**
 * @param {object} p
 * @param {string} p.id  8자리 16진수
 * @param {string} p.name
 * @param {(number|null)[]} p.weekly  7×48 (월요일 00:00 부터)
 * @param {string} p.windowStart  'YYYY-MM-DD'
 * @param {(number|null)[]} p.window  days×48
 */
export function encodeShareCode({ id, name, weekly, windowStart, window }) {
  if (weekly.length !== WEEKLY_SLOTS || window.length % SLOTS_PER_DAY !== 0) throw new Error('칸 수가 맞지 않아요.');
  const days = window.length / SLOTS_PER_DAY;
  if (days > MAX_DAYS) throw new Error('기간이 너무 길어요.');
  const nameBytes = truncateUtf8(new TextEncoder().encode(name), MAX_NAME_BYTES);

  const bytes = [VERSION, ...hexToBytes(id), nameBytes.length, ...nameBytes];
  const day = Math.round(Date.parse(`${windowStart}T00:00:00Z`) / DAY_MS);
  bytes.push(day >> 8, day & 0xff, days);

  const values = [...weekly, ...window];
  for (let i = 0; i < values.length; ) {
    const v = values[i] ?? 0;
    let len = 1;
    while (len < 64 && i + len < values.length && (values[i + len] ?? 0) === v) len++;
    bytes.push((v << 6) | (len - 1));
    i += len;
  }
  return CODE_PREFIX + toBase64Url(Uint8Array.from(bytes));
}

/** 붙여 넣은 글(카톡 메시지 전체 등)에서 시간표 코드를 찾는다. */
export function findShareCode(text) {
  const m = /EB1\.[A-Za-z0-9_-]{8,}/.exec(String(text ?? ''));
  return m ? m[0] : null;
}

/**
 * @returns {{id:string, name:string, weekly:(number|null)[], windowStart:string, window:(number|null)[]}}
 */
export function decodeShareCode(text) {
  const code = findShareCode(text);
  if (!code) throw new Error('시간표 코드를 찾지 못했어요. "EB1."로 시작하는 코드를 통째로 붙여 넣어 주세요.');
  let bytes;
  try {
    bytes = fromBase64Url(code.slice(CODE_PREFIX.length));
  } catch {
    throw new Error('코드가 잘렸거나 바뀐 것 같아요. 다시 복사해 주세요.');
  }
  const bad = () => new Error('코드가 잘렸거나 바뀐 것 같아요. 다시 복사해 주세요.');
  let p = 0;
  const take = (n) => {
    if (p + n > bytes.length) throw bad();
    const out = bytes.subarray(p, p + n);
    p += n;
    return out;
  };
  if (take(1)[0] !== VERSION) throw new Error('이 앱이 모르는 버전의 코드예요. 앱을 새로고침해 보세요.');
  const id = bytesToHex(take(4));
  const nameLen = take(1)[0];
  if (nameLen > MAX_NAME_BYTES) throw bad();
  const name = new TextDecoder().decode(take(nameLen)).trim() || '이름 없음';
  const [hi, lo] = take(2);
  const windowStart = new Date(((hi << 8) | lo) * DAY_MS).toISOString().slice(0, 10);
  const days = take(1)[0];
  if (days > MAX_DAYS) throw bad();

  const total = WEEKLY_SLOTS + days * SLOTS_PER_DAY;
  const values = [];
  while (p < bytes.length) {
    const b = bytes[p++];
    const v = b >> 6;
    const len = (b & 63) + 1;
    for (let i = 0; i < len; i++) values.push(v === 0 ? null : v);
  }
  if (values.length !== total) throw bad();
  return { id, name, weekly: values.slice(0, WEEKLY_SLOTS), windowStart, window: values.slice(WEEKLY_SLOTS) };
}

// ── 바이트 유틸 (브라우저와 Node 모두에서 동작) ──

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function toBase64Url(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    const chars = [(n >> 18) & 63, (n >> 12) & 63, (n >> 6) & 63, n & 63].map((x) => B64[x]);
    out += chars.slice(0, Math.min(4, bytes.length - i + 1)).join('');
  }
  return out;
}

function fromBase64Url(text) {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) throw new Error('bad base64');
  const out = [];
  for (let i = 0; i < text.length; i += 4) {
    const chunk = text.slice(i, i + 4);
    const n = [...chunk.padEnd(4, 'A')].reduce((acc, ch) => (acc << 6) | B64.indexOf(ch), 0);
    out.push((n >> 16) & 255, (n >> 8) & 255, n & 255);
    out.length -= 4 - chunk.length; // 패딩만큼 버림 (4글자=3바이트, 3글자=2바이트, 2글자=1바이트)
  }
  return Uint8Array.from(out);
}

function hexToBytes(hex) {
  if (!/^[0-9a-f]{8}$/.test(hex)) throw new Error('id는 8자리 16진수여야 해요.');
  return [0, 2, 4, 6].map((i) => parseInt(hex.slice(i, i + 2), 16));
}

function bytesToHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function truncateUtf8(bytes, max) {
  if (bytes.length <= max) return bytes;
  let end = max;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--; // 글자 중간에서 자르지 않도록
  return bytes.subarray(0, end);
}
