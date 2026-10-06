// 서버 없이 브라우저만으로 돌아가는 '미리보기판'을 HTML 파일 하나로 만든다.
// public/js/api.js 대신 preview/mock-api.js 를 넣고, CSS와 JS를 모두 파일 안에 담는다.
//   사용법: npm run build:preview [-- 출력경로]   (기본: dist/preview.html)
import { build } from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(process.argv[2] ?? `${root}/dist/preview.html`);

const swapApi = {
  name: 'swap-api',
  setup(b) {
    b.onResolve({ filter: /^\.\/api\.js$/ }, () => ({ path: `${root}/preview/mock-api.js` }));
  },
};

const result = await build({
  entryPoints: [`${root}/public/js/main.js`],
  bundle: true,
  format: 'iife',
  target: 'es2022',
  minify: true,
  write: false,
  plugins: [swapApi],
  logLevel: 'warning',
});
const js = result.outputFiles[0].text.replaceAll('</script', '<\\/script');
const css = await readFile(`${root}/public/style.css`, 'utf8');

const previewCss = `
.preview-ribbon {
  padding: 0.45rem 1rem;
  background: var(--text);
  color: var(--bg);
  font-size: 0.8rem;
  text-align: center;
  text-wrap: balance;
}
`;

const html = `<title>언제봄 미리보기</title>
<meta name="description" content="친구와 언제 시간이 되는지 색으로 보여 주는 언제봄의 미리보기판">
<style>
${css}
${previewCss}
</style>
<div id="app"><p class="loading">불러오는 중…</p></div>
<div id="toast" class="toast" role="status" aria-live="polite"></div>
<script>
${js}
</script>
`;

await mkdir(dirname(out), { recursive: true });
await writeFile(out, html);
console.log(`미리보기 생성: ${out} (${(html.length / 1024).toFixed(0)} KB)`);
