// 카카오톡 등 앱 안의 브라우저(인앱 브라우저)에서 열렸는지 알아내고, 크롬·사파리로 넘기는 주소를 만든다.
// 인앱 브라우저는 크롬·사파리와 저장 공간이 따로라서, 거기서 만든 시간표는 나중에 크롬·사파리에서 보이지 않는다.

/** @returns {'kakao'|'line'|'other'|null} */
export function detectInApp(ua) {
  if (/KAKAOTALK/i.test(ua)) return 'kakao';
  if (/\bLine\//i.test(ua)) return 'line';
  // 인스타그램, 페이스북, 네이버 앱, 에브리타임, 다음 앱, 그 밖의 안드로이드 웹뷰(; wv))
  if (/Instagram|FBAN|FBAV|NAVER\(inapp|everytimeApp|DaumApps|; wv\)/i.test(ua)) return 'other';
  return null;
}

export function isAndroid(ua) {
  return /Android/i.test(ua);
}

/**
 * 외부 브라우저로 넘기는 주소. 방법이 없으면 null (안내만 보여 준다).
 * @param {'kakao'|'line'|'other'} kind
 * @param {string} url  넘길 페이지 주소 (http/https)
 */
export function externalOpenUrl(kind, url, ua) {
  if (kind === 'kakao') return `kakaotalk://web/openExternal?url=${encodeURIComponent(url)}`;
  if (kind === 'line') return `${url}${url.includes('?') ? '&' : '?'}openExternalBrowser=1`;
  if (isAndroid(ua)) {
    // 안드로이드: 크롬 앱으로 열기. 크롬이 없으면 아무 일도 일어나지 않고 안내 화면이 남는다.
    const m = /^(https?):\/\/(.*)$/.exec(url);
    if (m) return `intent://${m[2]}#Intent;scheme=${m[1]};package=com.android.chrome;end`;
  }
  return null;
}

/**
 * 넘길 때 쓸 이 페이지의 주소. '#c=코드' 는 넘기는 과정에서 잘릴 수 있어 '?c=코드' 로 바꿔 둔다.
 * @param {{origin:string, pathname:string, search:string, hash:string}} loc
 */
export function shareableUrl(loc) {
  const params = new URLSearchParams(loc.search);
  const hash = loc.hash.replace(/^#/, '');
  if (hash.startsWith('c=')) params.set('c', decodeURIComponent(hash.slice(2)));
  params.delete('openExternalBrowser');
  const query = params.toString();
  return `${loc.origin}${loc.pathname}${query ? `?${query}` : ''}`;
}
