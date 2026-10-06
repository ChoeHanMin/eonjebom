import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA_VERSION = 2;

// v1(계정·친구 방식)에서 쓰던 테이블. v2로 올릴 때 지운다.
const V1_TABLES = ['calendar_busy', 'calendar_sources', 'date_slots', 'weekly_slots', 'friendships', 'sessions', 'users'];

const SCHEMA = `
PRAGMA foreign_keys = ON;

-- 로그인 없이 쓰는 '내 시간표'. share_code 는 친구에게 공유하는 보기 전용 코드,
-- edit_token_hash 는 수정 권한(브라우저/수정 링크에 저장된 토큰)의 해시.
CREATE TABLE IF NOT EXISTS profiles (
  id              INTEGER PRIMARY KEY,
  share_code      TEXT    NOT NULL UNIQUE,
  edit_token_hash TEXT    NOT NULL UNIQUE,
  name            TEXT    NOT NULL,
  created_at      INTEGER NOT NULL,
  last_active_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS profiles_last_active ON profiles (last_active_at);

-- 매주 반복되는 기본 시간표. weekday 0 = 월요일. level 1 = 바쁨, 2 = 잘 모르겠음, 3 = 한가함
CREATE TABLE IF NOT EXISTS weekly_slots (
  profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  weekday    INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  slot       INTEGER NOT NULL CHECK (slot BETWEEN 0 AND 47),
  level      INTEGER NOT NULL CHECK (level BETWEEN 1 AND 3),
  PRIMARY KEY (profile_id, weekday, slot)
);

-- 특정 날짜에 직접 칠한 값. 기본 시간표와 캘린더 일정보다 우선한다.
CREATE TABLE IF NOT EXISTS date_slots (
  profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  date       TEXT    NOT NULL,
  slot       INTEGER NOT NULL CHECK (slot BETWEEN 0 AND 47),
  level      INTEGER NOT NULL CHECK (level BETWEEN 1 AND 3),
  PRIMARY KEY (profile_id, date, slot)
);

-- 연동한 캘린더. kind: 'ics_url' | 'ics_file' | 'google'
CREATE TABLE IF NOT EXISTS calendar_sources (
  id             INTEGER PRIMARY KEY,
  profile_id     INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  kind           TEXT    NOT NULL CHECK (kind IN ('ics_url', 'ics_file', 'google')),
  name           TEXT    NOT NULL,
  url            TEXT,
  ics_text       TEXT,
  refresh_token  TEXT,
  busy_level     INTEGER NOT NULL DEFAULT 1 CHECK (busy_level BETWEEN 1 AND 3),
  last_synced_at INTEGER,
  last_error     TEXT,
  created_at     INTEGER NOT NULL
);

-- 캘린더에서 가져온 바쁜 구간 캐시. 일정 제목/내용은 저장하지 않는다.
CREATE TABLE IF NOT EXISTS calendar_busy (
  source_id  INTEGER NOT NULL REFERENCES calendar_sources(id) ON DELETE CASCADE,
  profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  start_ms   INTEGER NOT NULL,
  end_ms     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS calendar_busy_profile ON calendar_busy (profile_id, start_ms);

-- 구글 OAuth 진행 중 상태 (10분 유효)
CREATE TABLE IF NOT EXISTS oauth_states (
  state      TEXT    PRIMARY KEY,
  profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
`;

export function openDb(path = ':memory:') {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  migrate(db);
  return db;
}

function migrate(db) {
  const { user_version: version } = db.prepare('PRAGMA user_version').get();
  if (version < 2) {
    // v1 은 실제 사용자가 생기기 전에 바뀐 구조라 데이터를 옮기지 않고 새로 만든다.
    db.exec('PRAGMA foreign_keys = OFF;');
    for (const t of V1_TABLES) db.exec(`DROP TABLE IF EXISTS ${t};`);
  }
  db.exec(SCHEMA);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
}

/** 여러 쓰기를 하나의 트랜잭션으로 묶는다. */
export function transaction(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
