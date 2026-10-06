import { slotLabel } from './levels.js';

const EDGE_PX = 40; // 칠하는 중 가장자리에 손가락/마우스가 이만큼 가까우면 자동 스크롤
const MAX_SCROLL_STEP = 14;

/**
 * 엑셀처럼 30분 = 1칸인 시간표 격자를 그린다. (하루 48칸)
 * 편집 모드에서는 색을 고른 뒤 드래그하면 사각형 범위를 한 번에 칠한다. (마우스·터치 모두)
 * 고른 색과 같은 색 칸에서 시작하면(클릭 포함) 그 범위를 지운다. (when2meet 과 같은 방식)
 *
 * @param {HTMLElement} container  스크롤되는 상자 (.grid-host)
 * @param {object} opts
 * @param {{key:string, label:string, sub?:string, today?:boolean, past?:boolean}[]} opts.columns
 * @param {[number, number]} opts.slots  표시할 슬롯 범위 [시작, 끝)
 * @param {(key:string, slot:number) => {level:number|null, marks?:string[], erasable?:boolean}} opts.cell
 *   erasable 이 false 인 칸은 같은 색이어도 지우기로 바꾸지 않는다. (직접 칠한 칸이 아닌 경우 등)
 * @param {boolean} [opts.editable]
 * @param {() => number} [opts.brush]  현재 고른 색
 * @param {(cells:{key:string, slot:number}[], level:number|null) => void} [opts.onPaint]  level 이 null 이면 지우기
 * @param {(key:string, slot:number, el:HTMLElement) => void} [opts.onSelect]
 */
export function renderGrid(container, opts) {
  const { columns, slots, editable = false } = opts;
  const [from, to] = slots;
  container.replaceChildren();

  const grid = document.createElement('div');
  grid.className = `grid${editable ? ' editable' : ''}`;
  grid.style.gridTemplateColumns = `3.4rem repeat(${columns.length}, minmax(2.3rem, 1fr))`;

  grid.append(div('corner'));
  for (const col of columns) {
    const h = div(`col-head${col.today ? ' today' : ''}${col.past ? ' past' : ''}`);
    h.append(span('col-label', col.label));
    if (col.sub) h.append(span('col-sub', col.sub));
    grid.append(h);
  }

  const cells = []; // cells[slot - from][colIndex]
  for (let slot = from; slot < to; slot++) {
    const t = div(`time${slot % 2 === 0 ? ' hour' : ''}`);
    t.textContent = slotLabel(slot);
    grid.append(t);
    const row = [];
    columns.forEach((col, ci) => {
      const c = div('cell');
      c.dataset.ci = ci;
      c.dataset.slot = slot;
      row.push(c);
      grid.append(c);
    });
    cells.push(row);
  }
  container.append(grid);

  function paintCell(el) {
    const col = columns[el.dataset.ci];
    const slot = Number(el.dataset.slot);
    const { level, marks = [] } = opts.cell(col.key, slot);
    el.className = `cell${slot % 2 === 0 ? ' hour' : ''} lv-${level ?? 'none'}`;
    if (col.past) el.classList.add('past');
    for (const m of marks) el.classList.add(m);
  }

  function update() {
    for (const row of cells) for (const el of row) paintCell(el);
  }
  update();

  if (editable) attachPainting();
  else if (opts.onSelect) {
    grid.addEventListener('click', (e) => {
      const el = e.target.closest('.cell');
      if (!el) return;
      grid.querySelector('.cell.selected')?.classList.remove('selected');
      el.classList.add('selected');
      opts.onSelect(columns[el.dataset.ci].key, Number(el.dataset.slot), el);
    });
  }

  function attachPainting() {
    let anchor = null;
    let current = null;
    let previewed = [];
    let pointer = null; // 마지막 포인터 위치
    let origin = null; // 드래그를 시작한 위치
    let stroke = null; // 이번 드래그에서 칠할 값 (null = 지우기)
    let scrollFrame = 0;
    const tip = div('drag-tip');

    const locate = (x, y) => {
      const el = document.elementFromPoint(x, y)?.closest('.cell');
      return el && grid.contains(el) ? { ci: Number(el.dataset.ci), slot: Number(el.dataset.slot) } : null;
    };

    const bounds = () => ({
      c0: Math.min(anchor.ci, current.ci),
      c1: Math.max(anchor.ci, current.ci),
      s0: Math.min(anchor.slot, current.slot),
      s1: Math.max(anchor.slot, current.slot),
    });

    const rect = () => {
      const { c0, c1, s0, s1 } = bounds();
      const out = [];
      for (let s = s0; s <= s1; s++) for (let c = c0; c <= c1; c++) out.push({ ci: c, slot: s });
      return out;
    };

    // 예: '월 07:00–08:30 · 3칸', '월–수 07:00–08:30 · 9칸'
    const describe = () => {
      const { c0, c1, s0, s1 } = bounds();
      const cols = c0 === c1 ? columns[c0].label : `${columns[c0].label}–${columns[c1].label}`;
      const count = (s1 - s0 + 1) * (c1 - c0 + 1);
      return `${stroke === null ? '지우기 · ' : ''}${cols} ${slotLabel(s0)}–${slotLabel(s1 + 1)} · ${count}칸`;
    };

    const preview = () => {
      for (const el of previewed) el.classList.remove('preview', ...previewClasses);
      const b = stroke;
      previewed = rect().map(({ ci, slot }) => cells[slot - from][ci]);
      for (const el of previewed) el.classList.add('preview', `pv-${b ?? 'erase'}`);
      tip.textContent = describe();
      tip.className = `drag-tip show pv-${b ?? 'erase'}`;
      placeTip();
    };

    // 범위 표시는 격자 상자 위쪽(요일 머리줄 자리)에 띄운다. 손가락 바로 위에 두면 칠하는 칸을 가린다.
    // 손가락이 그 근처에 있으면 상자 아래쪽으로 옮긴다.
    const placeTip = () => {
      if (!pointer) return;
      const box = container.getBoundingClientRect();
      const w = tip.offsetWidth;
      const tipH = tip.offsetHeight;
      const x = Math.min(Math.max(8, box.left + box.width / 2 - w / 2), window.innerWidth - w - 8);
      const top = Math.max(box.top, 0) + 6;
      const bottom = Math.min(box.bottom, window.innerHeight) - tipH - 6;
      const y = pointer.y < top + tipH + 50 ? bottom : top;
      tip.style.transform = `translate(${x}px, ${y}px)`;
    };

    // 가장자리 근처에서는 상자(또는 페이지)를 스크롤하며 계속 칠할 수 있게 한다.
    const autoScroll = () => {
      scrollFrame = 0;
      if (!anchor || !pointer) return;
      const box = container.getBoundingClientRect();
      const top = Math.max(box.top, 0);
      const bottom = Math.min(box.bottom, window.innerHeight);
      const left = Math.max(box.left, 0);
      const right = Math.min(box.right, window.innerWidth);
      const step = (dist) => Math.ceil(MAX_SCROLL_STEP * (1 - Math.max(dist, 0) / EDGE_PX));
      // 가장자리 쪽으로 실제로 끌고 있을 때만 스크롤한다. (가장자리 칸에서 시작해 옆으로 끌 때는 스크롤하지 않음)
      const MOVED = 12;
      let dy = 0;
      let dx = 0;
      if (pointer.y > bottom - EDGE_PX && pointer.y - origin.y > MOVED) dy = step(bottom - pointer.y);
      else if (pointer.y < top + EDGE_PX + 40 && origin.y - pointer.y > MOVED) dy = -step(pointer.y - top - 40); // 위쪽은 요일 머리줄만큼 여유
      if (pointer.x > right - EDGE_PX && pointer.x - origin.x > MOVED) dx = step(right - pointer.x);
      else if (pointer.x < left + EDGE_PX + 54 && origin.x - pointer.x > MOVED) dx = -step(pointer.x - left - 54); // 왼쪽은 시간 줄만큼 여유
      if (!dy && !dx) return;
      const beforeTop = container.scrollTop;
      const beforeLeft = container.scrollLeft;
      const beforeWindow = window.scrollY;
      container.scrollBy(dx, dy);
      if (dy && container.scrollTop === beforeTop) window.scrollBy(0, dy);
      const moved = container.scrollTop !== beforeTop || container.scrollLeft !== beforeLeft || window.scrollY !== beforeWindow;
      if (!moved) return; // 더 스크롤할 곳이 없음
      const hit = locate(pointer.x, pointer.y);
      if (hit && (hit.ci !== current.ci || hit.slot !== current.slot)) {
        current = hit;
        preview();
      }
      scrollFrame = requestAnimationFrame(autoScroll);
    };

    grid.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const hit = e.target.closest('.cell') && locate(e.clientX, e.clientY);
      if (!hit) return;
      e.preventDefault();
      grid.setPointerCapture(e.pointerId);
      document.body.append(tip);
      pointer = origin = { x: e.clientX, y: e.clientY };
      anchor = current = hit;
      // 고른 색과 같은 색 칸에서 시작하면 이번 드래그는 '지우기'
      const start = opts.cell(columns[hit.ci].key, hit.slot);
      const brush = opts.brush();
      stroke = start.level === brush && start.erasable !== false ? null : brush;
      preview();
    });

    grid.addEventListener('pointermove', (e) => {
      if (!anchor) return;
      pointer = { x: e.clientX, y: e.clientY };
      const hit = locate(e.clientX, e.clientY);
      if (hit && (hit.ci !== current.ci || hit.slot !== current.slot)) {
        current = hit;
        preview();
      } else {
        placeTip();
      }
      if (!scrollFrame) scrollFrame = requestAnimationFrame(autoScroll);
    });

    const finish = (apply) => {
      if (!anchor) return;
      cancelAnimationFrame(scrollFrame);
      scrollFrame = 0;
      tip.remove();
      for (const el of previewed) el.classList.remove('preview', ...previewClasses);
      const changed = apply ? rect().map(({ ci, slot }) => ({ key: columns[ci].key, slot })) : [];
      anchor = current = pointer = origin = null;
      previewed = [];
      if (changed.length) opts.onPaint(changed, stroke);
    };
    grid.addEventListener('pointerup', () => finish(true));
    grid.addEventListener('pointercancel', () => finish(false));
  }

  return { update };
}

const previewClasses = ['pv-1', 'pv-2', 'pv-3', 'pv-erase'];

function div(className) {
  const d = document.createElement('div');
  d.className = className;
  return d;
}

function span(className, text) {
  const s = document.createElement('span');
  s.className = className;
  s.textContent = text;
  return s;
}
