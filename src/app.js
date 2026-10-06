import express from 'express';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { transaction } from './db.js';
import {
  generateShareCode,
  normalizeShareCode,
  generateEditToken,
  hashToken,
  parseCookies,
  createRateLimiter,
} from './auth.js';
import { buildSchedule, combineSchedules, suggestTimes, isLevel, isSlot, LEVELS } from './availability.js';
import { isValidDate, mondayOf, todayKst, dateRange, dayStartMs, DAY_MS } from './time.js';
import { syncSource } from './calendars.js';
import { parseIcsBusy } from './ics.js';
import { normalizeCalendarUrl } from './safe-fetch.js';
import { googleEnabled, buildAuthUrl, exchangeCode } from './google.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url));
const OAUTH_STATE_COOKIE = 'eb_oauth_state';
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const MAX_CALENDARS_PER_PROFILE = 10;
const MAX_COMPARE_CODES = 10;
const MAX_CELLS_PER_REQUEST = 48 * 7 * 14;
const TOUCH_INTERVAL_MS = 60 * 60 * 1000;
export const PROFILE_RETENTION_MS = 90 * DAY_MS;

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

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
  // 없는 코드를 계속 넣어 보는 무작위 대입, 시간표 대량 생성을 막는다.
  const codeMissLimiter = createRateLimiter({ max: 30, windowMs: 10 * 60 * 1000 });
  const createLimiter = createRateLimiter({ max: 20, windowMs: 60 * 60 * 1000 });

  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy ?? false);

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'",
    });
    next();
  });

  app.get('/healthz', (req, res) => res.type('text').send('ok'));
  app.use(express.static(PUBLIC_DIR));
  app.use(express.json({ limit: '6mb' }));

  app.use('/api', (req, res, next) => {
    if (req.method === 'POST' && !req.is('application/json')) {
      return next(new HttpError(415, 'Content-Type은 application/json 이어야 합니다.'));
    }
    req.body ??= {};
    next();
  });

  // 수정 권한은 'Authorization: Bearer <수정 토큰>' 헤더로 확인한다.
  // 쿠키가 아니라 헤더이므로 다른 사이트에서 몰래 요청을 보내는 CSRF 걱정이 없다.
  app.use((req, res, next) => {
    req.cookies = parseCookies(req.headers.cookie);
    const m = /^Bearer ([\w-]{20,100})$/.exec(req.headers.authorization ?? '');
    req.profile = m ? findProfileByToken(m[1]) : null;
    next();
  });

  function findProfileByToken(token) {
    const row = db
      .prepare('SELECT id, share_code AS code, name, created_at AS createdAt, last_active_at FROM profiles WHERE edit_token_hash = ?')
      .get(hashToken(token));
    if (!row) return null;
    const now = config.now();
    if (row.last_active_at < now - TOUCH_INTERVAL_MS) {
      db.prepare('UPDATE profiles SET last_active_at = ? WHERE id = ?').run(now, row.id);
    }
    return { id: row.id, code: row.code, name: row.name, createdAt: row.createdAt };
  }

  function requireProfile(req, res, next) {
    if (!req.profile) return next(new HttpError(401, '내 시간표를 찾을 수 없어요. 수정 링크로 다시 들어와 주세요.'));
    next();
  }

  const publicProfile = (p) => ({ name: p.name, code: p.code });

  function parseName(value) {
    const name = String(value ?? '').trim();
    if (name.length < 1 || name.length > 20) throw new HttpError(400, '이름은 1~20자로 적어 주세요.');
    return name;
  }

  /** 공유 코드로 다른 사람의 시간표를 찾는다. 없는 코드를 너무 많이 넣으면 잠시 막는다. */
  function findByCode(req, input) {
    // 한도를 넘으면 맞는 코드도 막는다. (아니면 404/429 차이로 계속 맞혀 볼 수 있음)
    if (codeMissLimiter.blocked(req.ip, config.now())) {
      throw new HttpError(429, '잘못된 코드를 너무 많이 입력했어요. 잠시 후 다시 시도해 주세요.');
    }
    const code = normalizeShareCode(input);
    const row = code && db.prepare('SELECT id, share_code AS code, name FROM profiles WHERE share_code = ?').get(code);
    if (!row) {
      codeMissLimiter.tooMany(req.ip, config.now());
      throw new HttpError(404, `코드 ${String(input ?? '').toUpperCase().slice(0, 20)} 를 찾을 수 없어요.`);
    }
    return { ...row };
  }

  // ───────────────────────── 내 시간표 (프로필) ─────────────────────────

  /** 새 시간표 만들기. 응답의 editToken 은 이때 한 번만 내려준다. */
  app.post('/api/profiles', (req, res) => {
    if (createLimiter.tooMany(req.ip, config.now())) {
      throw new HttpError(429, '잠시 후 다시 시도해 주세요.');
    }
    const name = parseName(req.body.name);
    const editToken = generateEditToken();
    const now = config.now();
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = generateShareCode();
      try {
        db.prepare(
          'INSERT INTO profiles (share_code, edit_token_hash, name, created_at, last_active_at) VALUES (?, ?, ?, ?, ?)',
        ).run(code, hashToken(editToken), name, now, now);
        return res.status(201).json({ profile: { name, code }, editToken });
      } catch (err) {
        if (!String(err.message).includes('UNIQUE')) throw err; // 코드가 겹치면 다시 뽑는다
      }
    }
    throw new HttpError(500, '코드를 만들지 못했어요. 다시 시도해 주세요.');
  });

  app.get('/api/me', requireProfile, (req, res) => {
    res.json({ profile: publicProfile(req.profile), googleEnabled: googleEnabled(config) });
  });

  app.patch('/api/me', requireProfile, (req, res) => {
    const name = parseName(req.body.name);
    db.prepare('UPDATE profiles SET name = ? WHERE id = ?').run(name, req.profile.id);
    res.json({ profile: { ...publicProfile(req.profile), name } });
  });

  /** 수정 링크를 새로 만든다. 이전 링크와 다른 기기의 수정 권한은 더 이상 동작하지 않는다. */
  app.post('/api/me/edit-token', requireProfile, (req, res) => {
    const editToken = generateEditToken();
    db.prepare('UPDATE profiles SET edit_token_hash = ? WHERE id = ?').run(hashToken(editToken), req.profile.id);
    res.json({ editToken });
  });

  app.delete('/api/me', requireProfile, (req, res) => {
    db.prepare('DELETE FROM profiles WHERE id = ?').run(req.profile.id);
    res.json({ ok: true });
  });

  /** 코드 확인 (친구 코드를 목록에 추가할 때 이름을 보여 주기 위함) */
  app.get('/api/profiles/:code', (req, res) => {
    res.json({ profile: publicProfile(findByCode(req, req.params.code)) });
  });

  // ───────────────────────── 내 일정 편집 ─────────────────────────

  app.get('/api/weekly', requireProfile, (req, res) => {
    const rows = db.prepare('SELECT weekday, slot, level FROM weekly_slots WHERE profile_id = ?').all(req.profile.id);
    res.json({ cells: rows.map((r) => ({ ...r })) });
  });

  /** 칠한 칸만 부분 업데이트한다. level이 null이면 지운다. */
  app.put('/api/weekly', requireProfile, (req, res) => {
    const cells = validateCells(req.body.cells, (c) => Number.isInteger(c.weekday) && c.weekday >= 0 && c.weekday <= 6);
    transaction(db, () => {
      const upsert = db.prepare(
        `INSERT INTO weekly_slots (profile_id, weekday, slot, level) VALUES (?, ?, ?, ?)
         ON CONFLICT (profile_id, weekday, slot) DO UPDATE SET level = excluded.level`,
      );
      const remove = db.prepare('DELETE FROM weekly_slots WHERE profile_id = ? AND weekday = ? AND slot = ?');
      for (const c of cells) {
        if (c.level === null) remove.run(req.profile.id, c.weekday, c.slot);
        else upsert.run(req.profile.id, c.weekday, c.slot, c.level);
      }
    });
    res.json({ ok: true });
  });

  app.put('/api/overrides', requireProfile, (req, res) => {
    const cells = validateCells(req.body.cells, (c) => isValidDate(c.date));
    transaction(db, () => {
      const upsert = db.prepare(
        `INSERT INTO date_slots (profile_id, date, slot, level) VALUES (?, ?, ?, ?)
         ON CONFLICT (profile_id, date, slot) DO UPDATE SET level = excluded.level`,
      );
      const remove = db.prepare('DELETE FROM date_slots WHERE profile_id = ? AND date = ? AND slot = ?');
      for (const c of cells) {
        if (c.level === null) remove.run(req.profile.id, c.date, c.slot);
        else upsert.run(req.profile.id, c.date, c.slot, c.level);
      }
    });
    res.json({ ok: true });
  });

  app.get('/api/schedule', requireProfile, (req, res) => {
    const dates = parseRange(req.query, config.now());
    res.json({ dates, cells: loadSchedule(db, req.profile.id, dates) });
  });

  // ───────────────────────── 언제봄 (코드로 비교) ─────────────────────────

  app.get('/api/compare', requireProfile, (req, res) => {
    const inputs = [...new Set(String(req.query.codes ?? '').split(',').map((c) => c.trim()).filter(Boolean))];
    if (inputs.length === 0) throw new HttpError(400, '같이 볼 사람의 코드를 넣어 주세요.');
    if (inputs.length > MAX_COMPARE_CODES) throw new HttpError(400, `한 번에 ${MAX_COMPARE_CODES}명까지 비교할 수 있어요.`);

    const others = [];
    for (const input of inputs) {
      const p = findByCode(req, input);
      if (p.id !== req.profile.id && !others.some((o) => o.id === p.id)) others.push(p);
    }

    const dates = parseRange(req.query, config.now());
    const people = [{ ...req.profile, isMe: true }, ...others];
    const combined = combineSchedules(
      dates,
      people.map((p) => loadSchedule(db, p.id, dates)),
    );
    const minSlots = clampInt(req.query.minSlots, 1, 48, 2);
    const minLevel = clampInt(req.query.minLevel, LEVELS.MAYBE, LEVELS.FREE, LEVELS.MAYBE);
    res.json({
      dates,
      people: people.map((p) => ({ ...publicProfile(p), isMe: Boolean(p.isMe) })),
      cells: combined,
      suggestions: suggestTimes(dates, combined, { minSlots, minLevel, notBefore: config.now() }),
    });
  });

  // ───────────────────────── 캘린더 연동 ─────────────────────────

  const sourceFields = `id, kind, name, url, busy_level AS busyLevel, last_synced_at AS lastSyncedAt,
    last_error AS lastError, created_at AS createdAt`;

  function getOwnSource(profileId, id) {
    const row = db.prepare('SELECT * FROM calendar_sources WHERE id = ? AND profile_id = ?').get(Number(id), profileId);
    if (!row) throw new HttpError(404, '캘린더를 찾을 수 없어요.');
    return row;
  }

  function publicSource(id) {
    return { ...db.prepare(`SELECT ${sourceFields} FROM calendar_sources WHERE id = ?`).get(id) };
  }

  function assertCalendarQuota(profileId) {
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM calendar_sources WHERE profile_id = ?').get(profileId);
    if (n >= MAX_CALENDARS_PER_PROFILE) throw new HttpError(400, `캘린더는 ${MAX_CALENDARS_PER_PROFILE}개까지 연동할 수 있어요.`);
  }

  app.get('/api/calendars', requireProfile, (req, res) => {
    const rows = db.prepare(`SELECT ${sourceFields} FROM calendar_sources WHERE profile_id = ? ORDER BY id`).all(req.profile.id);
    res.json({ calendars: rows.map((r) => ({ ...r })), googleEnabled: googleEnabled(config) });
  });

  app.post('/api/calendars', requireProfile, async (req, res) => {
    assertCalendarQuota(req.profile.id);
    const kind = req.body.kind;
    const busyLevel = req.body.busyLevel === undefined ? LEVELS.BUSY : req.body.busyLevel;
    if (!isLevel(busyLevel)) throw new HttpError(400, '일정 시간의 표시 값이 올바르지 않아요.');
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
        `INSERT INTO calendar_sources (profile_id, kind, name, url, ics_text, busy_level, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(req.profile.id, kind, name, url, icsText, busyLevel, config.now());
    const id = Number(lastInsertRowid);
    const error = await syncSource(db, getOwnSource(req.profile.id, id), config, config.now());
    if (error) {
      db.prepare('DELETE FROM calendar_sources WHERE id = ?').run(id);
      throw new HttpError(400, error);
    }
    res.status(201).json({ calendar: publicSource(id) });
  });

  app.patch('/api/calendars/:id', requireProfile, (req, res) => {
    const source = getOwnSource(req.profile.id, req.params.id);
    const name = req.body.name === undefined ? source.name : String(req.body.name).trim().slice(0, 40) || source.name;
    const busyLevel = req.body.busyLevel === undefined ? source.busy_level : req.body.busyLevel;
    if (!isLevel(busyLevel)) throw new HttpError(400, '일정 시간의 표시 값이 올바르지 않아요.');
    db.prepare('UPDATE calendar_sources SET name = ?, busy_level = ? WHERE id = ?').run(name, busyLevel, source.id);
    res.json({ calendar: publicSource(source.id) });
  });

  app.post('/api/calendars/:id/sync', requireProfile, async (req, res) => {
    const source = getOwnSource(req.profile.id, req.params.id);
    const error = await syncSource(db, source, config, config.now());
    res.status(error ? 502 : 200).json({ calendar: publicSource(source.id), error });
  });

  app.delete('/api/calendars/:id', requireProfile, (req, res) => {
    const source = getOwnSource(req.profile.id, req.params.id);
    db.prepare('DELETE FROM calendar_sources WHERE id = ?').run(source.id);
    res.json({ ok: true });
  });

  // 구글 캘린더 OAuth.
  // 1) 앱이 POST /api/google/start 로 인증 주소를 받아 이동한다. 이때 state 를 DB(누구의 시간표인지)와
  //    쿠키(같은 브라우저인지)에 함께 남긴다.
  // 2) 구글이 /api/google/callback 으로 돌려보내면 두 값을 모두 확인한 뒤 연결한다.
  app.post('/api/google/start', requireProfile, (req, res) => {
    if (!googleEnabled(config)) throw new HttpError(400, '이 서버에는 구글 연동이 설정되어 있지 않아요.');
    assertCalendarQuota(req.profile.id);
    const state = randomBytes(24).toString('base64url');
    const now = config.now();
    db.prepare('DELETE FROM oauth_states WHERE expires_at < ?').run(now);
    db.prepare('INSERT INTO oauth_states (state, profile_id, expires_at) VALUES (?, ?, ?)').run(
      state,
      req.profile.id,
      now + OAUTH_STATE_TTL_MS,
    );
    res.append('Set-Cookie', `${OAUTH_STATE_COOKIE}=${state}; ${cookieFlags()}; Max-Age=${OAUTH_STATE_TTL_MS / 1000}`);
    res.json({ url: buildAuthUrl(config, state) });
  });

  app.get('/api/google/callback', async (req, res) => {
    res.append('Set-Cookie', `${OAUTH_STATE_COOKIE}=; ${cookieFlags()}; Max-Age=0`);
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const row =
      state && req.cookies[OAUTH_STATE_COOKIE] === state
        ? db.prepare('SELECT profile_id FROM oauth_states WHERE state = ? AND expires_at > ?').get(state, config.now())
        : null;
    if (state) db.prepare('DELETE FROM oauth_states WHERE state = ?').run(state);
    if (!row || !googleEnabled(config) || typeof req.query.code !== 'string') {
      return res.redirect('/#calendars?google=error');
    }
    try {
      assertCalendarQuota(row.profile_id);
      const refreshToken = await exchangeCode(config, req.query.code);
      const { lastInsertRowid } = db
        .prepare(
          `INSERT INTO calendar_sources (profile_id, kind, name, refresh_token, created_at)
           VALUES (?, 'google', '구글 캘린더', ?, ?)`,
        )
        .run(row.profile_id, refreshToken, config.now());
      const error = await syncSource(db, getOwnSource(row.profile_id, Number(lastInsertRowid)), config, config.now());
      res.redirect(`/#calendars?google=${error ? 'error' : 'ok'}`);
    } catch (err) {
      console.error('[google] 연결 실패:', err.message);
      res.redirect('/#calendars?google=error');
    }
  });

  function cookieFlags() {
    return `Path=/api/google; HttpOnly; SameSite=Lax${config.secureCookies ? '; Secure' : ''}`;
  }

  // ───────────────────────── 오류 처리 ─────────────────────────

  app.use('/api', (req, res, next) => next(new HttpError(404, '없는 API입니다.')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.too.large') err = new HttpError(413, '요청이 너무 커요.');
    if (err.type === 'entity.parse.failed') err = new HttpError(400, 'JSON 형식이 올바르지 않아요.');
    if (!(err instanceof HttpError)) {
      console.error(err);
      err = new HttpError(500, '서버 오류가 발생했어요.');
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
      throw new HttpError(400, '잘못된 칸 정보가 있어요.');
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

/** 오래 쓰지 않은 시간표를 지운다. (연결된 일정·캘린더도 함께 삭제됨) */
export function deleteInactiveProfiles(db, now = Date.now()) {
  return Number(db.prepare('DELETE FROM profiles WHERE last_active_at < ?').run(now - PROFILE_RETENTION_MS).changes);
}

/** 한 사람의 날짜별 실제 가능도를 DB에서 읽어 계산한다. */
export function loadSchedule(db, profileId, dates) {
  const weekly = new Map(
    db
      .prepare('SELECT weekday, slot, level FROM weekly_slots WHERE profile_id = ?')
      .all(profileId)
      .map((r) => [`${r.weekday}:${r.slot}`, r.level]),
  );
  const overrides = new Map(
    db
      .prepare('SELECT date, slot, level FROM date_slots WHERE profile_id = ? AND date BETWEEN ? AND ?')
      .all(profileId, dates[0], dates[dates.length - 1])
      .map((r) => [`${r.date}:${r.slot}`, r.level]),
  );
  const from = dayStartMs(dates[0]);
  const to = dayStartMs(dates[dates.length - 1]) + DAY_MS;
  const busy = db
    .prepare(
      `SELECT b.start_ms AS start, b.end_ms AS end, s.busy_level AS level
         FROM calendar_busy b JOIN calendar_sources s ON s.id = b.source_id
        WHERE b.profile_id = ? AND b.end_ms > ? AND b.start_ms < ?`,
    )
    .all(profileId, from, to);
  return buildSchedule({ dates, weekly, overrides, busy });
}
