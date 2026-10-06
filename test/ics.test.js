import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIcsBusy } from '../src/ics.js';
import { slotStartMs } from '../src/time.js';

const WINDOW = { from: Date.UTC(2026, 9, 1), to: Date.UTC(2026, 10, 1) };
const ics = (body) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:test\r\n${body}\r\nEND:VCALENDAR\r\n`;

test('UTC, floating(=KST), TZID 시간을 올바르게 해석한다', () => {
  const busy = parseIcsBusy(
    ics(`BEGIN:VEVENT
UID:utc
DTSTART:20261005T010000Z
DTEND:20261005T020000Z
END:VEVENT
BEGIN:VEVENT
UID:floating
DTSTART:20261005T150000
DTEND:20261005T160000
END:VEVENT
BEGIN:VEVENT
UID:tzid-no-vtimezone
DTSTART;TZID=Asia/Seoul:20261006T090000
DTEND;TZID=Asia/Seoul:20261006T100000
END:VEVENT`),
    WINDOW,
  );
  assert.deepEqual(busy, [
    { start: slotStartMs('2026-10-05', 20), end: slotStartMs('2026-10-05', 22) }, // 10~11시 KST
    { start: slotStartMs('2026-10-05', 30), end: slotStartMs('2026-10-05', 32) }, // 15~16시 KST
    { start: slotStartMs('2026-10-06', 18), end: slotStartMs('2026-10-06', 20) }, // 9~10시 KST
  ]);
});

test('VTIMEZONE이 정의된 다른 시간대도 변환한다', () => {
  const busy = parseIcsBusy(
    ics(`BEGIN:VTIMEZONE
TZID:Test/Plus2
BEGIN:STANDARD
DTSTART:19700101T000000
TZOFFSETFROM:+0200
TZOFFSETTO:+0200
END:STANDARD
END:VTIMEZONE
BEGIN:VEVENT
UID:x
DTSTART;TZID=Test/Plus2:20261005T100000
DTEND;TZID=Test/Plus2:20261005T110000
END:VEVENT`),
    WINDOW,
  );
  assert.deepEqual(busy, [{ start: Date.UTC(2026, 9, 5, 8), end: Date.UTC(2026, 9, 5, 9) }]);
});

test('반복 일정을 펼치고, 예외/취소/종일/투명 일정을 처리한다', () => {
  const busy = parseIcsBusy(
    ics(`BEGIN:VEVENT
UID:class
DTSTART:20261005T100000
DTEND:20261005T113000
RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=4
EXDATE:20261012T100000
END:VEVENT
BEGIN:VEVENT
UID:class
RECURRENCE-ID:20261019T100000
DTSTART:20261019T130000
DTEND:20261019T140000
END:VEVENT
BEGIN:VEVENT
UID:allday
DTSTART;VALUE=DATE:20261007
DTEND;VALUE=DATE:20261008
END:VEVENT
BEGIN:VEVENT
UID:free
DTSTART:20261008T100000
DTEND:20261008T110000
TRANSP:TRANSPARENT
END:VEVENT
BEGIN:VEVENT
UID:cancelled
DTSTART:20261009T100000
DTEND:20261009T110000
STATUS:CANCELLED
END:VEVENT`),
    WINDOW,
  );
  assert.deepEqual(busy, [
    { start: slotStartMs('2026-10-05', 20), end: slotStartMs('2026-10-05', 23) },
    // 10-12 는 EXDATE 로 빠짐, 10-19 는 13시로 옮겨짐
    { start: slotStartMs('2026-10-19', 26), end: slotStartMs('2026-10-19', 28) },
    { start: slotStartMs('2026-10-26', 20), end: slotStartMs('2026-10-26', 23) },
  ]);
});

test('조회 구간 밖의 일정은 제외하고, 잘못된 파일은 오류를 낸다', () => {
  const busy = parseIcsBusy(
    ics(`BEGIN:VEVENT
UID:old
DTSTART:20250105T100000Z
DTEND:20250105T110000Z
END:VEVENT`),
    WINDOW,
  );
  assert.deepEqual(busy, []);
  assert.throws(() => parseIcsBusy('hello', WINDOW), /iCalendar/);
});
