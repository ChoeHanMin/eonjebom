import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectInApp, externalOpenUrl, shareableUrl } from '../public/js/inapp.js';

const UA = {
  kakaoAndroid:
    'Mozilla/5.0 (Linux; Android 14; SM-S918N Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0.6668.100 Mobile Safari/537.36;KAKAOTALK 2410520',
  kakaoIos:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 KAKAOTALK 10.8.5',
  line: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Safari Line/14.10.0',
  instagramAndroid:
    'Mozilla/5.0 (Linux; Android 13; SM-G991N Build/TP1A.220624.014; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/128.0.0.0 Mobile Safari/537.36 Instagram 349.0.0.39.105 Android',
  instagramIos: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 349.0.0',
  chromeAndroid: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36',
  samsung:
    'Mozilla/5.0 (Linux; Android 14; SM-S918N) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36',
  safari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  chromeIos: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/129.0.0.0 Mobile/15E148 Safari/604.1',
};

test('앱 안 브라우저 감지', () => {
  assert.equal(detectInApp(UA.kakaoAndroid), 'kakao');
  assert.equal(detectInApp(UA.kakaoIos), 'kakao');
  assert.equal(detectInApp(UA.line), 'line');
  assert.equal(detectInApp(UA.instagramAndroid), 'other');
  assert.equal(detectInApp(UA.instagramIos), 'other');
  for (const ua of [UA.chromeAndroid, UA.samsung, UA.safari, UA.chromeIos]) assert.equal(detectInApp(ua), null);
});

test('외부 브라우저로 넘기는 주소', () => {
  const url = 'https://choehanmin.github.io/eonjebom/?c=EB1.AbC-_9';
  assert.equal(
    externalOpenUrl('kakao', url, UA.kakaoIos),
    'kakaotalk://web/openExternal?url=https%3A%2F%2Fchoehanmin.github.io%2Feonjebom%2F%3Fc%3DEB1.AbC-_9',
  );
  assert.equal(externalOpenUrl('line', url, UA.line), `${url}&openExternalBrowser=1`);
  assert.equal(
    externalOpenUrl('other', url, UA.instagramAndroid),
    'intent://choehanmin.github.io/eonjebom/?c=EB1.AbC-_9#Intent;scheme=https;package=com.android.chrome;end',
  );
  assert.equal(externalOpenUrl('other', url, UA.instagramIos), null); // 아이폰은 방법이 없어 안내만
});

test('넘길 때 친구 코드가 따라간다 (#c= → ?c=)', () => {
  const loc = { origin: 'https://choehanmin.github.io', pathname: '/eonjebom/', search: '', hash: '#c=EB1.xyz' };
  assert.equal(shareableUrl(loc), 'https://choehanmin.github.io/eonjebom/?c=EB1.xyz');
  assert.equal(shareableUrl({ ...loc, hash: '#weekly' }), 'https://choehanmin.github.io/eonjebom/');
  assert.equal(
    shareableUrl({ ...loc, hash: '', search: '?c=EB1.q&openExternalBrowser=1' }),
    'https://choehanmin.github.io/eonjebom/?c=EB1.q',
  );
});
