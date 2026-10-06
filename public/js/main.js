import { api, ApiError } from './api.js';
import { renderGrid } from './grid.js';
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

const app = document.getElementById('app');

const state = {
  user: null,
  googleEnabled: false,
  brush: 5,
  showAllHours: loadPref('showAllHours') === '1',
  datesWeek: mondayOf(todayKst()),
  compareWeek: mondayOf(todayKst()),
  compareWith: new Set(),
  minSlots: 2,
  minLevel: 3,
};

const VIEWS = {
  compare: { title: '언제봄', render: renderCompare },
  weekly: { title: '기본 시간표', render: renderWeekly },
  dates: { title: '날짜별 일정', render: renderDates },
  friends: { title: '친구', render: renderFriends },
  calendars: { title: '캘린더 연동', render: renderCalendars },
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

function handleError(err) {
  if (err instanceof ApiError && err.status === 401) {
    state.user = null;
    renderAuth();
    return;
  }
  toast(err.message || '문제가 발생했습니다.', 'error');
}

function visibleSlots() {
  return state.showAllHours ? [0, SLOTS_PER_DAY] : [16, SLOTS_PER_DAY]; // 기본: 08:00 ~ 24:00
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

function palette(onChange) {
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
          onChange?.();
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

// ───────────────────────── 로그인 / 회원가입 ─────────────────────────

function renderAuth(mode = 'login') {
  const isSignup = mode === 'signup';
  const error = h('p.form-error', { role: 'alert' });
  const form = h(
    'form.card.auth-card',
    {
      onSubmit: async (e) => {
        e.preventDefault();
        const data = Object.fromEntries(new FormData(form));
        try {
          const { user } = await api.post(isSignup ? '/api/auth/signup' : '/api/auth/login', data);
          state.user = user;
          await startApp();
        } catch (err) {
          error.textContent = err.message;
        }
      },
    },
    h('h2', {}, isSignup ? '회원가입' : '로그인'),
    h('label', {}, '아이디', h('input', { name: 'username', required: true, autocomplete: 'username', autocapitalize: 'none' })),
    isSignup
      ? h('label', {}, '이름 (친구에게 보이는 이름)', h('input', { name: 'displayName', required: true, maxlength: '20' }))
      : null,
    h(
      'label',
      {},
      '비밀번호',
      h('input', {
        name: 'password',
        type: 'password',
        required: true,
        minlength: isSignup ? '8' : null,
        autocomplete: isSignup ? 'new-password' : 'current-password',
      }),
    ),
    isSignup ? h('p.hint', {}, '아이디: 영문 소문자·숫자·밑줄 3~20자 / 비밀번호: 8자 이상') : null,
    error,
    h('button.primary', { type: 'submit' }, isSignup ? '가입하기' : '로그인'),
    h(
      'p.switch',
      {},
      isSignup ? '이미 계정이 있나요? ' : '처음이신가요? ',
      h('button.link', { type: 'button', onClick: () => renderAuth(isSignup ? 'login' : 'signup') }, isSignup ? '로그인' : '회원가입'),
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
          'ul.features',
          {},
          h('li', {}, '구글·삼성 캘린더 일정을 불러와 바쁜 시간을 자동으로 표시'),
          h('li', {}, '아주 좋음부터 안 됨까지 5단계 색으로 내 시간표 칠하기'),
          h('li', {}, '친구를 고르면 둘 다 되는 시간을 바로 추천'),
        ),
        legend(),
      ),
      form,
    ),
  );
  form.querySelector('input').focus();
}

// ───────────────────────── 앱 껍데기 ─────────────────────────

function currentView() {
  const name = location.hash.slice(1).split('?')[0];
  return VIEWS[name] ? name : 'compare';
}

function hashParams() {
  return new URLSearchParams(location.hash.split('?')[1] ?? '');
}

async function startApp() {
  try {
    const me = await api.get('/api/me');
    state.user = me.user;
    state.googleEnabled = me.googleEnabled;
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return renderAuth();
    throw err;
  }
  renderShell();
}

function renderShell() {
  const view = currentView();
  const content = h('main.content', { id: 'content' });
  app.replaceChildren(
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
        'div.me',
        {},
        h('span.me-name', {}, `${state.user.displayName} (@${state.user.username})`),
        h(
          'button.link',
          {
            type: 'button',
            onClick: async () => {
              await api.post('/api/auth/logout').catch(() => {});
              state.user = null;
              renderAuth();
            },
          },
          '로그아웃',
        ),
      ),
    ),
    content,
  );
  document.title = `${VIEWS[view].title} · 언제봄`;
  VIEWS[view].render(content).catch(handleError);
}

window.addEventListener('hashchange', () => {
  if (state.user) renderShell();
});

// ───────────────────────── 언제봄 (친구와 비교) ─────────────────────────

async function renderCompare(root) {
  const { friends } = await api.get('/api/friends');
  if (friends.length === 0) {
    root.replaceChildren(
      h(
        'section.card.empty',
        {},
        h('h2', {}, '아직 친구가 없어요'),
        h('p', {}, '친구를 추가하면 둘 다 시간이 되는 때를 찾아 드려요.'),
        h('a.button.primary', { href: '#friends' }, '친구 추가하러 가기'),
      ),
    );
    return;
  }
  for (const id of state.compareWith) if (!friends.some((f) => f.id === id)) state.compareWith.delete(id);
  if (hashParams().has('with')) {
    // 친구 목록의 '언제 봄?' 링크로 들어온 경우: 한 번만 반영하고 주소에서 지운다.
    const requested = Number(hashParams().get('with'));
    if (friends.some((f) => f.id === requested)) state.compareWith = new Set([requested]);
    history.replaceState(null, '', '#compare');
  }
  if (state.compareWith.size === 0) state.compareWith.add(friends[0].id);

  const results = h('div.compare-results');
  const rerender = () => renderCompare(root).catch(handleError);

  const chips = h(
    'div.chips',
    { role: 'group', 'aria-label': '같이 볼 친구' },
    friends.map((f) =>
      h(
        'button.chip',
        {
          type: 'button',
          'aria-pressed': String(state.compareWith.has(f.id)),
          onClick: () => {
            if (state.compareWith.has(f.id)) {
              if (state.compareWith.size > 1) state.compareWith.delete(f.id);
            } else state.compareWith.add(f.id);
            rerender();
          },
        },
        f.displayName,
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

  root.replaceChildren(
    h(
      'section.card',
      {},
      h('h2', {}, '누구랑 볼까요?'),
      chips,
      h(
        'div.toolbar',
        {},
        weekNav(state.compareWeek, (w) => {
          state.compareWeek = w;
          rerender();
        }),
        select('최소', state.minSlots, [[1, '30분'], [2, '1시간'], [3, '1시간 30분'], [4, '2시간'], [6, '3시간']], (v) => {
          state.minSlots = v;
          rerender();
        }),
        select('기준', state.minLevel, [[4, '좋음 이상'], [3, '애매함 이상']], (v) => {
          state.minLevel = v;
          rerender();
        }),
      ),
    ),
    results,
  );

  const params = new URLSearchParams({
    with: [...state.compareWith].join(','),
    start: state.compareWeek,
    days: '7',
    minSlots: String(state.minSlots),
    minLevel: String(state.minLevel),
  });
  const data = await api.get(`/api/compare?${params}`);
  const names = data.people.map((p) => (p.isMe ? '나' : p.displayName));

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
          const duration = `${minutes >= 60 ? `${Math.floor(minutes / 60)}시간` : ''}${minutes % 60 ? ` ${minutes % 60}분` : ''}`.trim();
          return h(
            'li',
            {},
            h(
              'button.suggestion',
              { type: 'button', onClick: () => showDetail(s.date, s.startSlot) },
              swatch(s.minLevel),
              h('span.when', {}, `${formatDate(s.date)} ${slotLabel(s.startSlot)}–${slotLabel(s.endSlot)}`),
              h('span.meta', {}, `${duration} · 모두 '${levelLabel(s.minLevel)}' 이상`),
            ),
          );
        }),
      )
    : h('p.hint', {}, '이번 주에는 조건에 맞는 시간이 없어요. 기준을 낮추거나 다른 주를 확인해 보세요.');

  const gridHost = h('div.grid-host');
  results.replaceChildren(
    h('section.card', {}, h('h2', {}, `${names.join(' · ')} 추천 시간`), suggestions),
    h(
      'section.card',
      {},
      h('div.card-head', {}, h('h2', {}, '함께 보기'), hoursToggle(rerender)),
      h('p.hint', {}, '각 칸은 모두 중에서 가장 안 되는 사람 기준이에요. 한 명이라도 입력하지 않았으면 회색으로 보여요.'),
      legend(),
      gridHost,
      detail,
    ),
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
        '수업·알바처럼 매주 같은 일정을 칠해 두세요. 색을 고른 뒤 칸을 끌어서 칠하면 자동으로 저장돼요. ',
        '캘린더 일정과 날짜별로 직접 칠한 칸이 이 시간표보다 우선해요.',
      ),
      palette(),
      h('div.toolbar', {}, hoursToggle(rerender)),
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
      ),
      palette(),
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
    cell: (date, slot) => {
      const c = data.cells[date][slot];
      return {
        level: c.level,
        marks: c.source === 'calendar' ? ['from-calendar'] : c.source === 'override' ? ['from-override'] : [],
      };
    },
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

// ───────────────────────── 친구 ─────────────────────────

async function renderFriends(root) {
  const { friends, incoming, outgoing } = await api.get('/api/friends');
  const rerender = () => renderFriends(root).catch(handleError);
  const act = (promise, message) =>
    promise
      .then(() => {
        if (message) toast(message, 'success');
        rerender();
      })
      .catch(handleError);

  const input = h('input', { name: 'username', placeholder: '친구 아이디', required: true, autocapitalize: 'none' });
  const person = (f, ...actions) =>
    h('li.person', {}, h('span.name', {}, f.displayName, h('span.username', {}, ` @${f.username}`)), h('span.actions', {}, actions));

  root.replaceChildren(
    h(
      'section.card',
      {},
      h('h2', {}, '친구 추가'),
      h('p.hint', {}, '내 아이디 ', h('strong', {}, `@${state.user.username}`), ' 를 친구에게 알려 주거나, 친구 아이디로 요청을 보내세요.'),
      h(
        'form.inline-form',
        {
          onSubmit: (e) => {
            e.preventDefault();
            act(
              api.post('/api/friends', { username: input.value }).then((r) => {
                input.value = '';
                return r;
              }),
              '친구 요청을 보냈어요.',
            );
          },
        },
        input,
        h('button.primary', { type: 'submit' }, '요청 보내기'),
      ),
    ),
    incoming.length
      ? h(
          'section.card',
          {},
          h('h2', {}, `받은 요청 ${incoming.length}`),
          h(
            'ul.people-list',
            {},
            incoming.map((f) =>
              person(
                f,
                h('button.primary.small', { type: 'button', onClick: () => act(api.post(`/api/friends/${f.friendshipId}/accept`), '친구가 되었어요!') }, '수락'),
                h('button.small', { type: 'button', onClick: () => act(api.del(`/api/friends/${f.friendshipId}`)) }, '거절'),
              ),
            ),
          ),
        )
      : null,
    h(
      'section.card',
      {},
      h('h2', {}, `내 친구 ${friends.length}`),
      friends.length
        ? h(
            'ul.people-list',
            {},
            friends.map((f) =>
              person(
                f,
                h('a.button.primary.small', { href: `#compare?with=${f.id}` }, '언제 봄?'),
                h(
                  'button.small',
                  {
                    type: 'button',
                    onClick: () => {
                      if (confirm(`${f.displayName} 님을 친구에서 삭제할까요?`)) act(api.del(`/api/friends/${f.friendshipId}`));
                    },
                  },
                  '삭제',
                ),
              ),
            ),
          )
        : h('p.hint', {}, '아직 친구가 없어요.'),
    ),
    outgoing.length
      ? h(
          'section.card',
          {},
          h('h2', {}, '보낸 요청'),
          h(
            'ul.people-list',
            {},
            outgoing.map((f) =>
              person(f, h('button.small', { type: 'button', onClick: () => act(api.del(`/api/friends/${f.friendshipId}`)) }, '취소')),
            ),
          ),
        )
      : null,
  );
}

// ───────────────────────── 캘린더 연동 ─────────────────────────

const KIND_LABEL = { google: '구글 캘린더', ics_url: 'iCal 주소', ics_file: '.ics 파일' };

async function renderCalendars(root) {
  const params = hashParams();
  const googleResult = params.get('google');
  if (googleResult) {
    history.replaceState(null, '', '#calendars');
    if (googleResult === 'ok') toast('구글 캘린더를 연결했어요.', 'success');
    else if (googleResult === 'disabled') toast('이 서버에는 구글 연동이 설정되어 있지 않아요.', 'error');
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
        ? h('a.button.primary', { href: '/api/google/connect' }, '구글 캘린더 연결하기')
        : h('p.notice', {}, '이 서버에는 아직 구글 연동 키(GOOGLE_CLIENT_ID)가 설정되지 않았어요. 아래 iCal 주소나 파일로 연동할 수 있어요.'),
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
            busy(btn, file.text().then((icsText) => api.post('/api/calendars', { kind: 'ics_file', name: file.name, icsText, busyLevel: fileLevel })))
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
      h('p.hint', {}, '캘린더 일정이 있는 시간을 어떤 색으로 칠할지 캘린더마다 정할 수 있어요. (예: 회사 캘린더는 "안 됨", 개인 약속은 "웬만하면 안 됨")'),
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
                    c.lastError ? `⚠ ${c.lastError}` : c.lastSyncedAt ? `마지막 동기화 ${new Date(c.lastSyncedAt).toLocaleString('ko-KR')}` : '',
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
                        if (confirm(`'${c.name}' 연동을 해제할까요?`)) api.del(`/api/calendars/${c.id}`).then(rerender).catch(handleError);
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

startApp().catch(handleError);
