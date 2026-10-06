import { createStore, browserStorage } from '../../src/store.js';
import { renderGrid } from './grid.js';
import { saveGridImage } from './export.js';
import { detectInApp, externalOpenUrl, shareableUrl } from './inapp.js';
import { startPetals } from './petals.js';
import {
  LEVELS,
  WEEKDAYS,
  SLOTS_PER_DAY,
  levelLabel,
  slotLabel,
  addDays,
  todayKst,
  mondayOf,
  formatDate,
  shortDate,
} from './levels.js';

// 서버 없이 이 브라우저 안에서만 동작한다. 데이터는 localStorage 에 저장된다.
const storage = browserStorage();
const store = createStore(storage);
const app = document.getElementById('app');

/** 다른 페이지 안(예: claude.ai 미리보기)에 들어가 있으면 링크 공유·파일 다운로드가 막혀 있다. */
const EMBEDDED = (() => {
  try {
    return window.top !== window.self;
  } catch {
    return true;
  }
})();

const state = {
  brush: 3,
  showAllHours: loadPref('showAllHours') !== '0', // 기본: 하루 48칸 전부
  datesWeek: mondayOf(todayKst()),
  compareWeek: mondayOf(todayKst()),
  selected: new Set(), // 비교할 친구 id
  minSlots: 2,
  minLevel: 2,
  incomingCode: null, // '#c=코드' 링크로 들어온 경우
  view: 'all', // 비교 화면에서 볼 시간표: 'all'(모두 함께) 또는 사람 id
};

const VIEWS = {
  compare: { title: '언제봄', render: renderCompare },
  weekly: { title: '기본 시간표', render: renderWeekly },
  dates: { title: '날짜별 일정', render: renderDates },
  calendars: { title: '캘린더 가져오기', render: renderCalendars },
  me: { title: '내 정보', render: renderMe },
};

// ───────────────────────── 작은 DOM 헬퍼 ─────────────────────────

/** h('div.class', {props}, ...children) — textContent 만 쓰므로 사용자 입력이 HTML로 해석되지 않는다. */
function h(tagAndClass, props = {}, ...children) {
  const [tag, ...classes] = tagAndClass.split('.');
  const el = document.createElement(tag || 'div');
  if (classes.length) el.className = classes.join(' ');
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

function loadPref(key) {
  try {
    return localStorage.getItem(`eonjebom:${key}`);
  } catch {
    return null;
  }
}

function savePref(key, value) {
  try {
    localStorage.setItem(`eonjebom:${key}`, value);
  } catch {
    // 저장소를 쓸 수 없어도 동작에는 문제 없음
  }
}

let toastTimer;
function toast(message, kind = 'info') {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = 'toast'), 3200);
}

/** 실패해도 화면이 멈추지 않도록, 오류는 알림으로 보여 준다. */
function attempt(fn) {
  try {
    return fn();
  } catch (err) {
    toast(err.message || '문제가 발생했어요.', 'error');
    return undefined;
  }
}

/**
 * 앱 안에서 띄우는 확인 창. (브라우저 기본 confirm 창은 일부 환경에서 막혀 있다)
 * @returns {Promise<boolean>}
 */
function ask({ title, detail, okLabel = '확인', cancelLabel = '취소', danger = false, content = null }) {
  return new Promise((resolve) => {
    const dlg = h('dialog.dialog', { 'aria-label': title });
    const close = (value) => {
      dlg.close();
      dlg.remove();
      resolve(value);
    };
    dlg.append(
      h(
        'div.dialog-body',
        {},
        h('p.dialog-title', {}, title),
        detail ? h('p.hint', {}, detail) : null,
        content,
        h(
          'div.dialog-actions',
          {},
          cancelLabel ? h('button', { type: 'button', onClick: () => close(false) }, cancelLabel) : null,
          h(`button.${danger ? 'danger-fill' : 'primary'}`, { type: 'button', onClick: () => close(true) }, okLabel),
        ),
      ),
    );
    dlg.addEventListener('cancel', (e) => {
      e.preventDefault();
      close(false);
    });
    document.body.append(dlg);
    dlg.showModal();
  });
}

/** 복사가 막혔을 때: 내용을 창에 띄워 직접 복사하게 한다. */
function showCopyable(text) {
  const area = h('textarea.copy-area', { readonly: true, rows: '6', 'aria-label': '복사할 내용' }, text);
  const done = ask({ title: '아래 내용을 길게 눌러 전체 복사하세요', content: area, okLabel: '닫기', cancelLabel: null });
  area.focus();
  area.select();
  return done;
}

async function copyText(text, message = '복사했어요. 카톡 등에 붙여 넣으세요.') {
  try {
    await navigator.clipboard.writeText(text);
    toast(message, 'success');
  } catch {
    await showCopyable(text);
  }
}

// ───────────────────────── 시간표 보내기 ─────────────────────────

function shareMessage() {
  const code = store.shareCode();
  // 링크 안에 코드가 들어 있으므로, 링크를 쓸 수 있으면 코드를 따로 적지 않는다. (링크를 붙여 넣어도 코드로 인식됨)
  const text = EMBEDDED
    ? `${store.me.name}의 언제봄 시간표 코드예요. 언제봄의 '친구 코드 추가'에 붙여 넣어 주세요.\n${code}`
    : `${store.me.name}의 언제봄 시간표예요. 눌러서 언제 같이 되는지 확인해 봐!\n${location.origin}${location.pathname}#c=${code}`;
  return { code, text };
}

/** 휴대폰에서는 공유 창(카톡 등)을, 그 외에는 복사를 쓴다. */
async function sendMyTimetable() {
  const { text } = attempt(shareMessage) ?? {};
  if (!text) return;
  if (!EMBEDDED && navigator.share && matchMedia('(pointer: coarse)').matches) {
    try {
      await navigator.share({ title: '언제봄 시간표', text });
      return;
    } catch (err) {
      if (err?.name === 'AbortError') return;
    }
  }
  await copyText(text);
}

// ───────────────────────── 공통 UI 조각 ─────────────────────────

function visibleSlots() {
  return state.showAllHours ? [0, SLOTS_PER_DAY] : [16, SLOTS_PER_DAY]; // 새벽을 숨기면 08:00 ~ 24:00
}

function hoursToggle(rerender) {
  return h(
    'label.toggle',
    {},
    h('input', {
      type: 'checkbox',
      checked: state.showAllHours,
      onChange: (e) => {
        state.showAllHours = e.target.checked;
        savePref('showAllHours', state.showAllHours ? '1' : '0');
        rerender();
      },
    }),
    ' 새벽 시간(0~8시)도 보기',
  );
}

/** '이미지로 저장' 버튼. 휴대폰에서는 공유 창의 '이미지 저장'으로 갤러리에 들어간다. */
function saveImageButton(getOptions) {
  return h(
    'button.small.save-image',
    {
      type: 'button',
      onClick: async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        try {
          const { result, url } = await saveGridImage(getOptions());
          if (result === 'downloaded') toast('이미지를 저장했어요. (다운로드 폴더)', 'success');
          if (result === 'show') {
            await ask({
              title: '이미지를 길게 눌러 저장하세요',
              detail: 'PC에서는 마우스 오른쪽 버튼 › 이미지 저장을 누르세요.',
              content: h('img.saved-image', { src: url, alt: '시간표 이미지' }),
              okLabel: '닫기',
              cancelLabel: null,
            });
          }
        } catch (err) {
          toast(err.message || '이미지를 저장하지 못했어요.', 'error');
        } finally {
          btn.disabled = false;
        }
      },
    },
    '🖼 이미지로 저장',
  );
}

const PAINT_HINT = '휴대폰: 칸 위를 손가락으로 끌면 칠해지고, 왼쪽 시간 줄을 밀면 스크롤돼요.';

function swatch(level) {
  return h(`span.swatch.lv-${level ?? 'none'}`, { 'aria-hidden': 'true' });
}

function legend(extra = []) {
  return h(
    'div.legend',
    {},
    LEVELS.map((l) => h('span.legend-item', {}, swatch(l.value), l.label)),
    h('span.legend-item', {}, swatch(null), '미입력'),
    extra,
  );
}

function palette() {
  const options = [...LEVELS.map((l) => ({ value: l.value, label: l.label })), { value: null, label: '지우개' }];
  const wrap = h('div.palette', { role: 'radiogroup', 'aria-label': '칠할 색' });
  const buttons = options.map((o) =>
    h(
      'button.brush',
      {
        type: 'button',
        role: 'radio',
        'aria-checked': String(state.brush === o.value),
        onClick: () => {
          state.brush = o.value;
          for (const [i, b] of buttons.entries()) b.setAttribute('aria-checked', String(options[i].value === o.value));
        },
      },
      o.value === null ? h('span.swatch.eraser', { 'aria-hidden': 'true' }) : swatch(o.value),
      o.label,
    ),
  );
  wrap.append(...buttons);
  return wrap;
}

function weekNav(start, onMove) {
  const end = addDays(start, 6);
  const thisWeek = mondayOf(todayKst());
  return h(
    'div.week-nav',
    {},
    h('button.icon', { type: 'button', 'aria-label': '이전 주', onClick: () => onMove(addDays(start, -7)) }, '‹'),
    h('span.week-label', {}, `${formatDate(start)} – ${formatDate(end)}`),
    h('button.icon', { type: 'button', 'aria-label': '다음 주', onClick: () => onMove(addDays(start, 7)) }, '›'),
    start !== thisWeek ? h('button.link', { type: 'button', onClick: () => onMove(thisWeek) }, '이번 주') : null,
  );
}

function dateColumns(dates) {
  const today = todayKst();
  return dates.map((d, i) => ({ key: d, label: WEEKDAYS[i % 7], sub: shortDate(d), today: d === today, past: d < today }));
}

/** 저장은 즉시 되지만, 칠할 때마다 '저장됨'을 보여 안심시킨다. */
function saveIndicator() {
  const el = h('span.save-state', { 'aria-live': 'polite' });
  return {
    el,
    run(fn) {
      const ok = attempt(() => {
        fn();
        return true;
      });
      el.textContent = ok ? '저장됨' : '저장 실패';
    },
  };
}

function daysAgo(ms) {
  const days = Math.floor((Date.now() - ms) / 86400000);
  return days <= 0 ? '오늘' : `${days}일 전`;
}

// ───────────────────────── 시작 화면 ─────────────────────────

/** 메인(시작) 화면. 이미 시간표가 있으면 '돌아가기'를 먼저 보여 준다. */
function renderWelcome(notice) {
  const existing = store.me;
  const error = h('p.form-error', { role: 'alert' });
  const nameInput = h('input', {
    id: 'start-name',
    name: 'name',
    required: true,
    maxlength: '20',
    placeholder: '예: 한민',
    autocomplete: 'nickname',
  });
  const restoreInput = h('textarea', { id: 'restore-code', rows: '3', placeholder: '내 시간표 코드나 링크' });

  const form = h(
    'form.card.start-card',
    {
      onSubmit: async (e) => {
        e.preventDefault();
        if (!nameInput.value.trim()) return (error.textContent = '이름을 적어 주세요.');
        if (existing && !(await confirmReplace())) return;
        try {
          if (existing) store.deleteAll();
          store.start(nameInput.value);
          afterStart(true);
        } catch (err) {
          error.textContent = err.message;
        }
      },
    },
    state.incomingCode ? h('p.invite', {}, '친구가 보낸 시간표가 있어요! 이름을 적고 시작하면 바로 비교해 드릴게요.') : null,
    h('h2', {}, existing ? '새 이름으로 다시 시작하기' : '이름만 적으면 바로 시작해요'),
    h(
      'p.hint',
      {},
      existing
        ? `새로 시작하면 지금 이 브라우저에 있는 ${existing.name} 님의 시간표와 받은 친구 코드가 지워져요.`
        : '가입도 서버도 없어요. 내 시간표는 이 브라우저에만 저장돼요.',
    ),
    h('label.field', { for: 'start-name' }, '내 이름', nameInput),
    error,
    h('button.primary.big', { type: 'submit' }, '시작하기'),
    h(
      'details.restore',
      {},
      h('summary', {}, '다른 기기에서 쓰던 시간표가 있나요?'),
      h('p.hint', {}, '그 기기의 내 정보 › 내 시간표 코드를 복사해 여기에 붙여 넣으면 기본 시간표를 옮겨 올 수 있어요.'),
      restoreInput,
      h(
        'button.small',
        {
          type: 'button',
          onClick: async () => {
            if (existing && !(await confirmReplace())) return;
            attempt(() => {
              store.restoreFromCode(restoreInput.value);
              toast('시간표를 불러왔어요.', 'success');
              afterStart(false);
            });
          },
        },
        '코드로 불러오기',
      ),
    ),
  );

  app.replaceChildren(
    h(
      'main.auth',
      {},
      h(
        'section.hero',
        {},
        h('h1.logo', {}, '언제봄'),
        h('p.tagline', {}, '친구랑 언제 볼 수 있는지, 색깔로 한눈에.'),
        h(
          'ol.steps',
          {},
          h('li', {}, h('strong', {}, '이름 적고 시작'), ' — 가입 없음'),
          h('li', {}, h('strong', {}, '내 시간 채우기'), ' — 직접 칠하거나 캘린더 파일 가져오기'),
          h('li', {}, h('strong', {}, '시간표 코드 주고받기'), ' — 카톡으로 보내고 붙여 넣으면 같이 되는 시간이 보여요'),
        ),
        legend(),
      ),
      h(
        'div.start-col',
        {},
        notice ? h('p.notice', {}, notice) : null,
        existing
          ? h(
              'section.card.resume-card',
              {},
              h('p', {}, h('strong', {}, `${existing.name}`), ' 님의 시간표가 이 브라우저에 그대로 있어요.'),
              h(
                'button.primary.big',
                {
                  type: 'button',
                  onClick: () => {
                    history.replaceState(null, '', `${location.pathname}#compare`);
                    afterStart(false);
                  },
                },
                `${existing.name} 님 시간표로 돌아가기`,
              ),
            )
          : null,
        form,
        h('button.dev-button', { type: 'button', onClick: showDeveloper }, '개발자'),
      ),
    ),
  );
  if (!existing) nameInput.focus();
}

function confirmReplace() {
  return ask({
    title: '지금 시간표를 지우고 새로 시작할까요?',
    detail: `${store.me.name} 님의 시간표와 받은 친구 코드가 지워지고, 되돌릴 수 없어요.`,
    okLabel: '지우고 시작',
    danger: true,
  });
}

function showDeveloper() {
  return ask({
    title: '개발자',
    detail: '최한민, 한국외국어대학교 CES, 친한 친구의 기가 막히는 아이디어를 듣고 바로 프로토타입을 만들었따!!!!',
    okLabel: '닫기',
    cancelLabel: null,
  });
}

/** 좌상단 '언제봄' 글자나 '홈 화면으로 가기'를 누르면, 한 번 더 물어본 뒤 메인 화면으로 간다. */
async function goHome(e) {
  e?.preventDefault();
  const ok = await ask({
    title: '메인 화면으로 가시겠습니까?',
    detail: '시간표 다 잃어버리실 수도 있어요 ㅠㅠ',
    okLabel: '응 갈거야',
    cancelLabel: '아니, 안 갈래',
  });
  if (!ok) return;
  history.replaceState(null, '', location.pathname);
  renderWelcome();
  window.scrollTo(0, 0);
}

function afterStart(isNew) {
  if (state.incomingCode) {
    const code = state.incomingCode;
    state.incomingCode = null;
    const added = attempt(() => store.addFriend(code));
    if (added) {
      state.selected = new Set([added.id]);
      toast(`${added.name} 님의 시간표를 받았어요.`, 'success');
    }
    history.replaceState(null, '', '#compare');
  } else if (isNew) {
    history.replaceState(null, '', '#weekly'); // 처음이면 내 시간부터 채우도록
  }
  renderShell();
}

// ───────────────────────── 앱 껍데기 ─────────────────────────

function currentView() {
  const name = location.hash.slice(1).split('?')[0];
  return VIEWS[name] ? name : 'compare';
}

function renderShell() {
  const view = currentView();
  const content = h('main.content', { id: 'content' });
  app.replaceChildren(
    ...[
      h(
        'header.topbar',
        {},
        h('a.logo', { href: location.pathname, onClick: goHome, title: '메인 화면으로' }, '언제봄'),
        h(
          'nav.tabs',
          { 'aria-label': '메뉴' },
          Object.entries(VIEWS).flatMap(([key, v]) => [
            h('a.tab', { href: `#${key}`, 'aria-current': key === view ? 'page' : null }, v.title),
            // '캘린더 가져오기' 바로 다음에 '홈 화면으로 가기'
            key === 'calendars' ? h('a.tab.home-tab', { href: location.pathname, onClick: goHome }, '🏠 홈 화면으로 가기') : null,
          ]),
        ),
        h(
          'button.code-chip',
          { type: 'button', onClick: sendMyTimetable, title: '내 시간표 코드를 친구에게 보내기' },
          h('span.code-label', {}, `${store.me.name} · 내 시간표`),
          h('span.code', {}, '보내기'),
          h('span.share-icon', { 'aria-hidden': 'true' }, '↗'),
        ),
      ),
      storage.persistent
        ? null
        : h(
            'div.link-banner',
            {},
            '이 브라우저는 저장 기능이 꺼져 있어서, 창을 닫으면 시간표가 사라져요. 일반 창에서 열어 주세요.',
          ),
      content,
    ].filter(Boolean),
  );
  document.title = `${VIEWS[view].title} · 언제봄`;
  attempt(() => VIEWS[view].render(content));
}

window.addEventListener('hashchange', () => {
  if (readIncomingCode()) return boot();
  if (store.me) renderShell();
});

/** '#c=시간표코드' 링크로 들어온 경우 (GitHub Pages 등에 올렸을 때) */
/** 친구가 보낸 링크('#c=코드', 외부 브라우저로 넘어온 경우 '?c=코드')로 들어왔으면 코드를 꺼내 둔다. */
function readIncomingCode() {
  const hash = location.hash.slice(1);
  const fromQuery = new URLSearchParams(location.search).get('c');
  const code = hash.startsWith('c=') ? decodeURIComponent(hash.slice(2)) : fromQuery;
  if (!code) return false;
  state.incomingCode = code;
  history.replaceState(null, '', `${location.pathname}#compare`); // 주소창에서 코드를 지운다
  return true;
}

function boot() {
  readIncomingCode();
  if (!store.me) return renderWelcome();
  afterStart(false);
}

// ───────────────────────── 카카오톡 등 앱 안에서 열렸을 때 ─────────────────────────

function sessionFlag(key, value) {
  try {
    if (value === undefined) return sessionStorage.getItem(`eonjebom:${key}`) === '1';
    sessionStorage.setItem(`eonjebom:${key}`, '1');
  } catch {
    // 무시
  }
  return false;
}

/**
 * 앱 안 브라우저는 크롬·사파리와 저장 공간이 따로라 시간표가 따로 놀게 된다.
 * 먼저 크롬·사파리로 자동으로 넘기고, 안 되면 직접 여는 방법을 안내한다.
 */
function renderInAppGuide(kind) {
  const ua = navigator.userAgent;
  const target = shareableUrl(location);
  const escape = externalOpenUrl(kind, target, ua);
  const appName = kind === 'kakao' ? '카카오톡' : kind === 'line' ? '라인' : '앱';

  app.replaceChildren(
    h(
      'main.auth',
      {},
      h(
        'section.card.inapp-card',
        {},
        h('h1.logo', {}, '언제봄'),
        h('h2', {}, `${appName} 안에서 열렸어요`),
        h(
          'p',
          {},
          `${appName} 안의 브라우저에서 만든 시간표는 크롬·사파리에서 보이지 않아요. `,
          h('strong', {}, '크롬(안드로이드)이나 사파리(아이폰)로 열어 주세요.'),
        ),
        escape ? h('a.button.primary.big', { href: escape, id: 'open-external' }, '크롬·사파리로 열기') : null,
        h(
          'ol.steps',
          {},
          h('li', {}, '안 열리면: 화면 구석의 메뉴(⋮ 또는 ⋯)를 누르고'),
          h('li', {}, "'다른 브라우저로 열기' 또는 'Safari로 열기'를 고르세요."),
        ),
        h(
          'div.inapp-link',
          {},
          h('input.mono', {
            id: 'inapp-url',
            value: target,
            readonly: true,
            'aria-label': '이 페이지 주소',
            onFocus: (e) => e.target.select(),
          }),
          h(
            'button.small',
            { type: 'button', onClick: () => copyText(target, '링크를 복사했어요. 크롬·사파리 주소창에 붙여 넣으세요.') },
            '링크 복사',
          ),
        ),
        h(
          'button.link',
          {
            type: 'button',
            onClick: () => {
              sessionFlag('stayInApp', true);
              boot();
            },
          },
          '그냥 여기서 쓸게요',
        ),
      ),
    ),
  );

  // 처음 한 번은 자동으로 넘긴다. (같은 창에서 다시 들어오면 안내만 보여 준다)
  if (escape && !sessionFlag('escapeTried')) {
    sessionFlag('escapeTried', true);
    setTimeout(() => {
      location.href = escape;
    }, 50);
  }
}

/** 벚꽃 배경과 흩날리는 꽃잎을 깐다. (모든 화면의 맨 뒤) */
function addScenery() {
  const canvas = h('canvas.petals', { 'aria-hidden': 'true' });
  document.body.prepend(h('div.scene', { 'aria-hidden': 'true' }), canvas);
  startPetals(canvas);
}

function startup() {
  addScenery();
  const kind = EMBEDDED ? null : detectInApp(navigator.userAgent);
  if (kind && !sessionFlag('stayInApp')) return renderInAppGuide(kind);
  boot();
}

// ───────────────────────── 언제봄 (친구와 비교) ─────────────────────────

function renderCompare(root) {
  const rerender = () => attempt(() => renderCompare(root));
  const friends = store.friends();
  for (const id of state.selected) if (!friends.some((f) => f.id === id)) state.selected.delete(id);
  if (state.selected.size === 0 && friends.length) state.selected.add(friends[0].id);

  const codeInput = h('textarea.code-input', {
    id: 'friend-code',
    rows: '2',
    placeholder: '친구가 보낸 메시지·링크·코드를 통째로 붙여 넣으세요',
    autocomplete: 'off',
    spellcheck: false,
    required: true,
  });

  const addForm = h(
    'form.add-friend',
    {
      onSubmit: (e) => {
        e.preventDefault();
        const added = attempt(() => store.addFriend(codeInput.value));
        if (!added) return;
        state.selected.add(added.id);
        state.view = added.id; // 추가한 친구의 시간표를 바로 보여 준다
        toast(added.updated ? `${added.name} 님의 시간표를 새로 바꿨어요.` : `${added.name} 님을 추가했어요.`, 'success');
        rerender();
        document.getElementById('view-card')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      },
    },
    codeInput,
    h('button.primary', { type: 'submit' }, '친구 코드 추가'),
  );

  const chips = h(
    'div.chips',
    { role: 'group', 'aria-label': '같이 볼 사람' },
    friends.map((f) =>
      h(
        'span.chip-wrap',
        {},
        h(
          'button.chip',
          {
            type: 'button',
            'aria-pressed': String(state.selected.has(f.id)),
            title: `받은 날: ${daysAgo(f.receivedAt)} · ${formatDate(f.validUntil)}까지의 일정이 담겨 있어요`,
            onClick: () => {
              if (state.selected.has(f.id)) state.selected.delete(f.id);
              else state.selected.add(f.id);
              rerender();
            },
          },
          f.name,
          h('span.chip-age', {}, daysAgo(f.receivedAt)),
        ),
        h(
          'button.chip-remove',
          {
            type: 'button',
            'aria-label': `${f.name} 목록에서 빼기`,
            onClick: () => {
              store.removeFriend(f.id);
              state.selected.delete(f.id);
              rerender();
            },
          },
          '×',
        ),
      ),
    ),
  );

  const select = (label, value, options, onChange) =>
    h(
      'label.inline',
      {},
      label,
      h(
        'select',
        { onChange: (e) => onChange(Number(e.target.value)) },
        options.map(([v, text]) => h('option', { value: String(v), selected: v === value }, text)),
      ),
    );

  const results = h('div.compare-results');
  root.replaceChildren(
    h(
      'section.card',
      {},
      h('h2', {}, '누구랑 볼까요?'),
      h(
        'p.hint',
        {},
        '친구에게 받은 시간표 코드를 붙여 넣으세요. 여러 명을 고르면 모두 되는 시간을 찾아요. ',
        '친구가 시간표를 바꾸면 새 코드를 다시 받아 붙여 넣으면 돼요.',
      ),
      addForm,
      friends.length ? chips : null,
      friends.length
        ? h(
            'div.toolbar',
            {},
            weekNav(state.compareWeek, (w) => {
              state.compareWeek = w;
              rerender();
            }),
            select(
              '최소',
              state.minSlots,
              [
                [1, '30분'],
                [2, '1시간'],
                [3, '1시간 30분'],
                [4, '2시간'],
                [6, '3시간'],
              ],
              (v) => {
                state.minSlots = v;
                rerender();
              },
            ),
            select(
              '기준',
              state.minLevel,
              [
                [3, '한가함만'],
                [2, '잘 모르겠음 포함'],
              ],
              (v) => {
                state.minLevel = v;
                rerender();
              },
            ),
          )
        : null,
    ),
    results,
  );

  if (friends.length === 0) {
    results.replaceChildren(
      h(
        'section.card.empty',
        {},
        h('h2', {}, '아직 같이 볼 친구가 없어요'),
        h(
          'p',
          {},
          '내 시간표를 먼저 칠한 뒤 친구에게 보내 보세요. 친구도 언제봄에서 자기 시간표를 칠하고 코드를 보내 주면, 여기에 붙여 넣어 비교할 수 있어요.',
        ),
        h('button.primary', { type: 'button', onClick: sendMyTimetable }, '내 시간표 보내기'),
      ),
    );
    return;
  }
  if (state.selected.size === 0) {
    results.replaceChildren(h('p.hint', {}, '위에서 같이 볼 사람을 골라 주세요.'));
    return;
  }

  const data = store.compare([...state.selected], state.compareWeek, { minSlots: state.minSlots, minLevel: state.minLevel });
  const names = data.people.map((p) => (p.isMe ? '나' : p.name));
  const weekEnd = data.dates[data.dates.length - 1];
  const stale = friends.filter((f) => state.selected.has(f.id) && f.validUntil < weekEnd);

  const myEmpty = data.dates.every((d) => data.cells[d].every((c) => c.levels[0] === null));

  // 볼 시간표: 모두 함께(가장 바쁜 사람 기준) 또는 한 사람
  const viewIndex = data.people.findIndex((p) => p.id === state.view);
  if (viewIndex < 0) state.view = 'all';
  const viewName = viewIndex < 0 ? null : names[viewIndex];
  const viewLevel = (date, slot) => (viewIndex < 0 ? data.cells[date][slot].level : data.cells[date][slot].levels[viewIndex]);
  const viewSwitch = h(
    'div.view-switch',
    { role: 'group', 'aria-label': '볼 시간표' },
    [{ id: 'all', label: '모두 함께' }, ...data.people.map((p, i) => ({ id: p.id, label: names[i] }))].map((o) =>
      h(
        'button.chip',
        {
          type: 'button',
          'aria-pressed': String(state.view === o.id || (o.id === 'all' && viewIndex < 0)),
          onClick: () => {
            state.view = o.id;
            rerender();
            document.getElementById('view-card')?.scrollIntoView({ block: 'start' });
          },
        },
        o.label,
      ),
    ),
  );
  const detail = h('div.detail', { 'aria-live': 'polite' }, h('p.hint', {}, '칸을 누르면 각자 상태를 볼 수 있어요.'));
  const showDetail = (date, slot) => {
    const cell = data.cells[date][slot];
    detail.replaceChildren(
      h('strong', {}, `${formatDate(date)} ${slotLabel(slot)}–${slotLabel(slot + 1)}`),
      h(
        'ul.people',
        {},
        names.map((n, i) => h('li', {}, swatch(cell.levels[i]), `${n}: ${levelLabel(cell.levels[i])}`)),
      ),
    );
  };

  const suggestions = data.suggestions.length
    ? h(
        'ol.suggestions',
        {},
        data.suggestions.map((s) => {
          const minutes = (s.endSlot - s.startSlot) * 30;
          const duration =
            `${minutes >= 60 ? `${Math.floor(minutes / 60)}시간` : ''}${minutes % 60 ? ` ${minutes % 60}분` : ''}`.trim();
          return h(
            'li',
            {},
            h(
              'button.suggestion',
              { type: 'button', onClick: () => showDetail(s.date, s.startSlot) },
              swatch(s.minLevel),
              h('span.when', {}, `${formatDate(s.date)} ${slotLabel(s.startSlot)}–${slotLabel(s.endSlot)}`),
              h('span.meta', {}, `${duration} · ${s.minLevel === 3 ? '모두 한가함' : '잘 모르겠음 포함'}`),
            ),
          );
        }),
      )
    : h('p.hint', {}, '이 주에는 조건에 맞는 시간이 없어요. 기준을 바꾸거나 다른 주를 확인해 보세요.');

  const gridHost = h('div.grid-host');
  results.replaceChildren(
    ...[
      myEmpty
        ? h(
            'section.card.notice-card',
            {},
            h('strong', {}, '아직 이 주의 내 시간을 채우지 않았어요.'),
            h(
              'p',
              {},
              '내 시간이 비어 있으면 같이 되는 시간을 찾을 수 없어요. 친구 시간표는 아래에서 친구 이름을 누르면 볼 수 있어요.',
            ),
            h(
              'div.actions',
              {},
              h('a.button.primary.small', { href: '#weekly' }, '직접 칠하기'),
              h('a.button.small', { href: '#calendars' }, '캘린더 파일 가져오기'),
            ),
          )
        : null,
      stale.length
        ? h(
            'p.notice',
            {},
            `${stale.map((f) => `${f.name}(${formatDate(f.validUntil)}까지)`).join(', ')} 님의 코드는 이 주를 다 담고 있지 않아서, 그 뒤 날짜는 기본 시간표로 봐요. 새 코드를 받으면 더 정확해져요.`,
          )
        : null,
      h('section.card', {}, h('h2', {}, `${names.join(' · ')} 추천 시간`), suggestions),
      h(
        'section.card',
        { id: 'view-card' },
        h(
          'div.card-head',
          {},
          h('h2', {}, viewName ? `${viewName === '나' ? '내' : `${viewName}의`} 시간표` : '함께 보기'),
          saveImageButton(() =>
            viewName
              ? {
                  title: `${viewName === '나' ? store.me.name : viewName}의 시간표`,
                  subtitle: `${formatDate(data.dates[0])} – ${formatDate(weekEnd)}`,
                  columns: dateColumns(data.dates),
                  slots: visibleSlots(),
                  cell: (date, slot) => ({ level: viewLevel(date, slot) }),
                  filename: `eonjebom-person-${data.dates[0]}.png`,
                }
              : {
                  title: `${names.join(' · ')} 언제 봄?`,
                  subtitle: `${formatDate(data.dates[0])} – ${formatDate(weekEnd)} · 가장 바쁜 사람 기준`,
                  notes: data.suggestions
                    .slice(0, 3)
                    .map((s, i) => `추천 ${i + 1}. ${formatDate(s.date)} ${slotLabel(s.startSlot)}–${slotLabel(s.endSlot)}`),
                  columns: dateColumns(data.dates),
                  slots: visibleSlots(),
                  cell: (date, slot) => ({ level: viewLevel(date, slot) }),
                  filename: `eonjebom-together-${data.dates[0]}.png`,
                },
          ),
        ),
        viewSwitch,
        h('div.toolbar', {}, hoursToggle(rerender)),
        h(
          'p.hint',
          {},
          viewName
            ? `${viewName === '나' ? '내' : `${viewName} 님이 보낸`} 시간표 그대로예요. 위에서 '모두 함께'를 누르면 같이 되는 시간을 볼 수 있어요.`
            : '각 칸은 가장 바쁜 사람 기준이에요. 한 명이라도 입력하지 않은 칸은 회색이에요. 위에서 이름을 누르면 그 사람 시간표만 볼 수 있어요.',
        ),
        legend(),
        gridHost,
        detail,
      ),
    ].filter(Boolean),
  );

  renderGrid(gridHost, {
    columns: dateColumns(data.dates),
    slots: visibleSlots(),
    cell: (date, slot) => ({ level: viewLevel(date, slot) }),
    onSelect: (date, slot) => showDetail(date, slot),
  });
}

// ───────────────────────── 기본 시간표 (매주 반복) ─────────────────────────

function renderWeekly(root) {
  const weekly = new Map(store.weeklyCells().map((c) => [`${c.weekday}:${c.slot}`, c.level]));
  const saver = saveIndicator();
  const gridHost = h('div.grid-host');
  const rerender = () => attempt(() => renderWeekly(root));
  const cell = (wd, slot) => ({ level: weekly.get(`${wd}:${slot}`) ?? null });

  root.replaceChildren(
    h(
      'section.card',
      {},
      h('div.card-head', {}, h('h2', {}, '매주 반복되는 기본 시간표'), saver.el),
      h(
        'p.hint',
        {},
        '수업·알바처럼 매주 같은 일정을 칠해 두세요. 색을 고른 뒤 칸을 끌면 끈 범위가 한 번에 칠해지고 바로 저장돼요. ',
        '(예: 07:00 칸부터 08:00 칸까지 끌면 07:00–08:30, 3칸) 캘린더 일정과 날짜별로 직접 칠한 칸이 이 시간표보다 우선해요.',
      ),
      palette(),
      h('p.hint.touch-only', {}, PAINT_HINT),
      h(
        'div.toolbar',
        {},
        hoursToggle(rerender),
        saveImageButton(() => ({
          title: `${store.me.name}의 기본 시간표`,
          subtitle: '매주 반복',
          columns: WEEKDAYS.map((label, i) => ({ key: String(i), label })),
          slots: visibleSlots(),
          cell,
          filename: 'eonjebom-weekly.png',
        })),
      ),
      gridHost,
    ),
  );

  const grid = renderGrid(gridHost, {
    columns: WEEKDAYS.map((label, i) => ({ key: String(i), label })),
    slots: visibleSlots(),
    editable: true,
    brush: () => state.brush,
    cell,
    onPaint: (changed) => {
      const level = state.brush;
      saver.run(() => store.setWeekly(changed.map(({ key, slot }) => ({ weekday: Number(key), slot, level }))));
      for (const { key, slot } of changed) {
        if (level === null) weekly.delete(`${key}:${slot}`);
        else weekly.set(`${key}:${slot}`, level);
      }
      grid.update();
    },
  });
}

// ───────────────────────── 날짜별 일정 ─────────────────────────

function renderDates(root) {
  let data = store.schedule(state.datesWeek, 7);
  const saver = saveIndicator();
  const gridHost = h('div.grid-host');
  const rerender = () => attempt(() => renderDates(root));
  const dateCell = (date, slot) => {
    const c = data.cells[date][slot];
    return {
      level: c.level,
      marks: c.source === 'calendar' ? ['from-calendar'] : c.source === 'override' ? ['from-override'] : [],
    };
  };

  root.replaceChildren(
    h(
      'section.card',
      {},
      h('div.card-head', {}, h('h2', {}, '날짜별 일정'), saver.el),
      h(
        'p.hint',
        {},
        '기본 시간표와 캘린더 일정을 합친 실제 일정이에요. 이번 주만 다른 칸은 여기서 직접 칠하세요. ',
        '지우개로 지우면 기본 시간표·캘린더 값으로 돌아가요.',
      ),
      h(
        'div.toolbar',
        {},
        weekNav(state.datesWeek, (w) => {
          state.datesWeek = w;
          rerender();
        }),
        hoursToggle(rerender),
        saveImageButton(() => ({
          title: `${store.me.name}의 일정`,
          subtitle: `${formatDate(data.dates[0])} – ${formatDate(data.dates[data.dates.length - 1])}`,
          columns: dateColumns(data.dates),
          slots: visibleSlots(),
          cell: dateCell,
          filename: `eonjebom-my-week-${data.dates[0]}.png`,
        })),
      ),
      palette(),
      h('p.hint.touch-only', {}, PAINT_HINT),
      legend([
        h('span.legend-item', {}, h('span.swatch.lv-none.from-calendar'), '캘린더에서 가져옴'),
        h('span.legend-item', {}, h('span.swatch.lv-none.from-override'), '이 날짜만 직접 칠함'),
      ]),
      gridHost,
    ),
  );

  const grid = renderGrid(gridHost, {
    columns: dateColumns(data.dates),
    slots: visibleSlots(),
    editable: true,
    brush: () => state.brush,
    cell: dateCell,
    onPaint: (changed) => {
      const level = state.brush;
      saver.run(() => store.setOverrides(changed.map(({ key, slot }) => ({ date: key, slot, level }))));
      // 지운 칸은 기본 시간표/캘린더 값으로 돌아가므로 다시 계산한다.
      data = store.schedule(data.dates[0], 7);
      grid.update();
    },
  });
}

// ───────────────────────── 캘린더 파일 가져오기 ─────────────────────────

function renderCalendars(root) {
  const calendars = store.calendars();
  const rerender = () => attempt(() => renderCalendars(root));

  const levelSelect = (id, value, onChange) =>
    h(
      'select',
      { id, 'aria-label': '일정 시간 표시', onChange: (e) => onChange(Number(e.target.value)) },
      LEVELS.map((l) => h('option', { value: String(l.value), selected: l.value === value }, l.label)),
    );

  const fileInput = h('input', { id: 'ics-file', type: 'file', accept: '.ics,text/calendar', multiple: true });
  let fileLevel = 1;

  root.replaceChildren(
    h(
      'section.card',
      {},
      h('h2', {}, '캘린더 파일(.ics) 가져오기'),
      h(
        'p.hint',
        {},
        '캘린더 앱에서 내보낸 .ics 파일을 고르면, 일정이 있는 시간을 자동으로 칠해 줘요. ',
        '파일은 이 기기 안에서만 읽고, 일정 제목이나 내용은 저장하지 않아요. 일정이 바뀌면 파일을 다시 가져오세요.',
      ),
      h(
        'form.inline-form',
        {
          onSubmit: async (e) => {
            e.preventDefault();
            const files = [...fileInput.files];
            if (files.length === 0) return toast('파일을 골라 주세요.', 'error');
            let total = 0;
            let imported = 0;
            for (const file of files) {
              if (file.size > 5 * 1024 * 1024) {
                toast(`${file.name} 파일이 너무 커요 (최대 5MB).`, 'error');
                continue;
              }
              const text = await file.text();
              const r = attempt(() =>
                store.importCalendar({ name: file.name.replace(/\.ics$/i, ''), icsText: text, busyLevel: fileLevel }),
              );
              if (r) {
                total += r.events;
                imported++;
              }
            }
            if (imported) toast(`일정 ${total}개를 가져왔어요.`, 'success');
            rerender();
          },
        },
        fileInput,
        h(
          'label.inline',
          { for: 'ics-level' },
          '일정 시간 =',
          levelSelect('ics-level', fileLevel, (v) => (fileLevel = v)),
        ),
        h('button.primary', { type: 'submit' }, '가져오기'),
      ),
      h(
        'details.howto',
        {},
        h('summary', {}, '.ics 파일은 어떻게 받나요?'),
        h(
          'ul',
          {},
          h(
            'li',
            {},
            h('strong', {}, '구글 캘린더 (PC 웹): '),
            '설정 › 가져오기 및 내보내기 › 내보내기 → 받은 zip 파일을 풀면 캘린더별 .ics 파일이 나와요.',
          ),
          h('li', {}, h('strong', {}, '삼성 캘린더: '), '일정을 구글 계정과 동기화해 두고, 위 구글 캘린더 방법으로 내보내요.'),
          h('li', {}, h('strong', {}, '애플 캘린더 (Mac): '), '캘린더를 고른 뒤 파일 › 내보내기 › 내보내기.'),
          h('li', {}, h('strong', {}, '네이버 캘린더 (PC 웹): '), '환경설정 › 캘린더 관리 › 내보내기.'),
        ),
      ),
    ),
    h(
      'section.card',
      {},
      h('h2', {}, '가져온 캘린더'),
      h(
        'p.hint',
        {},
        '캘린더 일정이 있는 시간을 어떻게 표시할지 캘린더마다 정할 수 있어요. (예: 수업은 "바쁨", 동아리는 "잘 모르겠음")',
      ),
      calendars.length
        ? h(
            'ul.calendar-list',
            {},
            calendars.map((c) =>
              h(
                'li.calendar',
                {},
                h(
                  'div.calendar-info',
                  {},
                  h('strong', {}, c.name),
                  h('span.sync', {}, `일정 ${c.events}개 · ${new Date(c.importedAt).toLocaleDateString('ko-KR')}에 가져옴`),
                ),
                h(
                  'div.actions',
                  {},
                  h(
                    'label.inline',
                    {},
                    '일정 시간 = ',
                    levelSelect(`cal-${c.id}`, c.busyLevel, (v) =>
                      attempt(() => {
                        store.setCalendarLevel(c.id, v);
                        toast('저장했어요.', 'success');
                      }),
                    ),
                  ),
                  h(
                    'button.small.danger',
                    {
                      type: 'button',
                      onClick: async () => {
                        if (!(await ask({ title: `'${c.name}' 캘린더를 뺄까요?`, okLabel: '빼기', danger: true }))) return;
                        store.removeCalendar(c.id);
                        rerender();
                      },
                    },
                    '빼기',
                  ),
                ),
              ),
            ),
          )
        : h('p.hint', {}, '아직 가져온 캘린더가 없어요.'),
    ),
  );
}

// ───────────────────────── 내 정보 ─────────────────────────

function renderMe(root) {
  const nameInput = h('input', { id: 'my-name', name: 'name', value: store.me.name, maxlength: '20', required: true });
  const { code, text } = attempt(shareMessage) ?? { code: '', text: '' };
  const codeField = h(
    'textarea.mono.code-input',
    { id: 'my-code', readonly: true, rows: '4', 'aria-label': '내 시간표 코드', onFocus: (e) => e.target.select() },
    code,
  );

  root.replaceChildren(
    h(
      'section.card',
      {},
      h('h2', {}, '내 시간표 코드'),
      h(
        'p.hint',
        {},
        '이 코드에는 내 이름과 기본 시간표, 이번 주부터 3주간의 실제 일정(캘린더·날짜별 수정 포함)이 담겨 있어요. ',
        '받은 친구는 볼 수만 있고 고칠 수는 없어요. 시간표를 바꾸면 코드도 바뀌니 다시 보내 주세요.',
      ),
      codeField,
      h(
        'div.actions.spaced',
        {},
        h('button.primary.small', { type: 'button', onClick: sendMyTimetable }, '친구에게 보내기'),
        h('button.small', { type: 'button', onClick: () => copyText(text) }, '메시지 복사'),
      ),
    ),
    h(
      'section.card',
      {},
      h('h2', {}, '이름'),
      h(
        'form.inline-form',
        {
          onSubmit: (e) => {
            e.preventDefault();
            attempt(() => {
              store.rename(nameInput.value);
              toast('이름을 바꿨어요.', 'success');
              renderShell();
            });
          },
        },
        nameInput,
        h('button.primary', { type: 'submit' }, '저장'),
      ),
    ),
    h(
      'section.card',
      {},
      h('h2', {}, '다른 기기로 옮기기'),
      h(
        'p.hint',
        {},
        '내 시간표는 이 브라우저에만 저장돼요. 다른 폰이나 PC에서도 쓰려면 위의 내 시간표 코드를 복사해서, 그 기기의 언제봄 첫 화면 › "다른 기기에서 쓰던 시간표가 있나요?"에 붙여 넣으세요. ',
        '기본 시간표가 옮겨지고, 캘린더 파일은 그 기기에서 다시 가져오면 돼요.',
      ),
    ),
    h(
      'section.card',
      {},
      h('h2', {}, '내 데이터 지우기'),
      h('p.hint', {}, '이 브라우저에 저장된 내 시간표, 가져온 캘린더, 받은 친구 코드를 모두 지워요.'),
      h(
        'button.small.danger',
        {
          type: 'button',
          onClick: async () => {
            const ok = await ask({
              title: '모두 지울까요?',
              detail: '내 시간표와 받은 친구 코드가 모두 지워지고, 되돌릴 수 없어요.',
              okLabel: '모두 지우기',
              danger: true,
            });
            if (!ok) return;
            store.deleteAll();
            state.selected.clear();
            history.replaceState(null, '', location.pathname);
            renderWelcome('모두 지웠어요.');
          },
        },
        '모두 지우기',
      ),
    ),
  );
}

startup();
