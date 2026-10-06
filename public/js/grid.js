import { slotLabel } from './levels.js';

/**
 * 시간표 격자를 그린다. 편집 모드에서는 드래그로 사각형 영역을 한 번에 칠할 수 있다.
 *
 * @param {HTMLElement} container
 * @param {object} opts
 * @param {{key:string, label:string, sub?:string, today?:boolean, past?:boolean}[]} opts.columns
 * @param {[number, number]} opts.slots  표시할 슬롯 범위 [시작, 끝)
 * @param {(key:string, slot:number) => {level:number|null, marks?:string[]}} opts.cell
 * @param {boolean} [opts.editable]
 * @param {() => number|null} [opts.brush]  현재 붓 (null = 지우개)
 * @param {(cells:{key:string, slot:number}[]) => void} [opts.onPaint]
 * @param {(key:string, slot:number, el:HTMLElement) => void} [opts.onSelect]
 */
export function renderGrid(container, opts) {
  const { columns, slots, editable = false } = opts;
  const [from, to] = slots;
  container.replaceChildren();

  const grid = document.createElement('div');
  grid.className = `grid${editable ? ' editable' : ''}`;
  grid.style.gridTemplateColumns = `3.2rem repeat(${columns.length}, minmax(2.4rem, 1fr))`;

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
    if (slot % 2 === 0) t.textContent = slotLabel(slot);
    grid.append(t);
    const row = [];
    columns.forEach((col, ci) => {
      const c = div(`cell${slot % 2 === 0 ? ' hour' : ''}`);
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
    const { level, marks = [] } = opts.cell(col.key, Number(el.dataset.slot));
    el.className = `cell${Number(el.dataset.slot) % 2 === 0 ? ' hour' : ''} lv-${level ?? 'none'}`;
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

    const locate = (x, y) => {
      const el = document.elementFromPoint(x, y)?.closest('.cell');
      return el && grid.contains(el) ? { ci: Number(el.dataset.ci), slot: Number(el.dataset.slot) } : null;
    };

    const rect = () => {
      const c0 = Math.min(anchor.ci, current.ci);
      const c1 = Math.max(anchor.ci, current.ci);
      const s0 = Math.min(anchor.slot, current.slot);
      const s1 = Math.max(anchor.slot, current.slot);
      const out = [];
      for (let s = s0; s <= s1; s++) for (let c = c0; c <= c1; c++) out.push({ ci: c, slot: s });
      return out;
    };

    const preview = () => {
      for (const el of previewed) el.classList.remove('preview', ...previewClasses);
      const b = opts.brush();
      previewed = rect().map(({ ci, slot }) => cells[slot - from][ci]);
      for (const el of previewed) el.classList.add('preview', `pv-${b ?? 'erase'}`);
    };

    grid.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const hit = e.target.closest('.cell') && locate(e.clientX, e.clientY);
      if (!hit) return;
      e.preventDefault();
      grid.setPointerCapture(e.pointerId);
      anchor = current = hit;
      preview();
    });

    grid.addEventListener('pointermove', (e) => {
      if (!anchor) return;
      const hit = locate(e.clientX, e.clientY);
      if (hit && (hit.ci !== current.ci || hit.slot !== current.slot)) {
        current = hit;
        preview();
      }
    });

    const finish = (apply) => {
      if (!anchor) return;
      for (const el of previewed) el.classList.remove('preview', ...previewClasses);
      const changed = apply ? rect().map(({ ci, slot }) => ({ key: columns[ci].key, slot })) : [];
      anchor = current = null;
      previewed = [];
      if (changed.length) opts.onPaint(changed);
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
