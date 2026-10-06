import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeShareCode, decodeShareCode, findShareCode } from '../src/share-code.js';
import { createStore } from '../src/store.js';
import { slotStartMs } from '../src/time.js';

// 2026-10-05(월) 09:00 KST 를 '현재'로 고정
const NOW = slotStartMs('2026-10-05', 18);
const MONDAY = '2026-10-05';

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k), map: m };
}

let seq = 0;
const ids = () => ['aaaa0001', 'bbbb0002', 'cccc0003', 'dddd0004', 'eeee0005', 'ffff0006'][seq++ % 6];

test('시간표 코드: 인코딩 → 디코딩이 그대로 돌아온다', () => {
  const weekly = Array.from({ length: 336 }, (_, i) => [null, 1, 2, 3][Math.floor(i / 7) % 4]);
  const window = Array.from({ length: 21 * 48 }, (_, i) => (i % 97 < 40 ? 3 : i % 5 === 0 ? null : 1));
  const code = encodeShareCode({ id: '0a1b2c3d', name: '최한민🙂', weekly, windowStart: MONDAY, window });
  assert.match(code, /^EB2\.[A-Za-z0-9_-]+$/);
  const d = decodeShareCode(`카톡 메시지\n${code}\n끝`);
  assert.deepEqual(d, { id: '0a1b2c3d', name: '최한민🙂', weekly, windowStart: MONDAY, window });
});

test('시간표 코드: 보통 시간표는 카톡으로 보낼 만한 길이다', () => {
  const store = createStore(memoryStorage(), { now: () => NOW, randomId: ids });
  store.start('한민');
  const wk = (weekday, from, to, level) => Array.from({ length: to - from }, (_, i) => ({ weekday, slot: from + i, level }));
  for (let d = 0; d < 7; d++) {
    store.setWeekly([
      ...wk(d, 0, 16, 1),
      ...wk(d, 16, 18, 2),
      ...wk(d, 18, 24, d < 5 ? 1 : 3),
      ...wk(d, 24, 36, 3),
      ...wk(d, 36, 48, 2),
    ]);
  }
  const code = store.shareCode();
  assert.ok(code.length < 100, `코드 길이 ${code.length}`);
});

test('시간표 코드: 기본 시간표와 다른 날만 따로 담고, 예전(v1) 코드도 읽는다', () => {
  // 실제로 받은 v1 코드 (175자)
  const v1 =
    'EB1.ATnP3DwG7LGE7JuQUPsVF8sBRxJCA8sBQoBDEkIDywFHGcsBRwHuAO4A7hjLAUcSQgPLAUKAQxJCA8sBRxnLAUcB7gDuAO4YywFHEkIDywFCgEMSQgPLAUcZywFHAe4A7gDuGMsBRxJCA8sBQoBDEkIDywFHGcsBRwHuAO4A7gA';
  const d = decodeShareCode(v1);
  assert.equal(d.name, '채원');
  assert.equal(d.window.length, 21 * 48);
  const v2 = encodeShareCode(d);
  assert.ok(v2.length < 80, `v2 길이 ${v2.length}`);
  assert.deepEqual(decodeShareCode(v2), d);

  // 하루만 다르면(날짜별 수정) 그 날만 더 담긴다
  const window = [...d.window];
  window[2 * 48 + 20] = 1; // 수요일 10시
  const withChange = encodeShareCode({ ...d, window });
  assert.deepEqual(decodeShareCode(withChange).window, window);
  assert.ok(withChange.length < v2.length + 20);
});

test('시간표 코드: 잘린 코드나 다른 글은 알기 쉬운 오류를 낸다', () => {
  const code = encodeShareCode({
    id: '0a1b2c3d',
    name: 'x',
    weekly: Array(336).fill(3),
    windowStart: MONDAY,
    window: Array(48).fill(null),
  });
  assert.throws(() => decodeShareCode(code.slice(0, -3)), /잘렸거나/);
  assert.throws(() => decodeShareCode('안녕'), /찾지 못했어요/);
  assert.equal(findShareCode(`보냄: ${code}.`), code);
});

test('서버 없이: 시작 → 칠하기 → 코드 주고받기 → 비교', () => {
  const aStore = createStore(memoryStorage(), { now: () => NOW, randomId: ids });
  const bStore = createStore(memoryStorage(), { now: () => NOW, randomId: ids });
  aStore.start('한민');
  bStore.start('지우');
  const wk = (weekday, from, to, level) => Array.from({ length: to - from }, (_, i) => ({ weekday, slot: from + i, level }));

  // 한민: 월 10~13시 한가함 / 지우: 월 10~11시 한가함, 11~13시 잘 모르겠음
  aStore.setWeekly(wk(0, 20, 26, 3));
  bStore.setWeekly([...wk(0, 20, 22, 3), ...wk(0, 22, 26, 2)]);
  // 지우는 이번 월요일 12:30을 직접 바쁨으로 (코드의 3주 기간에 반영돼야 함)
  bStore.setOverrides([{ date: MONDAY, slot: 25, level: 1 }]);

  const added = aStore.addFriend(`지우가 보냄: ${bStore.shareCode()}`);
  assert.deepEqual(added, { id: bStore.me.id, name: '지우', updated: false });
  assert.equal(aStore.friends()[0].validUntil, '2026-10-25');

  const r = aStore.compare([added.id], MONDAY);
  assert.deepEqual(
    r.people.map((p) => p.name),
    ['한민', '지우'],
  );
  assert.deepEqual(r.cells[MONDAY][20], { level: 3, levels: [3, 3] });
  assert.deepEqual(r.cells[MONDAY][24], { level: 2, levels: [3, 2] });
  assert.deepEqual(r.cells[MONDAY][25], { level: 1, levels: [3, 1] });
  assert.deepEqual(
    r.suggestions.map((s) => [s.date, s.startSlot, s.endSlot, s.minLevel]),
    [
      [MONDAY, 20, 22, 3],
      [MONDAY, 20, 25, 2],
    ],
  );

  // 코드 기간(3주) 밖의 날짜는 기본 시간표를 쓴다 → 4주 뒤 월요일 12:30은 다시 잘 모르겠음
  const later = aStore.compare([added.id], '2026-11-02');
  assert.deepEqual(later.cells['2026-11-02'][25], { level: 2, levels: [3, 2] });

  // 같은 사람이 새 코드를 보내면 바뀐다
  bStore.setWeekly(wk(0, 20, 26, 1));
  assert.equal(aStore.addFriend(bStore.shareCode()).updated, true);
  assert.equal(aStore.friends().length, 1);
  assert.equal(aStore.compare([added.id], MONDAY).cells[MONDAY][20].level, 1);

  // 내 코드는 친구로 추가할 수 없다
  assert.throws(() => aStore.addFriend(aStore.shareCode()), /내 코드/);
});

test('캘린더 파일 가져오기와 데이터 유지', () => {
  const storage = memoryStorage();
  const store = createStore(storage, { now: () => NOW, randomId: ids });
  store.start('이브');
  const { events } = store.importCalendar({
    name: '수업',
    busyLevel: 2,
    icsText:
      'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:a\r\nDTSTART:20261006T190000\r\nDTEND:20261006T200000\r\nRRULE:FREQ=WEEKLY;COUNT=3\r\nEND:VEVENT\r\nEND:VCALENDAR',
  });
  assert.equal(events, 3);
  assert.deepEqual(store.schedule(MONDAY).cells['2026-10-06'][38], { level: 2, source: 'calendar' });
  assert.throws(() => store.importCalendar({ icsText: 'nope' }), /iCalendar/);

  // 새로 열어도(같은 저장소) 그대로 남아 있다
  const reopened = createStore(storage, { now: () => NOW });
  assert.equal(reopened.me.name, '이브');
  const [cal] = reopened.calendars();
  reopened.setCalendarLevel(cal.id, 1);
  assert.equal(reopened.schedule(MONDAY).cells['2026-10-06'][38].level, 1);
  reopened.removeCalendar(cal.id);
  assert.equal(reopened.schedule(MONDAY).cells['2026-10-06'][38].level, null);

  // 다른 기기로 옮기기: 내 코드로 기본 시간표를 되살린다
  reopened.setWeekly([{ weekday: 2, slot: 30, level: 3 }]);
  const other = createStore(memoryStorage(), { now: () => NOW });
  other.restoreFromCode(reopened.shareCode());
  assert.equal(other.me.name, '이브');
  assert.deepEqual(other.weeklyCells(), [{ weekday: 2, slot: 30, level: 3 }]);

  reopened.deleteAll();
  assert.equal(createStore(storage).me, null);
});
