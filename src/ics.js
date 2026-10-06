// iCalendar(.ics) 데이터에서 '바쁜 시간' 구간만 뽑아낸다. 일정 제목 등 내용은 저장하지 않는다.
import ICAL from 'ical.js';
import { KST_OFFSET_MS } from './time.js';

const MAX_OCCURRENCES_PER_EVENT = 10000;

/**
 * @param {string} text  .ics 파일 내용
 * @param {{from:number, to:number}} window  이 구간(epoch ms)과 겹치는 일정만 반환
 * @returns {{start:number, end:number}[]}
 */
export function parseIcsBusy(text, { from, to }) {
  let root;
  try {
    root = new ICAL.Component(ICAL.parse(text));
  } catch {
    throw new Error('올바른 iCalendar(.ics) 형식이 아닙니다.');
  }
  if (root.name !== 'vcalendar') throw new Error('올바른 iCalendar(.ics) 형식이 아닙니다.');

  // 파일에 들어 있는 VTIMEZONE 정의는 이 파일을 해석하는 동안에만 등록한다.
  // (전역 등록을 남겨 두면 다른 사용자의 파일 해석에 영향을 줄 수 있다.)
  const registered = [];
  for (const tz of root.getAllSubcomponents('vtimezone')) {
    const tzid = tz.getFirstPropertyValue('tzid');
    if (!tzid || ICAL.TimezoneService.has(tzid)) continue;
    try {
      ICAL.TimezoneService.register(tz);
      registered.push(tzid);
    } catch {
      // 이상한 VTIMEZONE 정의는 무시하고 KST로 간주한다.
    }
  }
  try {
    return collectBusy(root, from, to);
  } finally {
    for (const tzid of registered) ICAL.TimezoneService.remove(tzid);
  }
}

function collectBusy(root, from, to) {
  // 반복 일정의 예외(RECURRENCE-ID)를 원본 일정에 연결한다.
  const masters = new Map();
  const exceptions = [];
  for (const comp of root.getAllSubcomponents('vevent')) {
    if (comp.hasProperty('recurrence-id')) exceptions.push(comp);
    else {
      const uid = comp.getFirstPropertyValue('uid');
      masters.set(uid && !masters.has(uid) ? uid : Symbol('event'), new ICAL.Event(comp));
    }
  }
  for (const ex of exceptions) {
    const master = masters.get(ex.getFirstPropertyValue('uid'));
    if (master) master.relateException(ex);
    else masters.set(Symbol('orphan'), new ICAL.Event(ex));
  }

  const busy = [];
  const push = (eventComp, startTime, endTime) => {
    if (!blocksTime(eventComp)) return;
    if (startTime.isDate) return; // 종일 일정(생일, 기념일 등)은 시간을 막지 않는 것으로 본다.
    const start = toEpochMs(startTime);
    const end = endTime ? toEpochMs(endTime) : start;
    if (end <= start || end <= from || start >= to) return;
    busy.push({ start, end });
  };

  for (const event of masters.values()) {
    if (!event.startDate) continue;
    if (!event.isRecurring()) {
      push(event.component, event.startDate, event.endDate);
      continue;
    }
    const it = event.iterator();
    let next;
    let count = 0;
    while ((next = it.next()) && count++ < MAX_OCCURRENCES_PER_EVENT) {
      if (toEpochMs(next) >= to) break;
      const d = event.getOccurrenceDetails(next);
      push(d.item.component, d.startDate, d.endDate);
    }
  }
  return busy;
}

function blocksTime(comp) {
  const transp = String(comp.getFirstPropertyValue('transp') ?? '').toUpperCase();
  const status = String(comp.getFirstPropertyValue('status') ?? '').toUpperCase();
  return transp !== 'TRANSPARENT' && status !== 'CANCELLED';
}

function toEpochMs(t) {
  const tzid = t.zone?.tzid;
  // 시간대 정보가 없거나(floating) 정의되지 않은 TZID는 KST로 해석한다.
  // ical.js는 floating 시간을 UTC로 계산하므로 9시간을 빼 준다.
  if (!tzid || tzid === 'floating') return t.toUnixTime() * 1000 - KST_OFFSET_MS;
  return t.toUnixTime() * 1000;
}
