// 5단계 가능도 정의 (서버의 src/availability.js 와 같은 값)
export const LEVELS = [
  { value: 5, label: '아주 좋음', short: '아주 좋음' },
  { value: 4, label: '좋음', short: '좋음' },
  { value: 3, label: '애매함', short: '애매함' },
  { value: 2, label: '웬만하면 안 됨', short: '웬만하면 X' },
  { value: 1, label: '안 됨', short: '안 됨' },
];

export function levelLabel(level) {
  return LEVELS.find((l) => l.value === level)?.label ?? '미입력';
}

export const SLOTS_PER_DAY = 48;
export const WEEKDAYS = ['월', '화', '수', '목', '금', '토', '일'];

export function slotLabel(slot) {
  const minutes = slot * 30;
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

// ── 날짜 (모두 KST 기준 'YYYY-MM-DD') ──

function utc(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

export function addDays(dateStr, n) {
  return new Date(utc(dateStr) + n * 86400000).toISOString().slice(0, 10);
}

export function weekdayOf(dateStr) {
  return (new Date(utc(dateStr)).getUTCDay() + 6) % 7;
}

export function todayKst() {
  return new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
}

export function mondayOf(dateStr) {
  return addDays(dateStr, -weekdayOf(dateStr));
}

export function formatDate(dateStr) {
  const [, m, d] = dateStr.split('-').map(Number);
  return `${m}월 ${d}일 (${WEEKDAYS[weekdayOf(dateStr)]})`;
}

export function shortDate(dateStr) {
  const [, m, d] = dateStr.split('-').map(Number);
  return `${m}/${d}`;
}
