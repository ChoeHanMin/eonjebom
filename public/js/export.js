// 시간표를 PNG 이미지로 그려서 휴대폰 갤러리(공유 창의 '이미지 저장')나 PC 다운로드로 저장한다.
// 화면 캡처 라이브러리 없이 캔버스에 직접 그리므로 어느 기기에서나 같은 모양으로 나온다.
import { LEVELS, slotLabel } from './levels.js';

// 갤러리에서 보기 좋도록 화면의 다크 모드와 상관없이 밝은 색으로 그린다.
const COLORS = {
  3: '#22c55e',
  2: '#facc15',
  1: '#ef4444',
  none: '#e8eae6',
  bg: '#ffffff',
  text: '#1c1f1a',
  muted: '#6b7166',
  line: '#ffffff',
  hourLine: '#c9cec4',
  accent: '#16a34a',
};
const FONT = "'Pretendard', 'Apple SD Gothic Neo', 'Noto Sans KR', 'Malgun Gothic', system-ui, sans-serif";

const SCALE = 2;
const PAD = 28;
const TIME_W = 56;
const ROW_H = 20;
const HEAD_H = 44;

/**
 * @param {object} opts
 * @param {string} opts.title
 * @param {string} [opts.subtitle]
 * @param {string[]} [opts.notes]  아래쪽에 적을 줄 (예: 추천 시간)
 * @param {{key:string, label:string, sub?:string}[]} opts.columns
 * @param {[number, number]} opts.slots
 * @param {(key:string, slot:number) => {level:number|null, marks?:string[]}} opts.cell
 * @param {string} opts.filename  영문으로 (한글 파일 이름은 일부 브라우저에서 무시됨)
 * @returns {Promise<{result: 'shared'|'downloaded'|'cancelled'|'show', url?: string}>}
 *   'show' 이면 파일 저장이 막힌 환경(다른 페이지 안)이라, url 의 이미지를 화면에 띄워 길게 눌러 저장하게 한다.
 */
export async function saveGridImage(opts) {
  const canvas = drawGrid(opts);
  // 다른 페이지 안(claude.ai 미리보기 등)에서는 다운로드·공유가 막혀 있으므로 이미지를 띄워 길게 눌러 저장하게 한다.
  if (isEmbedded()) return { result: 'show', url: canvas.toDataURL('image/png') };
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('이미지를 만들지 못했어요.');
  const file = new File([blob], opts.filename, { type: 'image/png' });

  // 휴대폰: 공유 창 → '이미지 저장'(아이폰) / '갤러리에 저장' 등으로 사진첩에 바로 저장
  if (isTouchDevice() && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: opts.title });
      return { result: 'shared' };
    } catch (err) {
      if (err?.name === 'AbortError') return { result: 'cancelled' };
      // 공유가 막힌 환경이면 다운로드로 대신한다.
    }
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = opts.filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return { result: 'downloaded' };
}

function isEmbedded() {
  try {
    return window.top !== window.self;
  } catch {
    return true;
  }
}

function isTouchDevice() {
  return matchMedia('(pointer: coarse)').matches;
}

export function drawGrid({ title, subtitle, notes = [], columns, slots, cell }) {
  const [from, to] = slots;
  const colW = columns.length > 7 ? 64 : 84;
  const gridW = TIME_W + colW * columns.length;
  const width = PAD * 2 + gridW;
  const titleH = subtitle ? 64 : 42;
  const legendH = 30;
  const notesH = notes.length ? 18 + notes.length * 22 : 0;
  const footerH = 34;
  const height = PAD + titleH + legendH + HEAD_H + (to - from) * ROW_H + notesH + footerH + PAD / 2;

  const canvas = document.createElement('canvas');
  canvas.width = width * SCALE;
  canvas.height = height * SCALE;
  const ctx = canvas.getContext('2d');
  ctx.scale(SCALE, SCALE);
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, width, height);
  ctx.textBaseline = 'middle';

  // 제목
  let y = PAD;
  ctx.fillStyle = COLORS.text;
  ctx.font = `800 22px ${FONT}`;
  ctx.fillText(title, PAD, y + 12, gridW);
  if (subtitle) {
    ctx.fillStyle = COLORS.muted;
    ctx.font = `500 14px ${FONT}`;
    ctx.fillText(subtitle, PAD, y + 40, gridW);
  }
  y += titleH;

  // 범례
  let x = PAD;
  ctx.font = `500 13px ${FONT}`;
  for (const item of [...LEVELS.map((l) => ({ level: l.value, label: l.label })), { level: null, label: '미입력' }]) {
    roundRect(ctx, x, y + 2, 14, 14, 3, COLORS[item.level ?? 'none']);
    ctx.fillStyle = COLORS.muted;
    ctx.fillText(item.label, x + 20, y + 9);
    x += 20 + ctx.measureText(item.label).width + 16;
  }
  y += legendH;

  // 요일/날짜 머리줄
  const gx = PAD;
  ctx.textAlign = 'center';
  columns.forEach((col, i) => {
    const cx = gx + TIME_W + colW * i + colW / 2;
    ctx.fillStyle = COLORS.text;
    ctx.font = `700 14px ${FONT}`;
    ctx.fillText(col.label, cx, y + (col.sub ? 14 : HEAD_H / 2));
    if (col.sub) {
      ctx.fillStyle = COLORS.muted;
      ctx.font = `500 12px ${FONT}`;
      ctx.fillText(col.sub, cx, y + 31);
    }
  });
  y += HEAD_H;

  // 칸
  for (let slot = from; slot < to; slot++) {
    const ry = y + (slot - from) * ROW_H;
    ctx.textAlign = 'right';
    ctx.fillStyle = slot % 2 === 0 ? COLORS.text : COLORS.muted;
    ctx.font = `${slot % 2 === 0 ? 600 : 400} 11px ${FONT}`;
    ctx.fillText(slotLabel(slot), gx + TIME_W - 8, ry + ROW_H / 2);
    columns.forEach((col, i) => {
      const { level, marks = [] } = cell(col.key, slot);
      const cx = gx + TIME_W + colW * i;
      ctx.fillStyle = COLORS[level ?? 'none'];
      ctx.fillRect(cx, ry, colW, ROW_H);
      if (marks.includes('from-calendar')) hatch(ctx, cx, ry, colW, ROW_H);
      if (marks.includes('from-override')) {
        ctx.fillStyle = 'rgba(0,0,0,0.5)';
        ctx.beginPath();
        ctx.arc(cx + colW / 2, ry + ROW_H / 2, 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
    });
    // 칸 사이 선: 정각은 진하게
    ctx.fillStyle = slot % 2 === 0 ? COLORS.hourLine : COLORS.line;
    ctx.fillRect(gx + TIME_W, ry, colW * columns.length, 1);
  }
  ctx.fillStyle = COLORS.line;
  for (let i = 1; i < columns.length; i++) ctx.fillRect(gx + TIME_W + colW * i - 1, y, 2, (to - from) * ROW_H);
  y += (to - from) * ROW_H;

  // 메모(추천 시간 등)
  ctx.textAlign = 'left';
  if (notes.length) {
    y += 18;
    ctx.font = `600 14px ${FONT}`;
    for (const note of notes) {
      ctx.fillStyle = COLORS.text;
      ctx.fillText(note, PAD, y + 10, gridW);
      y += 22;
    }
  }

  // 바닥글
  ctx.fillStyle = COLORS.accent;
  ctx.font = `800 13px ${FONT}`;
  ctx.fillText('언제봄', PAD, y + 22);
  ctx.fillStyle = COLORS.muted;
  ctx.font = `500 12px ${FONT}`;
  ctx.fillText(`${location.host}`, PAD + 52, y + 22);
  return canvas;
}

function roundRect(ctx, x, y, w, h, r, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.fill();
}

function hatch(ctx, x, y, w, h) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.strokeStyle = 'rgba(0,0,0,0.18)';
  ctx.lineWidth = 1;
  for (let i = -h; i < w; i += 6) {
    ctx.beginPath();
    ctx.moveTo(x + i, y + h);
    ctx.lineTo(x + i + h, y);
    ctx.stroke();
  }
  ctx.restore();
}
