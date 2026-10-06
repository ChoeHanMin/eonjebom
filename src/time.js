// 언제봄은 한국 사용자를 대상으로 하므로 모든 날짜/시간을 KST(UTC+9, 서머타임 없음) 기준으로 다룬다.
// 하루는 30분 단위 슬롯 48개로 나뉜다. 슬롯 0 = 00:00~00:30, 슬롯 47 = 23:30~24:00.

export const SLOT_MINUTES = 30;
export const SLOT_MS = SLOT_MINUTES * 60 * 1000;
export const SLOTS_PER_DAY = (24 * 60) / SLOT_MINUTES;
export const DAY_MS = 24 * 60 * 60 * 1000;
export const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** 'YYYY-MM-DD' 문자열이 실제로 존재하는 날짜인지 검사한다. */
export function isValidDate(str) {
  if (typeof str !== 'string') return false;
  const m = DATE_RE.exec(str);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

function utcMidnight(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function formatUtcDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(dateStr, n) {
  return formatUtcDate(utcMidnight(dateStr) + n * DAY_MS);
}

/** 요일 (0 = 월요일 ... 6 = 일요일) */
export function weekdayOf(dateStr) {
  return (new Date(utcMidnight(dateStr)).getUTCDay() + 6) % 7;
}

export function mondayOf(dateStr) {
  return addDays(dateStr, -weekdayOf(dateStr));
}

/** KST 기준 해당 날짜 00:00의 epoch ms */
export function dayStartMs(dateStr) {
  return utcMidnight(dateStr) - KST_OFFSET_MS;
}

export function slotStartMs(dateStr, slot) {
  return dayStartMs(dateStr) + slot * SLOT_MS;
}

export function todayKst(nowMs = Date.now()) {
  return formatUtcDate(nowMs + KST_OFFSET_MS);
}

export function dateRange(start, days) {
  return Array.from({ length: days }, (_, i) => addDays(start, i));
}

/** 슬롯 번호를 'HH:MM' 으로 (48 → '24:00') */
export function slotLabel(slot) {
  const minutes = slot * SLOT_MINUTES;
  const h = String(Math.floor(minutes / 60)).padStart(2, '0');
  const m = String(minutes % 60).padStart(2, '0');
  return `${h}:${m}`;
}
