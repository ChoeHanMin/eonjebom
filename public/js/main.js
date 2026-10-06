import { api, ApiError, getToken, setToken } from './api.js';
import { renderGrid } from './grid.js';
import { saveGridImage } from './export.js';
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
  formatCode,
} from './levels.js';

const app = document.getElementById('app');

const state = {
  profile: null,
  googleEnabled: false,
  brush: 3,
  showAllHours: loadPref('showAllHours') !== '0', // 기본: 하루 48칸 전부
  datesWeek: mondayOf(todayKst()),
  compareWeek: mondayOf(todayKst()),
  selected: new Set(), // 비교할 친구 코드
  minSlots: 2,
  minLevel: 2,
  invite: null, // '#with=코드' 링크로 들어온 경우 그 코드
};

const VIEWS = {
  compare: { title: '언제봄', render: renderCompare },
  weekly: { title: '기본 시간표', render: renderWeekly },
  dates: { title: '날짜별 일정', render: renderDates },
  calendars: { title: '캘린더 연동', render: renderCalendars },
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
    if (value === null) localStorage.removeItem(`eonjebom:${key}`);
    else localStorage.setItem(`eonjebom:${key}`, value);
  } catch {
    // 저장소를 쓸 수 없어도 동작에는 문제 없음
  }
}

// 비교했던 친구 코드 목록은 이 브라우저에만 기억한다.
function loadFriends() {
  try {
    const list = JSON.parse(loadPref('friends') ?? '[]');
    return Array.isArray(list) ? list.filter((f) => typeof f?.code === 'string' && typeof f?.name === 'string') : [];
  } catch {
    return [];
  }
}

function saveFriends(list) {
  savePref('friends', JSON.stringify(list));
}

function rememberFriend({ code, name }) {
  const list = loadFriends().filter((f) => f.code !== code);
  list.unshift({ code, name });
  saveFriends(list.slice(0, 30));
}

function normalizeCode(input) {
  return String(input ?? '')
    .toUpperCase()
    .replace(/[\s-]/g, '');
}

let toastTimer;
function toast(message, kind = 'info') {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = 'toast'), 3200);
}

function handleError(err) {
  if (err instanceof ApiError && err.status === 401) {
    setToken(null);
    state.profile = null;
    renderWelcome('이 브라우저에 저장된 시간표를 찾을 수 없어요. 수정 링크가 바뀌었거나 시간표가 삭제됐을 수 있어요.');
    return;
  }
  toast(err.message || '문제가 발생했어요.', 'error');
}

/** 휴대폰에서는 공유 창(카톡 등)을, 그 외에는 클립보드 복사를 쓴다. */
async function shareOrCopy({ title, text, url }, copiedMessage = '복사했어요. 원하는 곳에 붙여 넣으세요.') {
  if (navigator.share) {
    try {
      await navigator.share({ title, text, url });
      return true;
    } catch (err) {
      if (err?.name === 'AbortError') return false;
    }
  }
  try {
    await navigator.clipboard.writeText(url ? `${text}\n${url}` : text);
    toast(copiedMessage, 'success');
    return true;
  } catch {
    prompt('아래 내용을 복사하세요.', url ? `${text}\n${url}` : text);
    return true;
  }
}

function shareMyCode() {
  const code = state.profile.code;
  return shareOrCopy({
    title: '언제봄',
    text: `언제봄에서 나랑 언제 시간 되는지 맞춰 보자! 내 코드: ${formatCode(code)}`,
    url: `${location.origin}/#with=${code}`,
  });
}

function editLink() {
  return `${location.origin}/#edit=${getToken()}`;
}

async function saveEditLink() {
  const done = await shareOrCopy(
    {
      title: '언제봄 수정 링크 (나만 보관)',
      text: '언제봄 내 시간표 수정 링크예요. 다른 사람에게 보내지 마세요!',
      url: editLink(),
    },
    '수정 링크를 복사했어요. 메모나 카톡 "나와의 채팅"에 붙여 넣어 두세요.',
  );
  if (done) {
    savePref('linkSaved', '1');
    document.querySelector('.link-banner')?.remove();
  }
}

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
          const result = await saveGridImage(getOptions());
          if (result === 'downloaded') toast('이미지를 저장했어요. (다운로드 폴더)', 'success');
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

function saveIndicator() {
  const el = h('span.save-state', { 'aria-live': 'polite' });
  let pending = 0;
  return {
    el,
    async run(promise) {
      pending++;
      el.textContent = '저장 중…';
      try {
        await promise;
        if (--pending === 0) el.textContent = '저장됨';
      } catch (err) {
        pending--;
        el.textContent = '저장 실패';
        throw err;
      }
    },
  };
}

// ───────────────────────── 시작 화면 (로그인 없음) ─────────────────────────

async function renderWelcome(notice) {
  const error = h('p.form-error', { role: 'alert' });
  const nameInput = h('input', {
    name: 'name',
    required: true,
    maxlength: '20',
    placeholder: '예: 한민',
    autocomplete: 'nickname',
  });
  const inviteBox = h('div');

  const form = h(
    'form.card.start-card',
    {
      onSubmit: async (e) => {
        e.preventDefault();
        const button = form.querySelector('button[type=submit]');
        button.disabled = true;
        try {
          const { profile, editToken } = await api.post('/api/profiles', { name: nameInput.value });
          setToken(editToken);
          state.profile = profile;
          savePref('linkSaved', null);
          await afterStart({ isNew: true });
        } catch (err) {
          error.textContent = err.message;
          button.disabled = false;
        }
      },
    },
    inviteBox,
    h('h2', {}, '이름만 적으면 바로 시작해요'),
    h('p.hint', {}, '회원가입은 없어요. 친구에게 보이는 이름이에요.'),
    h('label.field', {}, '내 이름', nameInput),
    error,
    h('button.primary.big', { type: 'submit' }, '시작하기'),
    h(
      'p.hint.small-print',
      {},
      '다른 기기에서 이미 만든 시간표가 있다면, 그때 저장해 둔 "수정 링크"를 열면 이어서 쓸 수 있어요.',
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
          h('li', {}, h('strong', {}, '내 시간 채우기'), ' — 구글·삼성 캘린더 연동 또는 직접 칠하기'),
          h('li', {}, h('strong', {}, '코드 공유'), ' — 8자리 코드로 친구와 같이 되는 시간 확인'),
        ),
        legend(),
      ),
      h('div.start-col', {}, notice ? h('p.notice', {}, notice) : null, form),
    ),
  );
  nameInput.focus();

  if (state.invite) {
    try {
      const { profile } = await api.get(`/api/profiles/${state.invite}`);
      inviteBox.replaceChildren(
        h('p.invite', {}, h('strong', {}, profile.name), ' 님이 같이 시간을 맞춰 보자고 했어요! 시작하면 바로 비교해 드릴게요.'),
      );
    } catch {
      state.invite = null;
    }
  }
}

/** 시간표를 만든 직후, 또는 저장된 수정 권한으로 다시 들어왔을 때 */
async function afterStart({ isNew = false } = {}) {
  const me = await api.get('/api/me');
  state.profile = me.profile;
  state.googleEnabled = me.googleEnabled;
  if (state.invite) {
    const code = state.invite;
    state.invite = null;
    try {
      if (code !== state.profile.code) {
        const { profile } = await api.get(`/api/profiles/${code}`);
        rememberFriend(profile);
        state.selected = new Set([profile.code]);
      }
    } catch (err) {
      toast(err.message, 'error');
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

function hashParams() {
  return new URLSearchParams(location.hash.split('?')[1] ?? '');
}

function renderShell() {
  const view = currentView();
  const content = h('main.content', { id: 'content' });
  const banner =
    loadPref('linkSaved') !== '1'
      ? h(
          'div.link-banner',
          {},
          h('span', {}, '이 브라우저에서만 내 시간표를 고칠 수 있어요. 다른 기기에서도 쓰려면 "수정 링크"를 저장해 두세요.'),
          h(
            'span.actions',
            {},
            h('button.small.primary', { type: 'button', onClick: saveEditLink }, '수정 링크 저장'),
            h(
              'button.small',
              {
                type: 'button',
                onClick: (e) => {
                  savePref('linkSaved', '1');
                  e.target.closest('.link-banner').remove();
                },
              },
              '닫기',
            ),
          ),
        )
      : null;

  app.replaceChildren(
    ...[
      h(
        'header.topbar',
        {},
        h('a.logo', { href: '#compare' }, '언제봄'),
        h(
          'nav.tabs',
          { 'aria-label': '메뉴' },
          Object.entries(VIEWS).map(([key, v]) =>
            h('a.tab', { href: `#${key}`, 'aria-current': key === view ? 'page' : null }, v.title),
          ),
        ),
        h(
          'button.code-chip',
          { type: 'button', onClick: shareMyCode, title: '내 코드 공유하기' },
          h('span.code-label', {}, `${state.profile.name} · 내 코드`),
          h('span.code', {}, formatCode(state.profile.code)),
          h('span.share-icon', { 'aria-hidden': 'true' }, '↗'),
        ),
      ),
      banner,
      content,
    ].filter(Boolean),
  );
  document.title = `${VIEWS[view].title} · 언제봄`;
  VIEWS[view].render(content).catch(handleError);
}

window.addEventListener('hashchange', () => {
  if (readSpecialHash()) return boot();
  if (state.profile) renderShell();
});

/** '#edit=토큰'(수정 링크), '#with=코드'(초대 링크) 처리. 처리했으면 true */
function readSpecialHash() {
  const hash = location.hash.slice(1);
  if (hash.startsWith('edit=')) {
    const token = hash.slice(5);
    history.replaceState(null, '', '#compare');
    if (/^[\w-]{20,100}$/.test(token)) {
      setToken(token);
      savePref('linkSaved', '1');
      toast('이 기기에서도 내 시간표를 고칠 수 있어요.', 'success');
    }
    return true;
  }
  if (hash.startsWith('with=')) {
    const code = normalizeCode(decodeURIComponent(hash.slice(5)));
    history.replaceState(null, '', '#compare');
    if (code.length === 8) state.invite = code;
    return true;
  }
  return false;
}

async function boot() {
  readSpecialHash();
  if (!getToken()) return renderWelcome();
  try {
    await afterStart();
  } catch (err) {
    handleError(err);
  }
}

// ───────────────────────── 언제봄 (코드로 비교) ─────────────────────────

async function renderCompare(root) {
  const rerender = () => renderCompare(root).catch(handleError);
  let friends = loadFriends();
  for (const code of state.selected) if (!friends.some((f) => f.code === code)) state.selected.delete(code);
  if (state.selected.size === 0 && friends.length) state.selected.add(friends[0].code);

  const codeInput = h('input', {
    name: 'code',
    placeholder: '친구 코드 (예: K7QM-3XPA)',
    autocapitalize: 'characters',
    autocomplete: 'off',
    spellcheck: false,
    required: true,
  });

  const addForm = h(
    'form.inline-form',
    {
      onSubmit: async (e) => {
        e.preventDefault();
        const code = normalizeCode(codeInput.value);
        if (code === state.profile.code) return toast('내 코드예요. 친구의 코드를 넣어 주세요.', 'error');
        try {
          const { profile } = await api.get(`/api/profiles/${encodeURIComponent(code)}`);
          rememberFriend(profile);
          state.selected.add(profile.code);
          toast(`${profile.name} 님을 추가했어요.`, 'success');
          rerender();
        } catch (err) {
          handleError(err);
        }
      },
    },
    codeInput,
    h('button.primary', { type: 'submit' }, '추가'),
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
            'aria-pressed': String(state.selected.has(f.code)),
            title: formatCode(f.code),
            onClick: () => {
              if (state.selected.has(f.code)) state.selected.delete(f.code);
              else state.selected.add(f.code);
              rerender();
            },
          },
          f.name,
        ),
        h(
          'button.chip-remove',
          {
            type: 'button',
            'aria-label': `${f.name} 목록에서 빼기`,
            onClick: () => {
              saveFriends(loadFriends().filter((x) => x.code !== f.code));
              state.selected.delete(f.code);
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
        '친구에게 받은 코드를 넣거나, 위의 내 코드를 친구에게 보내 보세요. 여러 명을 고르면 모두 되는 시간을 찾아요.',
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
        h('h2', {}, '아직 같이 볼 사람이 없어요'),
        h('p', {}, '내 코드를 친구에게 보내면, 친구가 링크를 눌러 이름만 적고 바로 나와 비교할 수 있어요.'),
        h('button.primary', { type: 'button', onClick: shareMyCode }, `내 코드 ${formatCode(state.profile.code)} 보내기`),
      ),
    );
    return;
  }
  if (state.selected.size === 0) {
    results.replaceChildren(h('p.hint', {}, '위에서 같이 볼 사람을 골라 주세요.'));
    return;
  }

  const params = new URLSearchParams({
    codes: [...state.selected].join(','),
    start: state.compareWeek,
    days: '7',
    minSlots: String(state.minSlots),
    minLevel: String(state.minLevel),
  });
  const data = await api.get(`/api/compare?${params}`);
  // 친구가 이름을 바꿨으면 목록에도 반영
  friends = loadFriends().map((f) => {
    const p = data.people.find((x) => x.code === f.code);
    return p ? { code: f.code, name: p.name } : f;
  });
  saveFriends(friends);
  const names = data.people.map((p) => (p.isMe ? '나' : p.name));

  const myEmpty = data.dates.every((d) => data.cells[d].every((c) => c.levels[0] === null));
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
            h('p', {}, '내 시간이 비어 있으면 같이 되는 시간을 찾을 수 없어요.'),
            h(
              'div.actions',
              {},
              h('a.button.primary.small', { href: '#calendars' }, '캘린더 연동하기'),
              h('a.button.small', { href: '#weekly' }, '직접 칠하기'),
            ),
          )
        : null,
      h('section.card', {}, h('h2', {}, `${names.join(' · ')} 추천 시간`), suggestions),
      h(
        'section.card',
        {},
        h(
          'div.card-head',
          {},
          h('h2', {}, '함께 보기'),
          saveImageButton(() => ({
            title: `${names.join(' · ')} 언제 봄?`,
            subtitle: `${formatDate(data.dates[0])} – ${formatDate(data.dates[data.dates.length - 1])} · 가장 바쁜 사람 기준`,
            notes: data.suggestions
              .slice(0, 3)
              .map((s, i) => `추천 ${i + 1}. ${formatDate(s.date)} ${slotLabel(s.startSlot)}–${slotLabel(s.endSlot)}`),
            columns: dateColumns(data.dates),
            slots: visibleSlots(),
            cell: (date, slot) => ({ level: data.cells[date][slot].level }),
            filename: `eonjebom-together-${data.dates[0]}.png`,
          })),
        ),
        h('div.toolbar', {}, hoursToggle(rerender)),
        h('p.hint', {}, '각 칸은 가장 바쁜 사람 기준이에요. 한 명이라도 입력하지 않은 칸은 회색이에요.'),
        legend(),
        gridHost,
        detail,
      ),
    ].filter(Boolean),
  );

  renderGrid(gridHost, {
    columns: dateColumns(data.dates),
    slots: visibleSlots(),
    cell: (date, slot) => ({ level: data.cells[date][slot].level }),
    onSelect: (date, slot) => showDetail(date, slot),
  });
}

// ───────────────────────── 기본 시간표 (매주 반복) ─────────────────────────

async function renderWeekly(root) {
  const { cells } = await api.get('/api/weekly');
  const weekly = new Map(cells.map((c) => [`${c.weekday}:${c.slot}`, c.level]));
  const saver = saveIndicator();
  const gridHost = h('div.grid-host');
  const rerender = () => renderWeekly(root).catch(handleError);

  root.replaceChildren(
    h(
      'section.card',
      {},
      h('div.card-head', {}, h('h2', {}, '매주 반복되는 기본 시간표'), saver.el),
      h(
        'p.hint',
        {},
        '수업·알바처럼 매주 같은 일정을 칠해 두세요. 색을 고른 뒤 칸을 끌면 끈 범위가 한 번에 칠해지고 자동으로 저장돼요. ',
        '(예: 07:00 칸부터 08:00 칸까지 끌면 07:00–08:30, 3칸) 캘린더 일정과 날짜별로 직접 칠한 칸이 이 시간표보다 우선해요.',
      ),
      palette(),
      h('p.hint.touch-only', {}, PAINT_HINT),
      h(
        'div.toolbar',
        {},
        hoursToggle(rerender),
        saveImageButton(() => ({
          title: `${state.profile.name}의 기본 시간표`,
          subtitle: '매주 반복',
          columns: WEEKDAYS.map((label, i) => ({ key: String(i), label })),
          slots: visibleSlots(),
          cell: (wd, slot) => ({ level: weekly.get(`${wd}:${slot}`) ?? null }),
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
    cell: (wd, slot) => ({ level: weekly.get(`${wd}:${slot}`) ?? null }),
    onPaint: (changed) => {
      const level = state.brush;
      for (const { key, slot } of changed) {
        if (level === null) weekly.delete(`${key}:${slot}`);
        else weekly.set(`${key}:${slot}`, level);
      }
      grid.update();
      saver
        .run(api.put('/api/weekly', { cells: changed.map(({ key, slot }) => ({ weekday: Number(key), slot, level })) }))
        .catch(handleError);
    },
  });
}

// ───────────────────────── 날짜별 일정 ─────────────────────────

async function renderDates(root) {
  const data = await api.get(`/api/schedule?start=${state.datesWeek}&days=7`);
  const saver = saveIndicator();
  const gridHost = h('div.grid-host');
  const rerender = () => renderDates(root).catch(handleError);
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
          title: `${state.profile.name}의 일정`,
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
      saver
        .run(
          api.put('/api/overrides', { cells: changed.map(({ key, slot }) => ({ date: key, slot, level })) }).then(async () => {
            // 지운 칸은 기본 시간표/캘린더 값으로 돌아가므로 서버에서 다시 계산된 값을 받아 온다.
            Object.assign(data, await api.get(`/api/schedule?start=${data.dates[0]}&days=7`));
            grid.update();
          }),
        )
        .catch(handleError);
      if (level !== null) {
        for (const { key, slot } of changed) data.cells[key][slot] = { level, source: 'override' };
        grid.update();
      }
    },
  });
}

// ───────────────────────── 캘린더 연동 ─────────────────────────

const KIND_LABEL = { google: '구글 캘린더', ics_url: 'iCal 주소', ics_file: '.ics 파일' };

async function renderCalendars(root) {
  const googleResult = hashParams().get('google');
  if (googleResult) {
    history.replaceState(null, '', '#calendars');
    if (googleResult === 'ok') toast('구글 캘린더를 연결했어요.', 'success');
    else toast('구글 캘린더 연결에 실패했어요. 다시 시도해 주세요.', 'error');
  }

  const { calendars, googleEnabled } = await api.get('/api/calendars');
  const rerender = () => renderCalendars(root).catch(handleError);

  const levelSelect = (value, onChange) =>
    h(
      'select',
      { 'aria-label': '일정 시간 표시', onChange: (e) => onChange(Number(e.target.value)) },
      LEVELS.map((l) => h('option', { value: String(l.value), selected: l.value === value }, l.label)),
    );

  const urlInput = h('input', { type: 'url', placeholder: 'https://… 또는 webcal://…', required: true });
  let urlLevel = 1;
  const fileInput = h('input', { type: 'file', accept: '.ics,text/calendar' });
  let fileLevel = 1;
  const busy = (btn, promise) => {
    btn.disabled = true;
    return promise.finally(() => (btn.disabled = false));
  };

  root.replaceChildren(
    h(
      'section.card',
      {},
      h('h2', {}, '구글 캘린더 (삼성 캘린더 포함)'),
      h(
        'p.hint',
        {},
        '일정 제목이나 내용은 읽지 않고, 바쁜 시간만 가져와요. ',
        '삼성 캘린더는 삼성 캘린더 앱에서 일정을 구글 계정과 동기화해 두면 구글 캘린더 연동으로 함께 불러올 수 있어요.',
      ),
      googleEnabled
        ? h(
            'button.primary',
            {
              type: 'button',
              onClick: (e) =>
                busy(
                  e.target,
                  api.post('/api/google/start').then(({ url }) => {
                    location.href = url;
                  }),
                ).catch(handleError),
            },
            '구글 캘린더 연결하기',
          )
        : h(
            'p.notice',
            {},
            '이 서버에는 아직 구글 연동 키(GOOGLE_CLIENT_ID)가 설정되지 않았어요. 아래 iCal 주소나 파일로 연동할 수 있어요.',
          ),
    ),
    h(
      'section.card',
      {},
      h('h2', {}, 'iCal 주소로 연동'),
      h(
        'p.hint',
        {},
        '구글 캘린더 설정 › 내 캘린더 › 캘린더 통합의 "iCal 형식의 비공개 주소", 애플/네이버 캘린더의 구독 주소 등을 붙여 넣으세요. 몇 시간마다 자동으로 다시 가져와요.',
      ),
      h(
        'form.inline-form',
        {
          onSubmit: (e) => {
            e.preventDefault();
            const btn = e.target.querySelector('button');
            busy(btn, api.post('/api/calendars', { kind: 'ics_url', url: urlInput.value, busyLevel: urlLevel }))
              .then(() => {
                toast('캘린더를 연동했어요.', 'success');
                rerender();
              })
              .catch(handleError);
          },
        },
        urlInput,
        levelSelect(urlLevel, (v) => (urlLevel = v)),
        h('button.primary', { type: 'submit' }, '연동'),
      ),
    ),
    h(
      'section.card',
      {},
      h('h2', {}, '.ics 파일 올리기'),
      h('p.hint', {}, '캘린더 앱에서 내보낸 .ics 파일을 올려요. 파일은 한 번만 읽으므로 일정이 바뀌면 다시 올려 주세요.'),
      h(
        'form.inline-form',
        {
          onSubmit: async (e) => {
            e.preventDefault();
            const file = fileInput.files[0];
            if (!file) return toast('파일을 골라 주세요.', 'error');
            if (file.size > 5 * 1024 * 1024) return toast('파일이 너무 커요 (최대 5MB).', 'error');
            const btn = e.target.querySelector('button');
            busy(
              btn,
              file
                .text()
                .then((icsText) =>
                  api.post('/api/calendars', { kind: 'ics_file', name: file.name, icsText, busyLevel: fileLevel }),
                ),
            )
              .then(() => {
                toast('파일을 가져왔어요.', 'success');
                rerender();
              })
              .catch(handleError);
          },
        },
        fileInput,
        levelSelect(fileLevel, (v) => (fileLevel = v)),
        h('button.primary', { type: 'submit' }, '가져오기'),
      ),
    ),
    h(
      'section.card',
      {},
      h('h2', {}, '연동된 캘린더'),
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
                  h('span.kind', {}, KIND_LABEL[c.kind]),
                  h(
                    'span.sync',
                    {},
                    c.lastError
                      ? `⚠ ${c.lastError}`
                      : c.lastSyncedAt
                        ? `마지막 동기화 ${new Date(c.lastSyncedAt).toLocaleString('ko-KR')}`
                        : '',
                  ),
                ),
                h(
                  'div.actions',
                  {},
                  h(
                    'label.inline',
                    {},
                    '일정 시간 = ',
                    levelSelect(c.busyLevel, (v) =>
                      api
                        .patch(`/api/calendars/${c.id}`, { busyLevel: v })
                        .then(() => toast('저장했어요.', 'success'))
                        .catch(handleError),
                    ),
                  ),
                  c.kind !== 'ics_file'
                    ? h(
                        'button.small',
                        {
                          type: 'button',
                          onClick: (e) =>
                            busy(e.target, api.post(`/api/calendars/${c.id}/sync`))
                              .then(() => {
                                toast('다시 가져왔어요.', 'success');
                                rerender();
                              })
                              .catch((err) => {
                                handleError(err);
                                rerender();
                              }),
                        },
                        '지금 동기화',
                      )
                    : null,
                  h(
                    'button.small.danger',
                    {
                      type: 'button',
                      onClick: () => {
                        if (confirm(`'${c.name}' 연동을 해제할까요?`))
                          api.del(`/api/calendars/${c.id}`).then(rerender).catch(handleError);
                      },
                    },
                    '해제',
                  ),
                ),
              ),
            ),
          )
        : h('p.hint', {}, '아직 연동된 캘린더가 없어요.'),
    ),
  );
}

// ───────────────────────── 내 정보 ─────────────────────────

async function renderMe(root) {
  const nameInput = h('input', { name: 'name', value: state.profile.name, maxlength: '20', required: true });
  const linkField = h('input.mono', {
    value: editLink(),
    readonly: true,
    'aria-label': '수정 링크',
    onFocus: (e) => e.target.select(),
  });

  root.replaceChildren(
    h(
      'section.card.my-code',
      {},
      h('h2', {}, '내 코드'),
      h('p.big-code', {}, formatCode(state.profile.code)),
      h('p.hint', {}, '친구에게 이 코드나 링크를 보내면, 친구는 내 시간표를 볼 수만 있고 고칠 수는 없어요.'),
      h('button.primary', { type: 'button', onClick: shareMyCode }, '코드 보내기'),
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
            api
              .patch('/api/me', { name: nameInput.value })
              .then(({ profile }) => {
                state.profile = profile;
                toast('이름을 바꿨어요.', 'success');
                renderShell();
              })
              .catch(handleError);
          },
        },
        nameInput,
        h('button.primary', { type: 'submit' }, '저장'),
      ),
    ),
    h(
      'section.card',
      {},
      h('h2', {}, '수정 링크 (나만 보관)'),
      h(
        'p.hint',
        {},
        '로그인이 없어서, 내 시간표는 이 브라우저에서만 고칠 수 있어요. 이 링크를 다른 폰이나 PC에서 열면 거기서도 고칠 수 있어요. ',
        '브라우저 기록을 지우면 이 링크 없이는 다시 들어올 수 없으니 꼭 저장해 두세요. ',
        h('strong', {}, '다른 사람에게는 보내지 마세요.'),
      ),
      linkField,
      h(
        'div.actions.spaced',
        {},
        h('button.primary.small', { type: 'button', onClick: saveEditLink }, '복사 / 나에게 보내기'),
        h(
          'button.small',
          {
            type: 'button',
            onClick: async () => {
              if (!confirm('새 수정 링크를 만들까요? 이전 링크와, 이전 링크로 연결한 다른 기기에서는 더 이상 고칠 수 없어요.'))
                return;
              try {
                const { editToken } = await api.post('/api/me/edit-token');
                setToken(editToken);
                savePref('linkSaved', null);
                toast('새 수정 링크를 만들었어요. 다시 저장해 두세요.', 'success');
                renderShell();
              } catch (err) {
                handleError(err);
              }
            },
          },
          '새 링크 만들기',
        ),
      ),
    ),
    h(
      'section.card',
      {},
      h('h2', {}, '내 데이터 삭제'),
      h(
        'p.hint',
        {},
        '90일 동안 쓰지 않으면 자동으로 지워져요. 지금 바로 지울 수도 있어요. 지우면 친구들도 내 코드로 더 이상 볼 수 없어요.',
      ),
      h(
        'button.small.danger',
        {
          type: 'button',
          onClick: async () => {
            if (!confirm('내 시간표와 연동한 캘린더 정보를 모두 지울까요? 되돌릴 수 없어요.')) return;
            try {
              await api.del('/api/me');
              setToken(null);
              saveFriends([]);
              savePref('linkSaved', null);
              state.profile = null;
              history.replaceState(null, '', '/');
              renderWelcome('시간표를 삭제했어요.');
            } catch (err) {
              handleError(err);
            }
          },
        },
        '모두 삭제',
      ),
    ),
  );
}

boot();
