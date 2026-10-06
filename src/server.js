import { existsSync } from 'node:fs';
import { openDb } from './db.js';
import { createApp } from './app.js';
import { syncDueSources } from './calendars.js';

if (existsSync('.env')) process.loadEnvFile('.env');

const port = Number(process.env.PORT ?? 3000);
const baseUrl = (process.env.BASE_URL ?? `http://localhost:${port}`).replace(/\/$/, '');

const config = {
  baseUrl,
  secureCookies: baseUrl.startsWith('https://'),
  trustProxy: process.env.TRUST_PROXY === '1' ? 1 : false,
  googleClientId: process.env.GOOGLE_CLIENT_ID,
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
};

const db = openDb(process.env.DB_PATH ?? 'data/eonjebom.db');
const app = createApp({ db, config });

app.listen(port, () => {
  console.log(`언제봄 서버 실행 중: ${baseUrl}`);
  if (!config.googleClientId) console.log('  (GOOGLE_CLIENT_ID 미설정: 구글 캘린더 연동 버튼이 비활성화됩니다)');
});

// 연동된 캘린더를 주기적으로 다시 가져오고, 만료된 로그인 세션을 정리한다.
const SYNC_INTERVAL_MS = 30 * 60 * 1000;
const SYNC_MAX_AGE_MS = 3 * 60 * 60 * 1000;
setInterval(async () => {
  try {
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
    await syncDueSources(db, { ...config, fetch: globalThis.fetch }, { maxAgeMs: SYNC_MAX_AGE_MS });
  } catch (err) {
    console.error('[sync] 주기 동기화 실패:', err);
  }
}, SYNC_INTERVAL_MS).unref();
