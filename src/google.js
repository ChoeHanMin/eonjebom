// 구글 캘린더 연동 (OAuth 2.0 + FreeBusy API).
// 일정 제목이나 내용은 읽지 않고, '바쁜 시간' 정보만 읽는다.
// 삼성 캘린더 일정도 삼성 캘린더 앱에서 구글 계정과 동기화해 두면 여기로 함께 들어온다.

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CALENDAR_LIST_URL = 'https://www.googleapis.com/calendar/v3/users/me/calendarList';
const FREEBUSY_URL = 'https://www.googleapis.com/calendar/v3/freeBusy';

export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/calendar.freebusy',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
];

export function googleEnabled(config) {
  return Boolean(config.googleClientId && config.googleClientSecret);
}

function redirectUri(config) {
  return `${config.baseUrl}/api/google/callback`;
}

export function buildAuthUrl(config, state) {
  const params = new URLSearchParams({
    client_id: config.googleClientId,
    redirect_uri: redirectUri(config),
    response_type: 'code',
    scope: GOOGLE_SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent', // refresh_token을 항상 받기 위해
    state,
  });
  return `${AUTH_URL}?${params}`;
}

async function postForm(config, url, body) {
  const res = await config.fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`구글 인증 실패: ${data.error_description || data.error || res.status}`);
  return data;
}

/** 인증 코드로 refresh token을 받아 온다. */
export async function exchangeCode(config, code) {
  const data = await postForm(config, TOKEN_URL, {
    code,
    client_id: config.googleClientId,
    client_secret: config.googleClientSecret,
    redirect_uri: redirectUri(config),
    grant_type: 'authorization_code',
  });
  if (!data.refresh_token) throw new Error('구글에서 refresh token을 받지 못했습니다. 다시 연결해 주세요.');
  return data.refresh_token;
}

async function getAccessToken(config, refreshToken) {
  const data = await postForm(config, TOKEN_URL, {
    refresh_token: refreshToken,
    client_id: config.googleClientId,
    client_secret: config.googleClientSecret,
    grant_type: 'refresh_token',
  });
  return data.access_token;
}

async function getJson(config, url, accessToken, init = {}) {
  const res = await config.fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', ...init.headers },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`구글 캘린더 요청 실패: ${data.error?.message || res.status}`);
  return data;
}

/**
 * 사용자가 구글 캘린더 앱에서 표시 중인 모든 캘린더의 바쁜 구간을 가져온다.
 * @returns {Promise<{start:number, end:number}[]>}
 */
export async function fetchGoogleBusy(config, refreshToken, { from, to }) {
  const accessToken = await getAccessToken(config, refreshToken);

  const list = await getJson(config, `${CALENDAR_LIST_URL}?minAccessRole=freeBusyReader`, accessToken);
  const ids = (list.items ?? []).filter((c) => c.selected || c.primary).map((c) => c.id);
  if (ids.length === 0) ids.push('primary');

  const busy = [];
  // FreeBusy API는 한 번에 최대 50개 캘린더까지 조회할 수 있다.
  for (let i = 0; i < ids.length; i += 50) {
    const data = await getJson(config, FREEBUSY_URL, accessToken, {
      method: 'POST',
      body: JSON.stringify({
        timeMin: new Date(from).toISOString(),
        timeMax: new Date(to).toISOString(),
        timeZone: 'Asia/Seoul',
        items: ids.slice(i, i + 50).map((id) => ({ id })),
      }),
    });
    for (const cal of Object.values(data.calendars ?? {})) {
      for (const b of cal.busy ?? []) {
        busy.push({ start: Date.parse(b.start), end: Date.parse(b.end) });
      }
    }
  }
  return busy.filter((b) => Number.isFinite(b.start) && Number.isFinite(b.end) && b.end > b.start);
}
