import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { slotStartMs } from '../src/time.js';

// 2026-10-05(월) 00:00 KST 를 '현재'로 고정
const NOW = slotStartMs('2026-10-05', 0);
const MONDAY = '2026-10-05';

let server;
let baseUrl;
const googleCalls = [];

function mockFetch(url, init = {}) {
  const u = String(url);
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  if (u === 'https://oauth2.googleapis.com/token') {
    const params = new URLSearchParams(init.body);
    googleCalls.push(params.get('grant_type'));
    if (params.get('grant_type') === 'authorization_code') {
      return params.get('code') === 'good-code' ? json({ refresh_token: 'rt-1' }) : json({ error: 'invalid_grant' }, 400);
    }
    return json({ access_token: 'at-1' });
  }
  if (u.startsWith('https://www.googleapis.com/calendar/v3/users/me/calendarList')) {
    return json({ items: [{ id: 'primary@x', primary: true }, { id: 'hidden', selected: false }] });
  }
  if (u === 'https://www.googleapis.com/calendar/v3/freeBusy') {
    const body = JSON.parse(init.body);
    assert.deepEqual(body.items, [{ id: 'primary@x' }]);
    return json({
      calendars: {
        'primary@x': { busy: [{ start: '2026-10-07T05:00:00Z', end: '2026-10-07T06:00:00Z' }] }, // 수 14~15시 KST
      },
    });
  }
  if (u === 'https://cal.example.com/my.ics') {
    return new Response(
      'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:a\r\nDTSTART:20261006T190000\r\nDTEND:20261006T200000\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n',
    );
  }
  throw new Error(`unexpected fetch ${u}`);
}

before(async () => {
  const db = openDb(':memory:');
  const app = createApp({
    db,
    config: {
      baseUrl: 'http://localhost',
      googleClientId: 'cid',
      googleClientSecret: 'secret',
      fetch: mockFetch,
      lookup: async (host) => [{ address: host === 'internal.example.com' ? '10.0.0.5' : '93.184.216.34' }],
      now: () => NOW,
    },
  });
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

/** 쿠키를 기억하는 간단한 클라이언트 */
function client() {
  const jar = {};
  return {
    jar,
    async req(method, path, body, { raw = false } = {}) {
      const res = await fetch(baseUrl + path, {
        method,
        redirect: 'manual',
        headers: {
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          Cookie: Object.entries(jar)
            .map(([k, v]) => `${k}=${v}`)
            .join('; '),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      for (const c of res.headers.getSetCookie()) {
        const [pair, ...attrs] = c.split(';');
        const [k, v] = pair.split('=');
        if (attrs.some((a) => a.trim() === 'Max-Age=0')) delete jar[k];
        else jar[k] = v;
      }
      if (raw) return res;
      return { status: res.status, body: await res.json() };
    },
  };
}

async function signup(username, displayName) {
  const c = client();
  const r = await c.req('POST', '/api/auth/signup', { username, displayName, password: 'password123' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  c.id = r.body.user.id;
  return c;
}

test('회원가입/로그인/로그아웃', async () => {
  const c = await signup('alice', '앨리스');
  assert.equal((await c.req('GET', '/api/me')).body.user.username, 'alice');

  assert.equal((await client().req('POST', '/api/auth/signup', { username: 'alice', displayName: 'x', password: 'password123' })).status, 409);
  assert.equal((await client().req('POST', '/api/auth/signup', { username: 'A!', displayName: 'x', password: 'password123' })).status, 400);

  await c.req('POST', '/api/auth/logout', {});
  assert.equal((await c.req('GET', '/api/me')).status, 401);

  assert.equal((await c.req('POST', '/api/auth/login', { username: 'alice', password: 'wrong-password' })).status, 401);
  assert.equal((await c.req('POST', '/api/auth/login', { username: 'ALICE', password: 'password123' })).status, 200);
  assert.equal((await c.req('GET', '/api/me')).status, 200);
});

test('JSON이 아닌 쓰기 요청은 거부한다 (CSRF 방어)', async () => {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'username=alice&password=password123',
  });
  assert.equal(res.status, 415);
});

test('친구 요청 → 수락 → 비교 → 추천 시간', async () => {
  const bob = await signup('bob', '밥');
  const carol = await signup('carol', '캐롤');
  const dave = await signup('dave', '데이브');

  // 친구가 아니면 비교할 수 없다
  assert.equal((await bob.req('GET', `/api/compare?with=${carol.id}&start=${MONDAY}`)).status, 403);

  assert.equal((await bob.req('POST', '/api/friends', { username: 'carol' })).status, 201);
  assert.equal((await bob.req('POST', '/api/friends', { username: 'carol' })).status, 409);
  assert.equal((await bob.req('POST', '/api/friends', { username: 'bob' })).status, 400);
  assert.equal((await bob.req('POST', '/api/friends', { username: 'nobody' })).status, 404);

  const incoming = (await carol.req('GET', '/api/friends')).body.incoming;
  assert.equal(incoming.length, 1);
  assert.equal(incoming[0].username, 'bob');
  // 보낸 사람은 스스로 수락할 수 없다
  assert.equal((await bob.req('POST', `/api/friends/${incoming[0].friendshipId}/accept`, {})).status, 404);
  assert.equal((await carol.req('POST', `/api/friends/${incoming[0].friendshipId}/accept`, {})).status, 200);
  assert.deepEqual(
    (await bob.req('GET', '/api/friends')).body.friends.map((f) => f.username),
    ['carol'],
  );

  // 서로 요청하면 자동 수락
  await dave.req('POST', '/api/friends', { username: 'bob' });
  assert.equal((await bob.req('POST', '/api/friends', { username: 'dave' })).body.status, 'accepted');

  // 밥: 월요일 10~13시 아주 좋음 / 캐롤: 월요일 10~11시 좋음, 11~13시 애매함
  const wk = (weekday, from, to, level) =>
    Array.from({ length: to - from }, (_, i) => ({ weekday, slot: from + i, level }));
  assert.equal((await bob.req('PUT', '/api/weekly', { cells: wk(0, 20, 26, 5) })).status, 200);
  await carol.req('PUT', '/api/weekly', { cells: [...wk(0, 20, 22, 4), ...wk(0, 22, 26, 3)] });

  const r = await bob.req('GET', `/api/compare?with=${carol.id}&start=${MONDAY}&days=7`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.people.map((p) => p.displayName), ['밥', '캐롤']);
  assert.deepEqual(r.body.cells[MONDAY][20], { level: 4, levels: [5, 4] });
  assert.deepEqual(r.body.cells[MONDAY][24], { level: 3, levels: [5, 3] });
  assert.equal(r.body.cells[MONDAY][30].level, null);
  assert.deepEqual(
    r.body.suggestions.map((s) => [s.date, s.startSlot, s.endSlot, s.minLevel]),
    [
      [MONDAY, 20, 22, 4],
      [MONDAY, 20, 26, 3],
    ],
  );
  // 친구 쪽 응답에는 일정 출처(캘린더 등)가 노출되지 않는다
  assert.equal(r.body.cells[MONDAY][20].source, undefined);

  // 날짜별 덮어쓰기: 캐롤이 이번 월요일 10시를 '안 됨'으로 바꿈 → 지우면 원래대로
  await carol.req('PUT', '/api/overrides', { cells: [{ date: MONDAY, slot: 20, level: 1 }] });
  let s = (await carol.req('GET', `/api/schedule?start=${MONDAY}&days=1`)).body.cells[MONDAY];
  assert.deepEqual(s[20], { level: 1, source: 'override' });
  await carol.req('PUT', '/api/overrides', { cells: [{ date: MONDAY, slot: 20, level: null }] });
  s = (await carol.req('GET', `/api/schedule?start=${MONDAY}&days=1`)).body.cells[MONDAY];
  assert.deepEqual(s[20], { level: 4, source: 'weekly' });

  assert.equal((await bob.req('PUT', '/api/weekly', { cells: [{ weekday: 0, slot: 48, level: 1 }] })).status, 400);
  assert.equal((await bob.req('PUT', '/api/weekly', { cells: [{ weekday: 0, slot: 1, level: 6 }] })).status, 400);

  // 친구 끊기
  const fid = (await bob.req('GET', '/api/friends')).body.friends.find((f) => f.username === 'carol').friendshipId;
  assert.equal((await carol.req('DELETE', `/api/friends/${fid}`)).status, 200);
  assert.equal((await bob.req('GET', `/api/compare?with=${carol.id}`)).status, 403);
});

test('iCal 주소 / 파일 연동', async () => {
  const eve = await signup('eve', '이브');

  let r = await eve.req('POST', '/api/calendars', { kind: 'ics_url', url: 'webcal://cal.example.com/my.ics', busyLevel: 2 });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.calendar.url, 'https://cal.example.com/my.ics');

  // 내부망 주소는 거부
  r = await eve.req('POST', '/api/calendars', { kind: 'ics_url', url: 'http://internal.example.com/x.ics' });
  assert.equal(r.status, 400);
  r = await eve.req('POST', '/api/calendars', { kind: 'ics_url', url: 'http://127.0.0.1/x.ics' });
  assert.equal(r.status, 400);
  r = await eve.req('POST', '/api/calendars', { kind: 'ics_file', icsText: 'not a calendar' });
  assert.equal(r.status, 400);
  assert.equal((await eve.req('GET', '/api/calendars')).body.calendars.length, 1);

  r = await eve.req('POST', '/api/calendars', {
    kind: 'ics_file',
    name: '시간표',
    icsText:
      'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:b\r\nDTSTART:20261008T090000\r\nDTEND:20261008T100000\r\nEND:VEVENT\r\nEND:VCALENDAR',
  });
  assert.equal(r.status, 201);

  const s = (await eve.req('GET', `/api/schedule?start=${MONDAY}`)).body.cells;
  assert.deepEqual(s['2026-10-06'][38], { level: 2, source: 'calendar' }); // 화 19시, 주소 캘린더(웬만하면 안 됨)
  assert.deepEqual(s['2026-10-08'][18], { level: 1, source: 'calendar' }); // 목 9시, 파일 캘린더(안 됨)

  // 가능도 변경, 삭제
  const id = (await eve.req('GET', '/api/calendars')).body.calendars[0].id;
  assert.equal((await eve.req('PATCH', `/api/calendars/${id}`, { busyLevel: 3 })).body.calendar.busyLevel, 3);
  assert.equal((await eve.req('GET', `/api/schedule?start=${MONDAY}`)).body.cells['2026-10-06'][38].level, 3);
  assert.equal((await eve.req('DELETE', `/api/calendars/${id}`)).status, 200);
  assert.equal((await eve.req('GET', `/api/schedule?start=${MONDAY}`)).body.cells['2026-10-06'][38].level, null);

  // 남의 캘린더는 건드릴 수 없다
  const other = await signup('mallory', '맬러리');
  const fileId = (await eve.req('GET', '/api/calendars')).body.calendars[0].id;
  assert.equal((await other.req('DELETE', `/api/calendars/${fileId}`)).status, 404);
});

test('구글 캘린더 OAuth 연동', async () => {
  const gina = await signup('gina', '지나');

  const start = await gina.req('GET', '/api/google/connect', undefined, { raw: true });
  assert.equal(start.status, 302);
  const authUrl = new URL(start.headers.get('location'));
  assert.equal(authUrl.host, 'accounts.google.com');
  assert.equal(authUrl.searchParams.get('redirect_uri'), 'http://localhost/api/google/callback');
  const state = authUrl.searchParams.get('state');

  // state 가 다르면 거부
  let cb = await gina.req('GET', `/api/google/callback?code=good-code&state=wrong`, undefined, { raw: true });
  assert.equal(cb.headers.get('location'), '/#calendars?google=error');

  await gina.req('GET', '/api/google/connect', undefined, { raw: true });
  const state2 = gina.jar.eb_oauth_state;
  assert.notEqual(state2, state);
  cb = await gina.req('GET', `/api/google/callback?code=good-code&state=${state2}`, undefined, { raw: true });
  assert.equal(cb.headers.get('location'), '/#calendars?google=ok');

  const cals = (await gina.req('GET', '/api/calendars')).body.calendars;
  assert.equal(cals.length, 1);
  assert.equal(cals[0].kind, 'google');
  assert.equal(cals[0].refreshToken, undefined); // 토큰은 응답에 노출하지 않는다

  const s = (await gina.req('GET', `/api/schedule?start=${MONDAY}`)).body.cells['2026-10-07'];
  assert.deepEqual([s[27].level, s[28].level, s[29].level, s[30].level], [null, 1, 1, null]);
});
