import { existsSync } from 'node:fs';
import { openDb } from './db.js';
import { createApp } from './app.js';
import { syncDueSources } from './calendars.js';

if (existsSync('.env')) process.loadEnvFile('.env');

const port = Number(process.env.PORT ?? 3000);
// Fly.io에서는 FLY_APP_NAME이 자동으로 주어지므로 BASE_URL을 따로 설정하지 않아도 된다.
const defaultBaseUrl = process.env.FLY_APP_NAME
  ? `https://${process.env.FLY_APP_NAME}.fly.dev`
  : `http://localhost:${port}`;
const baseUrl = (process.env.BASE_URL || defaultBaseUrl).replace(/\/$/, '');

const config = {
  baseUrl,
  secureCookies: baseUrl.startsWith('https://'),
  trustProxy: process.env.TRUST_PROXY === '1' ? 1 : false,
  googleClientId: process.env.GOOGLE_CLIENT_ID,
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
};

const db = openDb(process.env.DB_PATH ?? 'data/eonjebom.db');
const app = createApp({ db, config });

const server = app.listen(port, () => {
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

// 배포 시 재시작 신호를 받으면 요청을 마무리하고 DB를 닫은 뒤 종료한다.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
