// 언제봄의 모든 데이터를 이 브라우저 안에 저장하고 계산한다. (서버 없음)
// storage 는 localStorage 와 같은 모양({getItem, setItem, removeItem})이면 무엇이든 된다.
import { buildSchedule, combineSchedules, suggestTimes, isLevel, isSlot, LEVELS } from './availability.js';
import { SLOTS_PER_DAY, DAY_MS, isValidDate, mondayOf, todayKst, dateRange, weekdayOf, addDays } from './time.js';
import { parseIcsBusy } from './ics.js';
import { encodeShareCode, decodeShareCode } from './share-code.js';

const KEY = 'eonjebom:data';
const SHARE_DAYS = 21; // 코드에 실제 일정을 담는 기간 (이번 주 월요일부터 3주)
const CALENDAR_PAST_DAYS = 7;
const CALENDAR_FUTURE_DAYS = 120;
const MAX_CALENDARS = 10;
const MAX_FRIENDS = 30;

export class StoreError extends Error {}

/**
 * @param {Pick<Storage, 'getItem'|'setItem'|'removeItem'>} storage
 * @param {{now?: () => number, randomId?: () => string}} [opts]
 */
export function createStore(storage, { now = Date.now, randomId = defaultRandomId } = {}) {
  let data = load();

  function load() {
    try {
      const d = JSON.parse(storage.getItem(KEY) ?? 'null');
      if (d && typeof d === 'object') return { me: d.me ?? null, friends: Array.isArray(d.friends) ? d.friends : [] };
    } catch {
      // 손상된 데이터면 새로 시작
    }
    return { me: null, friends: [] };
  }

  function save() {
    try {
      storage.setItem(KEY, JSON.stringify(data));
    } catch {
      // 저장소를 쓸 수 없으면 이 탭이 열려 있는 동안만 유지된다.
    }
  }

  function me() {
    if (!data.me) throw new StoreError('내 시간표가 없어요. 이름을 적고 시작해 주세요.');
    return data.me;
  }

  function parseName(value) {
    const name = String(value ?? '').trim();
    if (name.length < 1 || name.length > 20) throw new StoreError('이름은 1~20자로 적어 주세요.');
    return name;
  }

  function applyCells(target, cells, keyOf) {
    for (const c of cells) {
      const key = c ? keyOf(c) : null; // 요일 0(월)도 올바른 값이므로 null 로만 판단
      if (key === null || !isSlot(c.slot) || !(c.level === null || isLevel(c.level))) {
        throw new StoreError('잘못된 칸 정보가 있어요.');
      }
      if (c.level === null) delete target[`${key}:${c.slot}`];
      else target[`${key}:${c.slot}`] = c.level;
    }
    save();
  }

  function scheduleOf(person, dates) {
    const busy = [];
    for (const cal of person.calendars ?? [])
      for (const b of cal.busy) busy.push({ start: b[0], end: b[1], level: cal.busyLevel });
    return buildSchedule({
      dates,
      weekly: new Map(Object.entries(person.weekly)),
      overrides: new Map(Object.entries(person.overrides)),
      busy,
    });
  }

  /** 받은 코드(스냅숏)로 친구의 날짜별 일정을 만든다. 코드에 담긴 기간 밖은 기본 시간표를 쓴다. */
  function friendScheduleOf(friend, dates) {
    const out = {};
    const start = Date.parse(`${friend.windowStart}T00:00:00Z`);
    for (const date of dates) {
      const offset = Math.round((Date.parse(`${date}T00:00:00Z`) - start) / DAY_MS);
      const inWindow = offset >= 0 && offset * SLOTS_PER_DAY < friend.window.length;
      const src = inWindow ? friend.window : friend.weekly;
      const base = (inWindow ? offset : weekdayOf(date)) * SLOTS_PER_DAY;
      out[date] = Array.from({ length: SLOTS_PER_DAY }, (_, s) => ({ level: src[base + s] ?? null }));
    }
    return out;
  }

  return {
    // ── 내 정보 ──
    get me() {
      return data.me ? { id: data.me.id, name: data.me.name } : null;
    },

    start(name) {
      data.me = { id: randomId(), name: parseName(name), weekly: {}, overrides: {}, calendars: [] };
      save();
      return this.me;
    },

    rename(name) {
      me().name = parseName(name);
      save();
    },

    deleteAll() {
      data = { me: null, friends: [] };
      try {
        storage.removeItem(KEY);
      } catch {
        // 무시
      }
    },

    // ── 내 일정 ──
    weeklyCells() {
      return Object.entries(me().weekly).map(([k, level]) => {
        const [weekday, slot] = k.split(':').map(Number);
        return { weekday, slot, level };
      });
    },

    setWeekly(cells) {
      applyCells(me().weekly, cells, (c) => (Number.isInteger(c.weekday) && c.weekday >= 0 && c.weekday <= 6 ? c.weekday : null));
    },

    setOverrides(cells) {
      applyCells(me().overrides, cells, (c) => (isValidDate(c.date) ? c.date : null));
    },

    schedule(start, days = 7) {
      const dates = dateRange(start, days);
      return { dates, cells: scheduleOf(me(), dates) };
    },

    // ── 캘린더 파일 ──
    calendars() {
      return me().calendars.map(({ id, name, busyLevel, importedAt, busy }) => ({
        id,
        name,
        busyLevel,
        importedAt,
        events: busy.length,
      }));
    },

    importCalendar({ name, icsText, busyLevel = LEVELS.BUSY }) {
      if (me().calendars.length >= MAX_CALENDARS) throw new StoreError(`캘린더는 ${MAX_CALENDARS}개까지 가져올 수 있어요.`);
      if (!isLevel(busyLevel)) throw new StoreError('일정 시간의 표시 값이 올바르지 않아요.');
      const t = now();
      let busy;
      try {
        busy = parseIcsBusy(icsText, { from: t - CALENDAR_PAST_DAYS * DAY_MS, to: t + CALENDAR_FUTURE_DAYS * DAY_MS });
      } catch (err) {
        throw new StoreError(err.message);
      }
      const cal = {
        id: randomId(),
        name:
          String(name ?? '')
            .trim()
            .slice(0, 40) || '가져온 캘린더',
        busyLevel,
        importedAt: t,
        busy: mergeIntervals(busy).map((b) => [b.start, b.end]),
      };
      me().calendars.push(cal);
      save();
      return { id: cal.id, events: cal.busy.length };
    },

    setCalendarLevel(id, busyLevel) {
      if (!isLevel(busyLevel)) throw new StoreError('일정 시간의 표시 값이 올바르지 않아요.');
      const cal = me().calendars.find((c) => c.id === id);
      if (!cal) throw new StoreError('캘린더를 찾을 수 없어요.');
      cal.busyLevel = busyLevel;
      save();
    },

    removeCalendar(id) {
      me().calendars = me().calendars.filter((c) => c.id !== id);
      save();
    },

    // ── 시간표 코드 ──
    /** 내 시간표를 친구에게 보낼 코드로 만든다. */
    shareCode() {
      const m = me();
      const weekly = [];
      for (let wd = 0; wd < 7; wd++) for (let s = 0; s < SLOTS_PER_DAY; s++) weekly.push(m.weekly[`${wd}:${s}`] ?? null);
      const windowStart = mondayOf(todayKst(now()));
      const { dates, cells } = this.schedule(windowStart, SHARE_DAYS);
      const window = dates.flatMap((d) => cells[d].map((c) => c.level));
      return encodeShareCode({ id: m.id, name: m.name, weekly, windowStart, window });
    },

    /** 친구가 보낸 코드를 추가한다. 같은 사람이 보낸 새 코드면 이전 것을 바꾼다. */
    addFriend(text) {
      let decoded;
      try {
        decoded = decodeShareCode(text);
      } catch (err) {
        throw new StoreError(err.message);
      }
      if (data.me && decoded.id === data.me.id) throw new StoreError('내 코드예요. 친구에게 받은 코드를 붙여 넣어 주세요.');
      const friend = { ...decoded, receivedAt: now() };
      const index = data.friends.findIndex((f) => f.id === decoded.id);
      const updated = index >= 0;
      if (updated) data.friends.splice(index, 1);
      data.friends.unshift(friend);
      data.friends = data.friends.slice(0, MAX_FRIENDS);
      save();
      return { id: friend.id, name: friend.name, updated };
    },

    friends() {
      return data.friends.map(({ id, name, receivedAt, windowStart, window }) => ({
        id,
        name,
        receivedAt,
        validUntil: addDays(windowStart, window.length / SLOTS_PER_DAY - 1),
      }));
    },

    removeFriend(id) {
      data.friends = data.friends.filter((f) => f.id !== id);
      save();
    },

    /** 다른 기기에서 만든 내 코드로 내 기본 시간표를 되살린다. (캘린더 파일은 다시 가져와야 함) */
    restoreFromCode(text) {
      let decoded;
      try {
        decoded = decodeShareCode(text);
      } catch (err) {
        throw new StoreError(err.message);
      }
      const weekly = {};
      decoded.weekly.forEach((level, i) => {
        if (level !== null) weekly[`${Math.floor(i / SLOTS_PER_DAY)}:${i % SLOTS_PER_DAY}`] = level;
      });
      data.me = { id: decoded.id, name: decoded.name, weekly, overrides: {}, calendars: [] };
      data.friends = data.friends.filter((f) => f.id !== decoded.id);
      save();
      return this.me;
    },

    // ── 비교 ──
    compare(friendIds, start, { days = 7, minSlots = 2, minLevel = LEVELS.MAYBE } = {}) {
      const others = friendIds.map((id) => data.friends.find((f) => f.id === id)).filter(Boolean);
      if (others.length === 0) throw new StoreError('같이 볼 친구를 골라 주세요.');
      const dates = dateRange(start, days);
      const people = [
        { id: me().id, name: me().name, isMe: true },
        ...others.map((f) => ({ id: f.id, name: f.name, isMe: false })),
      ];
      const cells = combineSchedules(dates, [scheduleOf(me(), dates), ...others.map((f) => friendScheduleOf(f, dates))]);
      return { dates, people, cells, suggestions: suggestTimes(dates, cells, { minSlots, minLevel, notBefore: now() }) };
    },
  };
}

function mergeIntervals(intervals) {
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const merged = [];
  for (const iv of sorted) {
    const last = merged[merged.length - 1];
    if (last && iv.start <= last.end) last.end = Math.max(last.end, iv.end);
    else merged.push({ start: iv.start, end: iv.end });
  }
  return merged;
}

function defaultRandomId() {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** localStorage 를 못 쓰는 환경(사생활 보호 모드 등)에서도 동작하도록 감싼다. */
export function browserStorage() {
  const memory = new Map();
  const ok = (() => {
    try {
      localStorage.setItem('eonjebom:probe', '1');
      localStorage.removeItem('eonjebom:probe');
      return true;
    } catch {
      return false;
    }
  })();
  return {
    persistent: ok,
    getItem: (k) => (ok ? localStorage.getItem(k) : (memory.get(k) ?? null)),
    setItem: (k, v) => (ok ? localStorage.setItem(k, v) : memory.set(k, v)),
    removeItem: (k) => (ok ? localStorage.removeItem(k) : memory.delete(k)),
  };
}
