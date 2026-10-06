import express from 'express';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { transaction } from './db.js';
import {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  hashPassword,
  verifyPassword,
  createSession,
  findSessionUser,
  deleteSession,
  parseCookies,
  createRateLimiter,
} from './auth.js';
import { buildSchedule, combineSchedules, suggestTimes, isLevel, isSlot } from './availability.js';
import { isValidDate, mondayOf, todayKst, dateRange, dayStartMs, DAY_MS } from './time.js';
import { syncSource } from './calendars.js';
import { parseIcsBusy } from './ics.js';
import { normalizeCalendarUrl } from './safe-fetch.js';
import { googleEnabled, buildAuthUrl, exchangeCode } from './google.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url));
const OAUTH_STATE_COOKIE = 'eb_oauth_state';
const MAX_CALENDARS_PER_USER = 10;
const MAX_COMPARE_FRIENDS = 10;
const MAX_CELLS_PER_REQUEST = 48 * 7 * 14;

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const USERNAME_RE = /^[a-z0-9_]{3,20}$/;

/**
 * @param {object} deps
 * @param {import('node:sqlite').DatabaseSync} deps.db
 * @param {object} deps.config
 * @param {string} deps.config.baseUrl
 * @param {boolean} [deps.config.secureCookies]
 * @param {string} [deps.config.googleClientId]
 * @param {string} [deps.config.googleClientSecret]
 * @param {typeof fetch} [deps.config.fetch]
 * @param {Function} [deps.config.lookup]
 * @param {() => number} [deps.config.now]
 */
export function createApp({ db, config }) {
  config = { fetch: globalThis.fetch, now: Date.now, ...config };
  const app = express();
  const loginLimiter = createRateLimiter({ max: 10, windowMs: 10 * 60 * 1000 });

  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy ?? false);

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'same-origin',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'",
    });
    next();
  });

  app.use(express.static(PUBLIC_DIR));
  app.use(express.json({ limit: '6mb' }));

  // CSRF 방어: 다른 사이트가 사전 확인(CORS preflight) 없이 보낼 수 있는 쓰기 요청은 <form>의 POST뿐이고,
  // <form>은 JSON을 보낼 수 없으므로 POST는 JSON만 받는다. (PUT/PATCH/DELETE는 교차 출처 시 항상 preflight 대상)
  app.use('/api', (req, res, next) => {
    if (req.method === 'POST' && !req.is('application/json')) {
      return next(new HttpError(415, 'Content-Type은 application/json 이어야 합니다.'));
    }
    req.body ??= {};
    next();
  });

  app.use((req, res, next) => {
    const cookies = parseCookies(req.headers.cookie);
    req.cookies = cookies;
    req.user = findSessionUser(db, cookies[SESSION_COOKIE], config.now());
    next();
  });

  const cookieFlags = `Path=/; HttpOnly; SameSite=Lax${config.secureCookies ? '; Secure' : ''}`;

  function setSessionCookie(res, token) {
    res.append('Set-Cookie', `${SESSION_COOKIE}=${token}; ${cookieFlags}; Max-Age=${SESSION_TTL_MS / 1000}`);
  }

  function requireUser(req, res, next) {
    if (!req.user) return next(new HttpError(401, '로그인이 필요합니다.'));
    next();
  }

  // ───────────────────────── 계정 ─────────────────────────

  app.post('/api/auth/signup', (req, res) => {
    const username = String(req.body.username ?? '').trim().toLowerCase();
    const displayName = String(req.body.displayName ?? '').trim();
    const password = String(req.body.password ?? '');
    if (!USERNAME_RE.test(username)) {
      throw new HttpError(400, '아이디는 영문 소문자, 숫자, 밑줄(_)로 3~20자여야 합니다.');
    }
    if (displayName.length < 1 || displayName.length > 20) throw new HttpError(400, '이름은 1~20자여야 합니다.');
    if (password.length < 8 || password.length > 200) throw new HttpError(400, '비밀번호는 8자 이상이어야 합니다.');
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) {
      throw new HttpError(409, '이미 사용 중인 아이디입니다.');
    }
    const { lastInsertRowid } = db
      .prepare('INSERT INTO users (username, display_name, password_hash, created_at) VALUES (?, ?, ?, ?)')
      .run(username, displayName, hashPassword(password), config.now());
    setSessionCookie(res, createSession(db, Number(lastInsertRowid), config.now()));
    res.status(201).json({ user: { id: Number(lastInsertRowid), username, displayName } });
  });

  app.post('/api/auth/login', (req, res) => {
    const username = String(req.body.username ?? '').trim().toLowerCase();
    const password = String(req.body.password ?? '');
    if (loginLimiter.tooMany(`${req.ip}:${username}`, config.now())) {
      throw new HttpError(429, '로그인 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.');
    }
    const row = db.prepare('SELECT id, username, display_name, password_hash FROM users WHERE username = ?').get(username);
    if (!row || !verifyPassword(password, row.password_hash)) {
      throw new HttpError(401, '아이디 또는 비밀번호가 올바르지 않습니다.');
    }
    setSessionCookie(res, createSession(db, row.id, config.now()));
    res.json({ user: { id: row.id, username: row.username, displayName: row.display_name } });
  });

  app.post('/api/auth/logout', (req, res) => {
    deleteSession(db, req.cookies[SESSION_COOKIE]);
    res.append('Set-Cookie', `${SESSION_COOKIE}=; ${cookieFlags}; Max-Age=0`);
    res.json({ ok: true });
  });

  app.get('/api/me', requireUser, (req, res) => {
    res.json({ user: req.user, googleEnabled: googleEnabled(config) });
  });

  // ───────────────────────── 내 시간표 ─────────────────────────

  app.get('/api/weekly', requireUser, (req, res) => {
    const rows = db.prepare('SELECT weekday, slot, level FROM weekly_slots WHERE user_id = ?').all(req.user.id);
    res.json({ cells: rows.map((r) => ({ ...r })) });
  });

  /** 칠한 칸만 부분 업데이트한다. level이 null이면 지운다. */
  app.put('/api/weekly', requireUser, (req, res) => {
    const cells = validateCells(req.body.cells, (c) => Number.isInteger(c.weekday) && c.weekday >= 0 && c.weekday <= 6);
    transaction(db, () => {
      const upsert = db.prepare(
        `INSERT INTO weekly_slots (user_id, weekday, slot, level) VALUES (?, ?, ?, ?)
         ON CONFLICT (user_id, weekday, slot) DO UPDATE SET level = excluded.level`,
      );
      const remove = db.prepare('DELETE FROM weekly_slots WHERE user_id = ? AND weekday = ? AND slot = ?');
      for (const c of cells) {
        if (c.level === null) remove.run(req.user.id, c.weekday, c.slot);
        else upsert.run(req.user.id, c.weekday, c.slot, c.level);
      }
    });
    res.json({ ok: true });
  });

  app.put('/api/overrides', requireUser, (req, res) => {
    const cells = validateCells(req.body.cells, (c) => isValidDate(c.date));
    transaction(db, () => {
      const upsert = db.prepare(
        `INSERT INTO date_slots (user_id, date, slot, level) VALUES (?, ?, ?, ?)
         ON CONFLICT (user_id, date, slot) DO UPDATE SET level = excluded.level`,
      );
      const remove = db.prepare('DELETE FROM date_slots WHERE user_id = ? AND date = ? AND slot = ?');
      for (const c of cells) {
        if (c.level === null) remove.run(req.user.id, c.date, c.slot);
        else upsert.run(req.user.id, c.date, c.slot, c.level);
      }
    });
    res.json({ ok: true });
  });

  app.get('/api/schedule', requireUser, (req, res) => {
    const dates = parseRange(req.query, config.now());
    res.json({ dates, cells: loadSchedule(db, req.user.id, dates) });
  });

  // ───────────────────────── 친구 ─────────────────────────

  app.get('/api/friends', requireUser, (req, res) => {
    const rows = db
      .prepare(
        `SELECT f.id AS friendshipId, f.status, f.requester_id AS requesterId,
                u.id, u.username, u.display_name AS displayName
           FROM friendships f
           JOIN users u ON u.id = CASE WHEN f.requester_id = ? THEN f.addressee_id ELSE f.requester_id END
          WHERE f.requester_id = ? OR f.addressee_id = ?
          ORDER BY u.display_name`,
      )
      .all(req.user.id, req.user.id, req.user.id);
    const pick = ({ friendshipId, id, username, displayName }) => ({ friendshipId, id, username, displayName });
    res.json({
      friends: rows.filter((r) => r.status === 'accepted').map(pick),
      incoming: rows.filter((r) => r.status === 'pending' && r.requesterId !== req.user.id).map(pick),
      outgoing: rows.filter((r) => r.status === 'pending' && r.requesterId === req.user.id).map(pick),
    });
  });

  app.post('/api/friends', requireUser, (req, res) => {
    const username = String(req.body.username ?? '').trim().toLowerCase();
    const other = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (!other) throw new HttpError(404, '그런 아이디를 가진 사용자가 없습니다.');
    if (other.id === req.user.id) throw new HttpError(400, '자기 자신에게는 친구 요청을 보낼 수 없습니다.');

    const pairKey = [req.user.id, other.id].sort((a, b) => a - b).join(':');
    const existing = db.prepare('SELECT id, status, requester_id FROM friendships WHERE pair_key = ?').get(pairKey);
    if (existing?.status === 'accepted') throw new HttpError(409, '이미 친구입니다.');
    if (existing?.requester_id === req.user.id) throw new HttpError(409, '이미 친구 요청을 보냈습니다.');
    if (existing) {
      // 상대가 먼저 요청을 보냈었다면 바로 수락 처리
      db.prepare("UPDATE friendships SET status = 'accepted' WHERE id = ?").run(existing.id);
      return res.json({ status: 'accepted' });
    }
    db.prepare(
      "INSERT INTO friendships (requester_id, addressee_id, status, created_at, pair_key) VALUES (?, ?, 'pending', ?, ?)",
    ).run(req.user.id, other.id, config.now(), pairKey);
    res.status(201).json({ status: 'pending' });
  });

  app.post('/api/friends/:id/accept', requireUser, (req, res) => {
    const { changes } = db
      .prepare("UPDATE friendships SET status = 'accepted' WHERE id = ? AND addressee_id = ? AND status = 'pending'")
      .run(Number(req.params.id), req.user.id);
    if (!changes) throw new HttpError(404, '친구 요청을 찾을 수 없습니다.');
    res.json({ ok: true });
  });

  /** 요청 거절 / 보낸 요청 취소 / 친구 끊기 */
  app.delete('/api/friends/:id', requireUser, (req, res) => {
    const { changes } = db
      .prepare('DELETE FROM friendships WHERE id = ? AND (requester_id = ? OR addressee_id = ?)')
      .run(Number(req.params.id), req.user.id, req.user.id);
    if (!changes) throw new HttpError(404, '친구 관계를 찾을 수 없습니다.');
    res.json({ ok: true });
  });

  // ───────────────────────── 언제봄 (비교) ─────────────────────────

  app.get('/api/compare', requireUser, (req, res) => {
    const ids = [...new Set(String(req.query.with ?? '').split(',').filter(Boolean).map(Number))];
    if (ids.length === 0) throw new HttpError(400, '비교할 친구를 한 명 이상 골라 주세요.');
    if (ids.length > MAX_COMPARE_FRIENDS) throw new HttpError(400, `한 번에 ${MAX_COMPARE_FRIENDS}명까지 비교할 수 있습니다.`);

    const isFriend = db.prepare(
      `SELECT u.id, u.display_name AS displayName FROM friendships f JOIN users u ON u.id = ?
        WHERE f.pair_key = ? AND f.status = 'accepted'`,
    );
    const friends = ids.map((id) => {
      const row = Number.isInteger(id) && id !== req.user.id && isFriend.get(id, [req.user.id, id].sort((a, b) => a - b).join(':'));
      if (!row) throw new HttpError(403, '친구로 등록된 사람의 시간표만 볼 수 있습니다.');
      return { ...row };
    });

    const dates = parseRange(req.query, config.now());
    const people = [{ id: req.user.id, displayName: req.user.displayName, isMe: true }, ...friends];
    const combined = combineSchedules(
      dates,
      people.map((p) => loadSchedule(db, p.id, dates)),
    );
    const minSlots = clampInt(req.query.minSlots, 1, 48, 2);
    const minLevel = clampInt(req.query.minLevel, 1, 5, 3);
    res.json({
      dates,
      people,
      cells: combined,
      suggestions: suggestTimes(dates, combined, { minSlots, minLevel, notBefore: config.now() }),
    });
  });

  // ───────────────────────── 캘린더 연동 ─────────────────────────

  const sourceFields = `id, kind, name, url, busy_level AS busyLevel, last_synced_at AS lastSyncedAt,
    last_error AS lastError, created_at AS createdAt`;

  function getOwnSource(userId, id) {
    const row = db.prepare('SELECT * FROM calendar_sources WHERE id = ? AND user_id = ?').get(Number(id), userId);
    if (!row) throw new HttpError(404, '캘린더를 찾을 수 없습니다.');
    return row;
  }

  function publicSource(id) {
    return { ...db.prepare(`SELECT ${sourceFields} FROM calendar_sources WHERE id = ?`).get(id) };
  }

  function assertCalendarQuota(userId) {
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM calendar_sources WHERE user_id = ?').get(userId);
    if (n >= MAX_CALENDARS_PER_USER) throw new HttpError(400, `캘린더는 ${MAX_CALENDARS_PER_USER}개까지 연동할 수 있습니다.`);
  }

  app.get('/api/calendars', requireUser, (req, res) => {
    const rows = db.prepare(`SELECT ${sourceFields} FROM calendar_sources WHERE user_id = ? ORDER BY id`).all(req.user.id);
    res.json({ calendars: rows.map((r) => ({ ...r })), googleEnabled: googleEnabled(config) });
  });

  app.post('/api/calendars', requireUser, async (req, res) => {
    assertCalendarQuota(req.user.id);
    const kind = req.body.kind;
    const busyLevel = req.body.busyLevel === undefined ? 1 : req.body.busyLevel;
    if (!isLevel(busyLevel)) throw new HttpError(400, '일정 시간의 가능도 값이 올바르지 않습니다.');
    let url = null;
    let icsText = null;
    let name = String(req.body.name ?? '').trim().slice(0, 40);

    if (kind === 'ics_url') {
      try {
        url = normalizeCalendarUrl(req.body.url).href;
      } catch (err) {
        throw new HttpError(400, err.message);
      }
      name ||= new URL(url).hostname;
    } else if (kind === 'ics_file') {
      icsText = String(req.body.icsText ?? '');
      try {
        parseIcsBusy(icsText, { from: 0, to: 1 });
      } catch (err) {
        throw new HttpError(400, err.message);
      }
      name ||= '가져온 캘린더 파일';
    } else {
      throw new HttpError(400, "kind는 'ics_url' 또는 'ics_file' 이어야 합니다.");
    }

    const { lastInsertRowid } = db
      .prepare(
        `INSERT INTO calendar_sources (user_id, kind, name, url, ics_text, busy_level, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(req.user.id, kind, name, url, icsText, busyLevel, config.now());
    const id = Number(lastInsertRowid);
    const error = await syncSource(db, getOwnSource(req.user.id, id), config, config.now());
    if (error) {
      db.prepare('DELETE FROM calendar_sources WHERE id = ?').run(id);
      throw new HttpError(400, error);
    }
    res.status(201).json({ calendar: publicSource(id) });
  });

  app.patch('/api/calendars/:id', requireUser, (req, res) => {
    const source = getOwnSource(req.user.id, req.params.id);
    const name = req.body.name === undefined ? source.name : String(req.body.name).trim().slice(0, 40) || source.name;
    const busyLevel = req.body.busyLevel === undefined ? source.busy_level : req.body.busyLevel;
    if (!isLevel(busyLevel)) throw new HttpError(400, '일정 시간의 가능도 값이 올바르지 않습니다.');
    db.prepare('UPDATE calendar_sources SET name = ?, busy_level = ? WHERE id = ?').run(name, busyLevel, source.id);
    res.json({ calendar: publicSource(source.id) });
  });

  app.post('/api/calendars/:id/sync', requireUser, async (req, res) => {
    const source = getOwnSource(req.user.id, req.params.id);
    const error = await syncSource(db, source, config, config.now());
    res.status(error ? 502 : 200).json({ calendar: publicSource(source.id), error });
  });

  app.delete('/api/calendars/:id', requireUser, (req, res) => {
    const source = getOwnSource(req.user.id, req.params.id);
    db.prepare('DELETE FROM calendar_sources WHERE id = ?').run(source.id);
    res.json({ ok: true });
  });

  // 구글 캘린더 OAuth. 브라우저가 직접 이동하는 GET 요청이므로 실패 시 화면으로 되돌려 보낸다.
  app.get('/api/google/connect', (req, res) => {
    if (!req.user) return res.redirect('/');
    if (!googleEnabled(config)) return res.redirect('/#calendars?google=disabled');
    const state = randomBytes(24).toString('base64url');
    res.append('Set-Cookie', `${OAUTH_STATE_COOKIE}=${state}; ${cookieFlags}; Max-Age=600`);
    res.redirect(buildAuthUrl(config, state));
  });

  app.get('/api/google/callback', async (req, res) => {
    res.append('Set-Cookie', `${OAUTH_STATE_COOKIE}=; ${cookieFlags}; Max-Age=0`);
    const expected = req.cookies[OAUTH_STATE_COOKIE];
    if (!req.user || !googleEnabled(config) || !expected || req.query.state !== expected || !req.query.code) {
      return res.redirect('/#calendars?google=error');
    }
    try {
      assertCalendarQuota(req.user.id);
      const refreshToken = await exchangeCode(config, String(req.query.code));
      const { lastInsertRowid } = db
        .prepare(
          `INSERT INTO calendar_sources (user_id, kind, name, refresh_token, created_at)
           VALUES (?, 'google', '구글 캘린더', ?, ?)`,
        )
        .run(req.user.id, refreshToken, config.now());
      const error = await syncSource(db, getOwnSource(req.user.id, Number(lastInsertRowid)), config, config.now());
      res.redirect(`/#calendars?google=${error ? 'error' : 'ok'}`);
    } catch (err) {
      console.error('[google] 연결 실패:', err.message);
      res.redirect('/#calendars?google=error');
    }
  });

  // ───────────────────────── 오류 처리 ─────────────────────────

  app.use('/api', (req, res, next) => next(new HttpError(404, '없는 API입니다.')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.too.large') err = new HttpError(413, '요청이 너무 큽니다.');
    if (err.type === 'entity.parse.failed') err = new HttpError(400, 'JSON 형식이 올바르지 않습니다.');
    if (!(err instanceof HttpError)) {
      console.error(err);
      err = new HttpError(500, '서버 오류가 발생했습니다.');
    }
    res.status(err.status).json({ error: err.message });
  });

  return app;
}

// ───────────────────────── 헬퍼 ─────────────────────────

function validateCells(cells, keyIsValid) {
  if (!Array.isArray(cells) || cells.length > MAX_CELLS_PER_REQUEST) {
    throw new HttpError(400, 'cells 배열이 필요합니다.');
  }
  for (const c of cells) {
    if (!c || !keyIsValid(c) || !isSlot(c.slot) || !(c.level === null || isLevel(c.level))) {
      throw new HttpError(400, '잘못된 칸 정보가 있습니다.');
    }
  }
  return cells;
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  return Number.isInteger(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function parseRange(query, now) {
  const start = query.start === undefined ? mondayOf(todayKst(now)) : String(query.start);
  if (!isValidDate(start)) throw new HttpError(400, 'start는 YYYY-MM-DD 형식이어야 합니다.');
  return dateRange(start, clampInt(query.days, 1, 14, 7));
}

/** 한 사용자의 날짜별 실제 가능도를 DB에서 읽어 계산한다. */
export function loadSchedule(db, userId, dates) {
  const weekly = new Map(
    db
      .prepare('SELECT weekday, slot, level FROM weekly_slots WHERE user_id = ?')
      .all(userId)
      .map((r) => [`${r.weekday}:${r.slot}`, r.level]),
  );
  const overrides = new Map(
    db
      .prepare('SELECT date, slot, level FROM date_slots WHERE user_id = ? AND date BETWEEN ? AND ?')
      .all(userId, dates[0], dates[dates.length - 1])
      .map((r) => [`${r.date}:${r.slot}`, r.level]),
  );
  const from = dayStartMs(dates[0]);
  const to = dayStartMs(dates[dates.length - 1]) + DAY_MS;
  const busy = db
    .prepare(
      `SELECT b.start_ms AS start, b.end_ms AS end, s.busy_level AS level
         FROM calendar_busy b JOIN calendar_sources s ON s.id = b.source_id
        WHERE b.user_id = ? AND b.end_ms > ? AND b.start_ms < ?`,
    )
    .all(userId, from, to);
  return buildSchedule({ dates, weekly, overrides, busy });
}
