// 미리보기판 전용: 서버 없이 브라우저 안에서 언제봄 API를 흉내 낸다.
// public/js/api.js 대신 이 파일이 들어가며(scripts/build-preview.mjs), 일정 계산은 서버와 같은 코드를 쓴다.
// 데이터는 이 브라우저(localStorage)에만 저장되므로 친구와 코드를 주고받는 기능은 실제 배포 후에만 된다.
import { buildSchedule, combineSchedules, suggestTimes, isLevel, isSlot, LEVELS } from '../src/availability.js';
import { isValidDate, mondayOf, todayKst, dateRange } from '../src/time.js';

window.EONJEBOM_PREVIEW = true;

const DB_KEY = 'eonjebom-preview:db';
const TOKEN_KEY = 'eonjebom:editToken';
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

// ───────────────────────── 저장소 ─────────────────────────

let memoryToken = null;
const memory = new Map();

function read(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return memory.get(key) ?? null;
  }
}

function write(key, value) {
  memory.set(key, value);
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // 메모리에만 보관 (탭을 닫으면 사라짐)
  }
}

export function getToken() {
  return read(TOKEN_KEY) ?? memoryToken;
}

export function setToken(token) {
  memoryToken = token;
  write(TOKEN_KEY, token);
}

// ───────────────────────── 예시 친구 ─────────────────────────

/** wd: 요일(0=월), from/to: 'HH:MM' (to 미포함) */
function block(weekly, days, from, to, level) {
  const slot = (t) => {
    const [h, m] = t.split(':').map(Number);
    return h * 2 + m / 30;
  };
  for (const wd of days) for (let s = slot(from); s < slot(to); s++) weekly[`${wd}:${s}`] = level;
}

function seedFriends() {
  const { FREE, MAYBE, BUSY } = LEVELS;
  const jiwoo = {};
  block(jiwoo, [0, 1, 2, 3, 4, 5, 6], '00:00', '08:00', BUSY);
  block(jiwoo, [0, 1, 2, 3, 4], '08:00', '09:00', MAYBE);
  block(jiwoo, [0, 2], '09:00', '12:00', BUSY); // 월·수 오전 수업
  block(jiwoo, [1, 3], '09:00', '12:00', FREE);
  block(jiwoo, [4], '09:00', '12:00', MAYBE);
  block(jiwoo, [0, 1, 2, 3, 4], '12:00', '13:00', FREE);
  block(jiwoo, [1, 3], '13:00', '18:00', BUSY); // 화·목 오후 수업
  block(jiwoo, [0, 2, 4], '13:00', '18:00', FREE);
  block(jiwoo, [0, 1, 2, 3], '18:00', '22:00', FREE);
  block(jiwoo, [4], '18:00', '22:00', MAYBE);
  block(jiwoo, [0, 1, 2, 3, 4, 5, 6], '22:00', '24:00', BUSY);
  block(jiwoo, [5], '08:00', '14:00', FREE);
  block(jiwoo, [5], '14:00', '17:00', MAYBE);
  block(jiwoo, [5], '17:00', '22:00', FREE);
  block(jiwoo, [6], '08:00', '22:00', FREE);

  const minsu = {};
  block(minsu, [0, 1, 2, 3, 4, 5, 6], '00:00', '09:00', BUSY);
  block(minsu, [0, 1, 2, 3, 4], '09:00', '13:00', MAYBE);
  block(minsu, [0, 2, 4], '13:00', '15:00', MAYBE);
  block(minsu, [1, 3], '13:00', '17:00', FREE);
  block(minsu, [0, 2, 4], '15:00', '22:00', FREE);
  block(minsu, [1, 3, 5], '17:00', '22:00', BUSY); // 화·목·토 저녁 알바
  block(minsu, [5], '09:00', '17:00', FREE);
  block(minsu, [6], '09:00', '22:00', FREE);
  block(minsu, [0, 1, 2, 3, 4, 5, 6], '22:00', '24:00', MAYBE);

  return {
    JW7K3NPA: { code: 'JW7K3NPA', name: '지우(예시)', token: null, weekly: jiwoo, overrides: {} },
    MN4R8TQE: { code: 'MN4R8TQE', name: '민수(예시)', token: null, weekly: minsu, overrides: {} },
  };
}

function loadDb() {
  try {
    const db = JSON.parse(read(DB_KEY) ?? 'null');
    if (db && typeof db.profiles === 'object') return db;
  } catch {
    // 손상된 데이터면 새로 시작
  }
  return { profiles: seedFriends() };
}

const db = loadDb();
const saveDb = () => write(DB_KEY, JSON.stringify(db));

// 처음 열면 예시 친구가 '같이 볼 사람' 목록에 들어 있도록 한다.
if (read('eonjebom:friends') === null) {
  write(
    'eonjebom:friends',
    JSON.stringify([
      { code: 'JW7K3NPA', name: '지우(예시)' },
      { code: 'MN4R8TQE', name: '민수(예시)' },
    ]),
  );
}

// 미리보기 표시 띠
const ribbon = document.createElement('div');
ribbon.className = 'preview-ribbon';
ribbon.textContent = '미리보기 · 데이터는 이 브라우저에만 저장돼요 · 코드 공유와 캘린더 연동은 실제 배포 후에 돼요';
document.body.prepend(ribbon);

// ───────────────────────── 가짜 API ─────────────────────────

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const fail = (status, message) => {
  throw new ApiError(status, message);
};

function randomString(alphabet, length) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

function me() {
  const token = getToken();
  const p = token && Object.values(db.profiles).find((x) => x.token === token);
  if (!p) fail(401, '내 시간표를 찾을 수 없어요.');
  return p;
}

function byCode(input) {
  const code = String(input ?? '')
    .toUpperCase()
    .replace(/[\s-]/g, '');
  return db.profiles[code] ?? fail(404, `코드 ${code} 를 찾을 수 없어요. 예시 친구 코드: JW7K-3NPA, MN4R-8TQE`);
}

function parseName(value) {
  const name = String(value ?? '').trim();
  if (name.length < 1 || name.length > 20) fail(400, '이름은 1~20자로 적어 주세요.');
  return name;
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && value !== null && value !== '' ? Math.min(max, Math.max(min, n)) : fallback;
}

function range(q) {
  const start = q.get('start') ?? mondayOf(todayKst());
  if (!isValidDate(start)) fail(400, 'start는 YYYY-MM-DD 형식이어야 합니다.');
  return dateRange(start, clampInt(q.get('days'), 1, 14, 7));
}

function schedule(p, dates) {
  return buildSchedule({
    dates,
    weekly: new Map(Object.entries(p.weekly)),
    overrides: new Map(Object.entries(p.overrides)),
    busy: [],
  });
}

function applyCells(target, cells, keyOf) {
  if (!Array.isArray(cells)) fail(400, 'cells 배열이 필요합니다.');
  for (const c of cells) {
    const key = c ? keyOf(c) : null; // 요일 0(월)도 올바른 값이므로 null 로만 판단
    if (key === null || !isSlot(c.slot) || !(c.level === null || isLevel(c.level))) fail(400, '잘못된 칸 정보가 있어요.');
    if (c.level === null) delete target[`${key}:${c.slot}`];
    else target[`${key}:${c.slot}`] = c.level;
  }
  saveDb();
  return { ok: true };
}

const NO_CALENDAR = '미리보기에서는 캘린더를 연동할 수 없어요. 실제 배포 후에 쓸 수 있어요.';

function handle(method, url, body) {
  const { pathname, searchParams: q } = new URL(url, 'https://preview.local');
  const route = `${method} ${pathname}`;

  if (route === 'POST /api/profiles') {
    const name = parseName(body.name);
    let code;
    do code = randomString(CODE_ALPHABET, 8);
    while (db.profiles[code]);
    const token = randomString('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789', 43);
    db.profiles[code] = { code, name, token, weekly: {}, overrides: {} };
    saveDb();
    return { profile: { name, code }, editToken: token };
  }
  if (route === 'GET /api/me') return { profile: { name: me().name, code: me().code }, googleEnabled: false };
  if (route === 'PATCH /api/me') {
    const p = me();
    p.name = parseName(body.name);
    saveDb();
    return { profile: { name: p.name, code: p.code } };
  }
  if (route === 'DELETE /api/me') {
    delete db.profiles[me().code];
    saveDb();
    return { ok: true };
  }
  if (route === 'POST /api/me/edit-token') fail(400, '미리보기에서는 수정 링크를 쓸 수 없어요.');
  if (method === 'GET' && pathname.startsWith('/api/profiles/')) {
    const p = byCode(decodeURIComponent(pathname.slice('/api/profiles/'.length)));
    return { profile: { name: p.name, code: p.code } };
  }

  if (route === 'GET /api/weekly') {
    return {
      cells: Object.entries(me().weekly).map(([k, level]) => {
        const [weekday, slot] = k.split(':').map(Number);
        return { weekday, slot, level };
      }),
    };
  }
  if (route === 'PUT /api/weekly') {
    return applyCells(me().weekly, body.cells, (c) =>
      Number.isInteger(c.weekday) && c.weekday >= 0 && c.weekday <= 6 ? c.weekday : null,
    );
  }
  if (route === 'PUT /api/overrides') return applyCells(me().overrides, body.cells, (c) => (isValidDate(c.date) ? c.date : null));
  if (route === 'GET /api/schedule') {
    const dates = range(q);
    return { dates, cells: schedule(me(), dates) };
  }

  if (route === 'GET /api/compare') {
    const self = me();
    const inputs = [...new Set((q.get('codes') ?? '').split(',').filter(Boolean))];
    if (inputs.length === 0) fail(400, '같이 볼 사람의 코드를 넣어 주세요.');
    const others = [];
    for (const input of inputs) {
      const p = byCode(input);
      if (p !== self && !others.includes(p)) others.push(p);
    }
    const dates = range(q);
    const people = [self, ...others];
    const combined = combineSchedules(
      dates,
      people.map((p) => schedule(p, dates)),
    );
    return {
      dates,
      people: people.map((p) => ({ name: p.name, code: p.code, isMe: p === self })),
      cells: combined,
      suggestions: suggestTimes(dates, combined, {
        minSlots: clampInt(q.get('minSlots'), 1, 48, 2),
        minLevel: clampInt(q.get('minLevel'), LEVELS.MAYBE, LEVELS.FREE, LEVELS.MAYBE),
        notBefore: Date.now(),
      }),
    };
  }

  if (route === 'GET /api/calendars') {
    me();
    return { calendars: [], googleEnabled: false };
  }
  if (pathname.startsWith('/api/calendars') || pathname.startsWith('/api/google')) fail(400, NO_CALENDAR);

  return fail(404, '없는 API입니다.');
}

async function request(method, path, body) {
  // 실제 서버처럼 응답을 비동기로 돌려주고, 데이터는 복사본을 넘겨 화면 쪽 수정이 저장소에 새지 않게 한다.
  await Promise.resolve();
  return structuredClone(handle(method, path, body ?? {}));
}

export const api = {
  get: (path) => request('GET', path),
  post: (path, body = {}) => request('POST', path, body),
  put: (path, body) => request('PUT', path, body),
  patch: (path, body) => request('PATCH', path, body),
  del: (path) => request('DELETE', path),
};
