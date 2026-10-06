// 연동한 캘린더에서 바쁜 구간을 가져와 calendar_busy 테이블에 캐시한다.
import { transaction } from './db.js';
import { DAY_MS } from './time.js';
import { parseIcsBusy } from './ics.js';
import { fetchGoogleBusy } from './google.js';
import { fetchCalendarText } from './safe-fetch.js';

export const SYNC_PAST_DAYS = 7;
export const SYNC_FUTURE_DAYS = 120;

export function syncWindow(now) {
  return { from: now - SYNC_PAST_DAYS * DAY_MS, to: now + SYNC_FUTURE_DAYS * DAY_MS };
}

/** 겹치거나 맞닿은 구간을 하나로 합친다. */
export function mergeIntervals(intervals) {
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const merged = [];
  for (const iv of sorted) {
    const last = merged[merged.length - 1];
    if (last && iv.start <= last.end) last.end = Math.max(last.end, iv.end);
    else merged.push({ start: iv.start, end: iv.end });
  }
  return merged;
}

async function loadBusy(source, config, window) {
  switch (source.kind) {
    case 'google':
      return fetchGoogleBusy(config, source.refresh_token, window);
    case 'ics_url':
      return parseIcsBusy(await fetchCalendarText(source.url, { fetch: config.fetch, lookup: config.lookup }), window);
    case 'ics_file':
      return parseIcsBusy(source.ics_text, window);
    default:
      throw new Error(`알 수 없는 캘린더 종류: ${source.kind}`);
  }
}

/**
 * 캘린더 하나를 동기화한다. 실패해도 예외를 던지지 않고 last_error에 기록한 뒤 오류 메시지를 반환한다.
 * @returns {Promise<string|null>} 오류 메시지 (성공 시 null)
 */
export async function syncSource(db, source, config, now = Date.now()) {
  try {
    const busy = mergeIntervals(await loadBusy(source, config, syncWindow(now)));
    transaction(db, () => {
      db.prepare('DELETE FROM calendar_busy WHERE source_id = ?').run(source.id);
      const insert = db.prepare('INSERT INTO calendar_busy (source_id, user_id, start_ms, end_ms) VALUES (?, ?, ?, ?)');
      for (const b of busy) insert.run(source.id, source.user_id, b.start, b.end);
      db.prepare('UPDATE calendar_sources SET last_synced_at = ?, last_error = NULL WHERE id = ?').run(now, source.id);
    });
    return null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    db.prepare('UPDATE calendar_sources SET last_error = ? WHERE id = ?').run(message, source.id);
    return message;
  }
}

/** 마지막 동기화가 maxAgeMs보다 오래된 캘린더를 모두 다시 동기화한다. */
export async function syncDueSources(db, config, { maxAgeMs, now = Date.now() }) {
  const due = db
    .prepare('SELECT * FROM calendar_sources WHERE last_synced_at IS NULL OR last_synced_at < ?')
    .all(now - maxAgeMs);
  for (const source of due) await syncSource(db, source, config, now);
  return due.length;
}
