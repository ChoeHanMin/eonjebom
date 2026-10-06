// 언제봄을 서버 없이 열리는 HTML 파일 하나로 만든다. (CSS·JS 모두 파일 안에 포함)
//   npm run build  → dist/index.html    어디에 올려도 되는 완성된 페이지 (GitHub Pages 등)
//                    dist/artifact.html claude.ai 미리보기용: <html>/<head> 껍데기 없이 내용만
//   npm run dev    → 파일이 바뀔 때마다 다시 만든다. dist/index.html 을 브라우저로 열어 확인
import { context } from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = `${root}/dist`;
const watch = process.argv.includes('--watch');

const ICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect x='3' y='3' width='12' height='12' rx='3' fill='%2322c55e'/%3E%3Crect x='17' y='3' width='12' height='12' rx='3' fill='%23facc15'/%3E%3Crect x='3' y='17' width='12' height='12' rx='3' fill='%23facc15'/%3E%3Crect x='17' y='17' width='12' height='12' rx='3' fill='%23ef4444'/%3E%3C/svg%3E";

const MIME = { webp: 'image/webp', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', svg: 'image/svg+xml' };

async function inlineAssets(css) {
  const refs = [...new Set([...css.matchAll(/url\('\.\/(assets\/[^']+)'\)/g)].map((m) => m[1]))];
  for (const ref of refs) {
    const data = await readFile(`${root}/public/${ref}`);
    const mime = MIME[ref.split('.').pop().toLowerCase()];
    if (!mime) throw new Error(`알 수 없는 그림 형식: ${ref}`);
    css = css.replaceAll(`url('./${ref}')`, `url('data:${mime};base64,${data.toString('base64')}')`);
  }
  return css;
}

async function writeHtml(js) {
  // CSS 가 가리키는 그림 파일을 data: 주소로 바꿔 넣어, HTML 파일 하나만으로 동작하게 한다.
  const css = await inlineAssets(await readFile(`${root}/public/style.css`, 'utf8'));
  const script = js.replaceAll('</script', '<\\/script');
  const body = `<div id="app"><p class="loading">불러오는 중…</p></div>
<div id="toast" class="toast" role="status" aria-live="polite"></div>
<script>
${script}
</script>`;

  const page = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#16a34a">
<meta name="description" content="친구와 언제 시간이 되는지 색으로 보여 주는 시간표 비교 앱">
<title>언제봄</title>
<link rel="icon" href="${ICON}">
<style>
${css}
</style>
</head>
<body>
${body}
</body>
</html>
`;
  const fragment = `<title>언제봄</title>
<style>
${css}
</style>
${body}
`;
  await mkdir(dist, { recursive: true });
  await writeFile(`${dist}/index.html`, page);
  await writeFile(`${dist}/artifact.html`, fragment);
  console.log(`[build] dist/index.html (${(page.length / 1024).toFixed(0)} KB) · dist/artifact.html`);
}

const ctx = await context({
  entryPoints: [`${root}/public/js/main.js`],
  bundle: true,
  format: 'iife',
  target: 'es2022',
  minify: !watch,
  write: false,
  logLevel: 'warning',
  plugins: [
    {
      name: 'single-html',
      setup(b) {
        b.onEnd(async (result) => {
          if (result.errors.length === 0) await writeHtml(result.outputFiles[0].text);
        });
      },
    },
  ],
});

if (watch) {
  await ctx.watch();
  console.log('[build] 변경을 기다리는 중… (Ctrl+C 로 종료)');
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
