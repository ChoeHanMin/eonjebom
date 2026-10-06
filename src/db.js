import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  username      TEXT    NOT NULL UNIQUE,
  display_name  TEXT    NOT NULL,
  password_hash TEXT    NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT    PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

-- 친구 관계. 요청한 사람(requester) -> 받은 사람(addressee). 수락되면 status = 'accepted'.
CREATE TABLE IF NOT EXISTS friendships (
  id           INTEGER PRIMARY KEY,
  requester_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  addressee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status       TEXT    NOT NULL CHECK (status IN ('pending', 'accepted')),
  created_at   INTEGER NOT NULL,
  pair_key     TEXT    NOT NULL UNIQUE -- '작은id:큰id', 같은 두 사람 사이 관계는 하나만
);

-- 매주 반복되는 기본 시간표. weekday 0 = 월요일.
CREATE TABLE IF NOT EXISTS weekly_slots (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  slot    INTEGER NOT NULL CHECK (slot BETWEEN 0 AND 47),
  level   INTEGER NOT NULL CHECK (level BETWEEN 1 AND 5),
  PRIMARY KEY (user_id, weekday, slot)
);

-- 특정 날짜에 직접 칠한 값. 기본 시간표와 캘린더 일정보다 우선한다.
CREATE TABLE IF NOT EXISTS date_slots (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date    TEXT    NOT NULL,
  slot    INTEGER NOT NULL CHECK (slot BETWEEN 0 AND 47),
  level   INTEGER NOT NULL CHECK (level BETWEEN 1 AND 5),
  PRIMARY KEY (user_id, date, slot)
);

-- 연동한 캘린더. kind: 'ics_url' | 'ics_file' | 'google'
CREATE TABLE IF NOT EXISTS calendar_sources (
  id             INTEGER PRIMARY KEY,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind           TEXT    NOT NULL CHECK (kind IN ('ics_url', 'ics_file', 'google')),
  name           TEXT    NOT NULL,
  url            TEXT,
  ics_text       TEXT,
  refresh_token  TEXT,
  busy_level     INTEGER NOT NULL DEFAULT 1 CHECK (busy_level BETWEEN 1 AND 5),
  last_synced_at INTEGER,
  last_error     TEXT,
  created_at     INTEGER NOT NULL
);

-- 캘린더에서 가져온 바쁜 구간 캐시. 일정 제목/내용은 저장하지 않는다.
CREATE TABLE IF NOT EXISTS calendar_busy (
  source_id INTEGER NOT NULL REFERENCES calendar_sources(id) ON DELETE CASCADE,
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  start_ms  INTEGER NOT NULL,
  end_ms    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS calendar_busy_user ON calendar_busy (user_id, start_ms);
`;

export function openDb(path = ':memory:') {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  return db;
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
