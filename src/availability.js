// 가능 여부 계산의 핵심 로직. DB나 HTTP와 무관한 순수 함수만 둔다.
import { SLOTS_PER_DAY, DAY_MS, SLOT_MS, dayStartMs, weekdayOf, slotStartMs } from './time.js';

// 5단계 가능도. 숫자가 클수록 좋다. null = 미입력.
export const LEVELS = Object.freeze({
  GREAT: 5, // 아주 좋음
  GOOD: 4, // 좋음
  MAYBE: 3, // 애매함
  RATHER_NOT: 2, // 웬만하면 안 됨
  NO: 1, // 안 됨
});

export function isLevel(v) {
  return Number.isInteger(v) && v >= 1 && v <= 5;
}

export function isSlot(v) {
  return Number.isInteger(v) && v >= 0 && v < SLOTS_PER_DAY;
}

/**
 * 한 사람의 날짜별 실제 가능도를 계산한다.
 * 우선순위: 날짜별 직접 입력(override) > 캘린더 일정(calendar) > 매주 기본 시간표(weekly) > 미입력(null)
 *
 * @param {object} p
 * @param {string[]} p.dates  'YYYY-MM-DD' 목록
 * @param {Map<string, number>} p.weekly  `${weekday}:${slot}` -> level
 * @param {Map<string, number>} p.overrides  `${date}:${slot}` -> level
 * @param {{start:number,end:number,level:number}[]} p.busy  캘린더에서 가져온 바쁜 구간 (epoch ms)
 * @returns {Record<string, {level:number|null, source:string|null}[]>}
 */
export function buildSchedule({ dates, weekly, overrides, busy }) {
  const result = {};
  for (const date of dates) {
    const wd = weekdayOf(date);
    const busyLevels = busyLevelsForDate(date, busy);
    const cells = [];
    for (let slot = 0; slot < SLOTS_PER_DAY; slot++) {
      const o = overrides.get(`${date}:${slot}`);
      if (o !== undefined) {
        cells.push({ level: o, source: 'override' });
      } else if (busyLevels[slot] !== null) {
        cells.push({ level: busyLevels[slot], source: 'calendar' });
      } else {
        const w = weekly.get(`${wd}:${slot}`);
        cells.push(w !== undefined ? { level: w, source: 'weekly' } : { level: null, source: null });
      }
    }
    result[date] = cells;
  }
  return result;
}

/** 해당 날짜의 슬롯별로, 겹치는 캘린더 일정 중 가장 낮은 가능도 (없으면 null) */
function busyLevelsForDate(date, busy) {
  const levels = new Array(SLOTS_PER_DAY).fill(null);
  const dayStart = dayStartMs(date);
  const dayEnd = dayStart + DAY_MS;
  for (const b of busy) {
    if (b.end <= dayStart || b.start >= dayEnd) continue;
    const from = Math.floor((Math.max(b.start, dayStart) - dayStart) / SLOT_MS);
    const to = Math.ceil((Math.min(b.end, dayEnd) - dayStart) / SLOT_MS);
    for (let s = from; s < to; s++) {
      levels[s] = levels[s] === null ? b.level : Math.min(levels[s], b.level);
    }
  }
  return levels;
}

/**
 * 여러 사람의 일정을 합친다. 모두가 함께하려면 가장 안 좋은 사람의 상태가 곧 전체 상태이므로 최솟값을 쓴다.
 * 한 명이라도 미입력이면 전체도 미입력(null)으로 본다.
 * @returns {Record<string, {level:number|null, levels:(number|null)[]}[]>}
 */
export function combineSchedules(dates, schedules) {
  const result = {};
  for (const date of dates) {
    const cells = [];
    for (let slot = 0; slot < SLOTS_PER_DAY; slot++) {
      const levels = schedules.map((s) => s[date][slot].level);
      const level = levels.includes(null) ? null : Math.min(...levels);
      cells.push({ level, levels });
    }
    result[date] = cells;
  }
  return result;
}

/**
 * 합친 일정에서 함께 만나기 좋은 시간대를 추천한다.
 * 기준 가능도(5 → minLevel) 별로 연속 구간을 찾고, 좋은 순 → 긴 순 → 빠른 순으로 정렬한다.
 *
 * @param {string[]} dates
 * @param {Record<string, {level:number|null}[]>} combined
 * @param {object} [opts]
 * @param {number} [opts.minSlots=2]  최소 길이 (슬롯 수, 기본 1시간)
 * @param {number} [opts.minLevel=3]  이 가능도 이상만 추천
 * @param {number} [opts.limit=10]
 * @param {number} [opts.notBefore]  이 시각(epoch ms) 이전에 시작하는 슬롯은 제외
 */
export function suggestTimes(dates, combined, opts = {}) {
  const { minSlots = 2, minLevel = 3, limit = 10, notBefore = -Infinity } = opts;
  const seen = new Set();
  const found = [];

  for (let threshold = 5; threshold >= minLevel; threshold--) {
    for (const date of dates) {
      const cells = combined[date];
      let runStart = null;
      for (let slot = 0; slot <= SLOTS_PER_DAY; slot++) {
        const ok =
          slot < SLOTS_PER_DAY &&
          cells[slot].level !== null &&
          cells[slot].level >= threshold &&
          slotStartMs(date, slot) >= notBefore;
        if (ok && runStart === null) runStart = slot;
        if (!ok && runStart !== null) {
          const len = slot - runStart;
          const key = `${date}:${runStart}:${slot}`;
          if (len >= minSlots && !seen.has(key)) {
            seen.add(key);
            const run = cells.slice(runStart, slot).map((c) => c.level);
            found.push({
              date,
              startSlot: runStart,
              endSlot: slot, // 끝 슬롯은 포함하지 않음
              minLevel: Math.min(...run),
              avgLevel: run.reduce((a, b) => a + b, 0) / run.length,
            });
          }
          runStart = null;
        }
      }
    }
  }

  found.sort(
    (a, b) =>
      b.minLevel - a.minLevel ||
      b.avgLevel - a.avgLevel ||
      b.endSlot - b.startSlot - (a.endSlot - a.startSlot) ||
      a.date.localeCompare(b.date) ||
      a.startSlot - b.startSlot,
  );
  return found.slice(0, limit);
}
