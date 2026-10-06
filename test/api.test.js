import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createApp, deleteInactiveProfiles } from '../src/app.js';
import { normalizeShareCode, CODE_ALPHABET } from '../src/auth.js';
import { slotStartMs } from '../src/time.js';

// 2026-10-05(월) 00:00 KST 를 '현재'로 고정
let NOW = slotStartMs('2026-10-05', 0);
const MONDAY = '2026-10-05';

let server;
let baseUrl;
let db;

function mockFetch(url, init = {}) {
  const u = String(url);
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  if (u === 'https://oauth2.googleapis.com/token') {
    const params = new URLSearchParams(init.body);
    if (params.get('grant_type') === 'authorization_code') {
      return params.get('code') === 'good-code' ? json({ refresh_token: 'rt-1' }) : json({ error: 'invalid_grant' }, 400);
    }
    return json({ access_token: 'at-1' });
  }
  if (u.startsWith('https://www.googleapis.com/calendar/v3/users/me/calendarList')) {
    return json({ items: [{ id: 'primary@x', primary: true }, { id: 'hidden', selected: false }] });
  }
  if (u === 'https://www.googleapis.com/calendar/v3/freeBusy') {
    assert.deepEqual(JSON.parse(init.body).items, [{ id: 'primary@x' }]);
    return json({
      calendars: { 'primary@x': { busy: [{ start: '2026-10-07T05:00:00Z', end: '2026-10-07T06:00:00Z' }] } }, // 수 14~15시 KST
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
  db = openDb(':memory:');
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

/** token 이 있으면 Authorization 헤더로 보낸다. 쿠키도 기억한다(구글 OAuth state 용). */
function client(token = null) {
  const jar = {};
  const c = {
    token,
    jar,
    async req(method, path, body, { raw = false, headers = {} } = {}) {
      const res = await fetch(baseUrl + path, {
        method,
        redirect: 'manual',
        headers: {
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(c.token ? { Authorization: `Bearer ${c.token}` } : {}),
          Cookie: Object.entries(jar)
            .map(([k, v]) => `${k}=${v}`)
            .join('; '),
          ...headers,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      for (const ck of res.headers.getSetCookie()) {
        const [pair, ...attrs] = ck.split(';');
        const [k, v] = pair.split('=');
        if (attrs.some((a) => a.trim() === 'Max-Age=0')) delete jar[k];
        else jar[k] = v;
      }
      if (raw) return res;
      return { status: res.status, body: await res.json() };
    },
  };
  return c;
}

async function newProfile(name) {
  const c = client();
  const r = await c.req('POST', '/api/profiles', { name });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  c.token = r.body.editToken;
  c.code = r.body.profile.code;
  return c;
}

test('공유 코드 형식', () => {
  assert.equal(normalizeShareCode('k7qm-3xpa'), 'K7QM3XPA');
  assert.equal(normalizeShareCode(' K7QM 3XPA '), 'K7QM3XPA');
  assert.equal(normalizeShareCode('K7QM3XP0'), null); // 0 은 쓰지 않는 글자
  assert.equal(normalizeShareCode('K7QM3XP'), null);
  for (const ch of '01ILO') assert.ok(!CODE_ALPHABET.includes(ch));
});

test('로그인 없이 시간표 만들기 / 이름 바꾸기 / 수정 링크 재발급 / 삭제', async () => {
  const me = await newProfile('한민');
  assert.match(me.code, /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/);
  assert.equal((await me.req('GET', '/api/me')).body.profile.name, '한민');

  // 토큰이 없거나 틀리면 수정할 수 없다
  assert.equal((await client().req('GET', '/api/me')).status, 401);
  assert.equal((await client('wrong-token-wrong-token-xx').req('GET', '/api/weekly')).status, 401);
  assert.equal((await client().req('POST', '/api/profiles', { name: '' })).status, 400);

  assert.equal((await me.req('PATCH', '/api/me', { name: '최한민' })).body.profile.name, '최한민');

  // 수정 링크를 새로 만들면 이전 토큰은 더 이상 동작하지 않는다
  const old = me.token;
  const { editToken } = (await me.req('POST', '/api/me/edit-token', {})).body;
  assert.notEqual(editToken, old);
  assert.equal((await client(old).req('GET', '/api/me')).status, 401);
  me.token = editToken;
  assert.equal((await me.req('GET', '/api/me')).status, 200);

  assert.equal((await me.req('DELETE', '/api/me')).status, 200);
  assert.equal((await me.req('GET', '/api/me')).status, 401);
  assert.equal((await client().req('GET', `/api/profiles/${me.code}`)).status, 404);
});

test('코드로 비교 → 추천 시간 (여러 명)', async () => {
  const a = await newProfile('에이');
  const b = await newProfile('비');
  const c = await newProfile('씨');

  // 코드 확인: 하이픈·소문자 입력도 받는다
  const pretty = `${b.code.slice(0, 4)}-${b.code.slice(4)}`.toLowerCase();
  assert.deepEqual((await client().req('GET', `/api/profiles/${pretty}`)).body.profile, { name: '비', code: b.code });

  const wk = (weekday, from, to, level) => Array.from({ length: to - from }, (_, i) => ({ weekday, slot: from + i, level }));
  // 에이: 월 10~13시 한가함 / 비: 월 10~11시 한가함, 11~13시 잘 모르겠음 / 씨: 월 12시~ 바쁨
  assert.equal((await a.req('PUT', '/api/weekly', { cells: wk(0, 20, 26, 3) })).status, 200);
  await b.req('PUT', '/api/weekly', { cells: [...wk(0, 20, 22, 3), ...wk(0, 22, 26, 2)] });
  await c.req('PUT', '/api/weekly', { cells: [...wk(0, 20, 24, 3), ...wk(0, 24, 26, 1)] });

  let r = await a.req('GET', `/api/compare?codes=${pretty}&start=${MONDAY}&days=7`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(
    r.body.people,
    [
      { name: '에이', code: a.code, isMe: true },
      { name: '비', code: b.code, isMe: false },
    ],
  );
  assert.deepEqual(r.body.cells[MONDAY][20], { level: 3, levels: [3, 3] });
  assert.deepEqual(r.body.cells[MONDAY][24], { level: 2, levels: [3, 2] });
  assert.equal(r.body.cells[MONDAY][30].level, null);
  assert.deepEqual(
    r.body.suggestions.map((s) => [s.date, s.startSlot, s.endSlot, s.minLevel]),
    [
      [MONDAY, 20, 22, 3],
      [MONDAY, 20, 26, 2],
    ],
  );
  // 다른 사람 쪽 응답에는 일정 출처(캘린더 등)나 내부 id가 노출되지 않는다
  assert.equal(r.body.cells[MONDAY][20].source, undefined);
  assert.equal(r.body.people[1].id, undefined);

  // 세 명: 씨가 12시부터 바빠서 10~12시만 남는다. 내 코드나 중복 코드는 무시
  r = await a.req('GET', `/api/compare?codes=${b.code},${c.code},${a.code},${c.code}&start=${MONDAY}`);
  assert.equal(r.body.people.length, 3);
  assert.deepEqual(
    r.body.suggestions.map((s) => [s.startSlot, s.endSlot, s.minLevel]),
    [
      [20, 22, 3],
      [20, 24, 2],
    ],
  );

  // 비교하려면 내 시간표가 있어야 하고, 없는 코드는 404
  assert.equal((await client().req('GET', `/api/compare?codes=${b.code}`)).status, 401);
  assert.equal((await a.req('GET', '/api/compare?codes=ZZZZZZZZ')).status, 404);
  assert.equal((await a.req('GET', '/api/compare')).status, 400);

  // 코드만으로는 남의 시간표를 고칠 수 없다 (수정 토큰이 필요)
  assert.equal((await client(b.code).req('PUT', '/api/weekly', { cells: wk(0, 0, 1, 1) })).status, 401);

  // 날짜별 덮어쓰기: 비가 이번 월요일 10시를 바쁨으로 → 지우면 원래대로
  await b.req('PUT', '/api/overrides', { cells: [{ date: MONDAY, slot: 20, level: 1 }] });
  let s = (await b.req('GET', `/api/schedule?start=${MONDAY}&days=1`)).body.cells[MONDAY];
  assert.deepEqual(s[20], { level: 1, source: 'override' });
  await b.req('PUT', '/api/overrides', { cells: [{ date: MONDAY, slot: 20, level: null }] });
  s = (await b.req('GET', `/api/schedule?start=${MONDAY}&days=1`)).body.cells[MONDAY];
  assert.deepEqual(s[20], { level: 3, source: 'weekly' });

  // 3단계 범위를 벗어난 값은 거부
  assert.equal((await a.req('PUT', '/api/weekly', { cells: [{ weekday: 0, slot: 1, level: 4 }] })).status, 400);
  assert.equal((await a.req('PUT', '/api/weekly', { cells: [{ weekday: 0, slot: 48, level: 1 }] })).status, 400);
});

test('없는 코드를 계속 넣으면 맞는 코드도 잠시 막힌다', async () => {
  const me = await newProfile('대입');
  const target = await newProfile('대상');
  let last;
  for (let i = 0; i < 31; i++) last = await me.req('GET', `/api/profiles/ZZZZZZZ${CODE_ALPHABET[i]}`);
  assert.equal(last.status, 429);
  assert.equal((await me.req('GET', `/api/profiles/${target.code}`)).status, 429);
  NOW += 11 * 60 * 1000; // 10분 지나면 풀린다
  assert.equal((await me.req('GET', `/api/profiles/${target.code}`)).status, 200);
});

test('iCal 주소 / 파일 연동', async () => {
  const eve = await newProfile('이브');
  const start = MONDAY;

  let r = await eve.req('POST', '/api/calendars', { kind: 'ics_url', url: 'webcal://cal.example.com/my.ics', busyLevel: 2 });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.calendar.url, 'https://cal.example.com/my.ics');

  // 내부망 주소, 잘못된 파일은 거부
  assert.equal((await eve.req('POST', '/api/calendars', { kind: 'ics_url', url: 'http://internal.example.com/x.ics' })).status, 400);
  assert.equal((await eve.req('POST', '/api/calendars', { kind: 'ics_url', url: 'http://127.0.0.1/x.ics' })).status, 400);
  assert.equal((await eve.req('POST', '/api/calendars', { kind: 'ics_file', icsText: 'not a calendar' })).status, 400);
  assert.equal((await eve.req('POST', '/api/calendars', { kind: 'ics_file', icsText: 'x', busyLevel: 4 })).status, 400);
  assert.equal((await eve.req('GET', '/api/calendars')).body.calendars.length, 1);

  r = await eve.req('POST', '/api/calendars', {
    kind: 'ics_file',
    name: '시간표',
    icsText: 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:b\r\nDTSTART:20261008T090000\r\nDTEND:20261008T100000\r\nEND:VEVENT\r\nEND:VCALENDAR',
  });
  assert.equal(r.status, 201);

  const s = (await eve.req('GET', `/api/schedule?start=${start}`)).body.cells;
  assert.deepEqual(s['2026-10-06'][38], { level: 2, source: 'calendar' }); // 화 19시, 주소 캘린더(잘 모르겠음)
  assert.deepEqual(s['2026-10-08'][18], { level: 1, source: 'calendar' }); // 목 9시, 파일 캘린더(바쁨)

  const id = (await eve.req('GET', '/api/calendars')).body.calendars[0].id;
  assert.equal((await eve.req('PATCH', `/api/calendars/${id}`, { busyLevel: 1 })).body.calendar.busyLevel, 1);
  assert.equal((await eve.req('GET', `/api/schedule?start=${start}`)).body.cells['2026-10-06'][38].level, 1);
  assert.equal((await eve.req('DELETE', `/api/calendars/${id}`)).status, 200);
  assert.equal((await eve.req('GET', `/api/schedule?start=${start}`)).body.cells['2026-10-06'][38].level, null);

  // 남의 캘린더는 건드릴 수 없다
  const other = await newProfile('맬러리');
  const fileId = (await eve.req('GET', '/api/calendars')).body.calendars[0].id;
  assert.equal((await other.req('DELETE', `/api/calendars/${fileId}`)).status, 404);
});

test('구글 캘린더 OAuth 연동', async () => {
  const gina = await newProfile('지나');

  const start = await gina.req('POST', '/api/google/start', {});
  assert.equal(start.status, 200);
  const authUrl = new URL(start.body.url);
  assert.equal(authUrl.host, 'accounts.google.com');
  assert.equal(authUrl.searchParams.get('redirect_uri'), 'http://localhost/api/google/callback');
  const state = authUrl.searchParams.get('state');
  assert.equal(gina.jar.eb_oauth_state, state);

  // 다른 브라우저(쿠키 없음)에서 같은 state 로 돌아오면 거부 → 남의 구글 캘린더를 내 시간표에 붙이는 공격 방지
  const stranger = client();
  let cb = await stranger.req('GET', `/api/google/callback?code=good-code&state=${state}`, undefined, { raw: true });
  assert.equal(cb.headers.get('location'), '/#calendars?google=error');
  // 한 번 쓰인 state 는 다시 쓸 수 없다
  cb = await gina.req('GET', `/api/google/callback?code=good-code&state=${state}`, undefined, { raw: true });
  assert.equal(cb.headers.get('location'), '/#calendars?google=error');

  const again = await gina.req('POST', '/api/google/start', {});
  const state2 = new URL(again.body.url).searchParams.get('state');
  cb = await gina.req('GET', `/api/google/callback?code=good-code&state=${state2}`, undefined, { raw: true });
  assert.equal(cb.headers.get('location'), '/#calendars?google=ok');

  const cals = (await gina.req('GET', '/api/calendars')).body.calendars;
  assert.equal(cals.length, 1);
  assert.equal(cals[0].kind, 'google');
  assert.equal(cals[0].refreshToken, undefined); // 토큰은 응답에 노출하지 않는다

  const s = (await gina.req('GET', `/api/schedule?start=${MONDAY}`)).body.cells['2026-10-07'];
  assert.deepEqual([s[27].level, s[28].level, s[29].level, s[30].level], [null, 1, 1, null]);
});

test('90일 동안 쓰지 않은 시간표는 지워진다', async () => {
  const keep = await newProfile('계속씀');
  const gone = await newProfile('안씀');
  await gone.req('PUT', '/api/weekly', { cells: [{ weekday: 0, slot: 0, level: 3 }] });

  NOW += 80 * 24 * 60 * 60 * 1000;
  await keep.req('GET', '/api/me'); // 접속하면 마지막 사용 시각이 갱신된다
  NOW += 20 * 24 * 60 * 60 * 1000;

  const removed = deleteInactiveProfiles(db, NOW);
  assert.ok(removed >= 1);
  assert.equal((await keep.req('GET', '/api/me')).status, 200);
  assert.equal((await gone.req('GET', '/api/me')).status, 401);
  // 지워진 시간표의 칸도 함께 지워진다
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM weekly_slots WHERE profile_id NOT IN (SELECT id FROM profiles)').get().n, 0);
});
