// 배경에서 벚꽃잎이 아래로 흩날리는 애니메이션. 내용(카드) 뒤에 그려서 글씨를 가리지 않는다.
// 기기의 '동작 줄이기' 설정이 켜져 있으면 움직이지 않고, 탭이 안 보일 때는 멈춘다.

const COLORS = ['#fbd3dc', '#f9c0cf', '#fde4ea', '#f6b3c4'];

/** @param {HTMLCanvasElement} canvas */
export function startPetals(canvas) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  let width = 0;
  let height = 0;
  let petals = [];
  let last = 0;
  let frame = 0;

  const rand = (min, max) => min + Math.random() * (max - min);

  const makePetal = (anywhere) => ({
    x: rand(-20, width + 20),
    y: anywhere ? rand(-height, height) : rand(-60, -10),
    size: rand(10, 19),
    fall: rand(32, 78), // 초당 px
    drift: rand(8, 26), // 바람에 옆으로 밀리는 정도
    sway: rand(22, 56), // 좌우로 흔들리는 폭
    phase: rand(0, Math.PI * 2),
    swaySpeed: rand(0.6, 1.4),
    rotation: rand(0, Math.PI * 2),
    spin: rand(-1.2, 1.2),
    flip: rand(0, Math.PI * 2),
    flipSpeed: rand(1.5, 3.5),
    color: COLORS[Math.floor(Math.random() * COLORS.length)],
  });

  const resize = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const count = Math.round(Math.min(32, Math.max(12, (width * height) / 32000))); // 꽃잎이 큰 만큼 수는 조금 줄임
    while (petals.length < count) petals.push(makePetal(true));
    petals.length = count;
  };

  const draw = (p, t) => {
    const x = p.x + Math.sin(t * p.swaySpeed + p.phase) * p.sway;
    ctx.save();
    ctx.translate(x, p.y);
    ctx.rotate(p.rotation);
    ctx.scale(Math.max(0.25, Math.abs(Math.cos(p.flip))), 1); // 뒤집히며 떨어지는 느낌
    const s = p.size;
    ctx.beginPath();
    // 끝이 살짝 갈라진 벚꽃잎 모양
    ctx.moveTo(0, s);
    ctx.bezierCurveTo(s * 0.95, s * 0.45, s * 0.75, -s * 0.75, s * 0.18, -s);
    ctx.lineTo(0, -s * 0.72);
    ctx.lineTo(-s * 0.18, -s);
    ctx.bezierCurveTo(-s * 0.75, -s * 0.75, -s * 0.95, s * 0.45, 0, s);
    ctx.fillStyle = p.color;
    ctx.globalAlpha = 0.92;
    ctx.fill();
    // 꽃잎이 커진 만큼 가장자리와 가운데 결을 살짝 그려 납작해 보이지 않게
    ctx.lineWidth = 0.9;
    ctx.strokeStyle = 'rgba(214, 120, 150, 0.45)';
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, s * 0.8);
    ctx.lineTo(0, -s * 0.5);
    ctx.strokeStyle = 'rgba(214, 120, 150, 0.25)';
    ctx.stroke();
    ctx.restore();
  };

  const tick = (now) => {
    frame = requestAnimationFrame(tick);
    const dt = Math.min(0.05, (now - (last || now)) / 1000);
    last = now;
    const t = now / 1000;
    ctx.clearRect(0, 0, width, height);
    for (let i = 0; i < petals.length; i++) {
      const p = petals[i];
      p.y += p.fall * dt;
      p.x += p.drift * dt;
      p.rotation += p.spin * dt;
      p.flip += p.flipSpeed * dt;
      if (p.y > height + 30 || p.x > width + 60) petals[i] = makePetal(false);
      else draw(p, t);
    }
  };

  const play = () => {
    if (!frame) {
      last = 0;
      frame = requestAnimationFrame(tick);
    }
  };
  const pause = () => {
    cancelAnimationFrame(frame);
    frame = 0;
  };

  resize();
  window.addEventListener('resize', resize);
  document.addEventListener('visibilitychange', () => (document.hidden ? pause() : play()));
  play();
}
