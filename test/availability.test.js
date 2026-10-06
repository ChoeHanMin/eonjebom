import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSchedule, combineSchedules, suggestTimes } from '../src/availability.js';
import { slotStartMs, weekdayOf, mondayOf, addDays, todayKst, isValidDate, slotLabel } from '../src/time.js';

const DATE = '2026-10-05'; // 월요일

test('날짜 유틸: 요일, 주 시작, KST 경계', () => {
  assert.equal(weekdayOf(DATE), 0);
  assert.equal(weekdayOf('2026-10-11'), 6);
  assert.equal(mondayOf('2026-10-11'), DATE);
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  // 2026-10-05 15:00 UTC = 10-06 00:00 KST
  assert.equal(todayKst(Date.UTC(2026, 9, 5, 15, 0)), '2026-10-06');
  assert.equal(todayKst(Date.UTC(2026, 9, 5, 14, 59)), '2026-10-05');
  assert.equal(slotStartMs(DATE, 20), Date.UTC(2026, 9, 5, 1, 0)); // 10:00 KST
  assert.equal(isValidDate('2026-02-30'), false);
  assert.equal(slotLabel(48), '24:00');
});

test('우선순위: 직접 입력 > 캘린더 > 기본 시간표 > 미입력', () => {
  const weekly = new Map([
    ['0:20', 5],
    ['0:21', 5],
    ['0:22', 5],
  ]);
  const overrides = new Map([[`${DATE}:22`, 3]]);
  // 10:30 ~ 11:10 KST 일정 → 슬롯 21, 22 에 걸침
  const busy = [{ start: slotStartMs(DATE, 21), end: slotStartMs(DATE, 22) + 10 * 60 * 1000, level: 1 }];
  const s = buildSchedule({ dates: [DATE], weekly, overrides, busy })[DATE];
  assert.deepEqual(s[20], { level: 5, source: 'weekly' });
  assert.deepEqual(s[21], { level: 1, source: 'calendar' });
  assert.deepEqual(s[22], { level: 3, source: 'override' });
  assert.deepEqual(s[23], { level: null, source: null });
});

test('여러 캘린더가 겹치면 더 나쁜 가능도를 쓴다', () => {
  const busy = [
    { start: slotStartMs(DATE, 10), end: slotStartMs(DATE, 12), level: 2 },
    { start: slotStartMs(DATE, 11), end: slotStartMs(DATE, 13), level: 1 },
  ];
  const s = buildSchedule({ dates: [DATE], weekly: new Map(), overrides: new Map(), busy })[DATE];
  assert.deepEqual([s[10].level, s[11].level, s[12].level, s[13].level], [2, 1, 1, null]);
});

test('자정을 넘기는 일정은 다음 날에도 반영된다', () => {
  const next = addDays(DATE, 1);
  const busy = [{ start: slotStartMs(DATE, 46), end: slotStartMs(next, 2), level: 1 }];
  const s = buildSchedule({ dates: [DATE, next], weekly: new Map(), overrides: new Map(), busy });
  assert.equal(s[DATE][47].level, 1);
  assert.equal(s[next][1].level, 1);
  assert.equal(s[next][2].level, null);
});

function scheduleFrom(levels) {
  // levels: { slot: level }
  const cells = Array.from({ length: 48 }, (_, i) => ({ level: levels[i] ?? null, source: null }));
  return { [DATE]: cells };
}

test('합치기: 가장 나쁜 사람 기준, 한 명이라도 미입력이면 미입력', () => {
  const me = scheduleFrom({ 10: 5, 11: 4, 12: 5 });
  const you = scheduleFrom({ 10: 3, 11: 5 });
  const c = combineSchedules([DATE], [me, you])[DATE];
  assert.equal(c[10].level, 3);
  assert.equal(c[11].level, 4);
  assert.equal(c[12].level, null);
  assert.deepEqual(c[10].levels, [5, 3]);
});

test('추천: 좋은 시간대가 먼저, 너무 짧은 구간과 지난 시간은 제외', () => {
  const combined = combineSchedules(
    [DATE],
    [scheduleFrom({ 20: 5, 21: 5, 22: 3, 23: 3, 24: 3, 30: 5, 40: 4, 41: 4 })],
  );
  const all = suggestTimes([DATE], combined, { minSlots: 2 });
  assert.deepEqual(
    all.map((s) => [s.startSlot, s.endSlot, s.minLevel]),
    [
      [20, 22, 5],
      [40, 42, 4],
      [20, 25, 3],
    ],
  );
  const later = suggestTimes([DATE], combined, { minSlots: 2, notBefore: slotStartMs(DATE, 21) });
  assert.deepEqual(
    later.map((s) => [s.startSlot, s.endSlot]),
    [
      [40, 42],
      [21, 25],
    ],
  );
});
