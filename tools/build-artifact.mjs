// Builds one self-contained practice page (no Firebase) from docs/ for the Claude artifact preview.
// node tools/build-artifact.mjs out.html
import { build } from 'esbuild';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = process.argv[2] || path.join(root, 'practice.html');
const r = await build({
  entryPoints: [path.join(root, 'docs/app.js')],
  bundle: true, format: 'esm', write: false, minify: false, logLevel: 'error',
  plugins: [{
    name: 'no-firebase',
    setup(b) {
      b.onResolve({ filter: /firebase-config\.js$/ }, () => ({ path: 'cfg', namespace: 'cfg' }));
      b.onLoad({ filter: /.*/, namespace: 'cfg' }, () => ({ contents: 'export const firebaseConfig = null;', loader: 'js' }));
    },
  }],
});
const js = r.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const css = readFileSync(path.join(root, 'docs/style.css'), 'utf8');
let html = readFileSync(path.join(root, 'docs/index.html'), 'utf8');
const head = html.slice(html.indexOf('<title>'), html.indexOf('</head>'))
  .replace(/<meta charset[^>]*>\s*/, '')
  .replace(/<meta name="viewport"[^>]*>\s*/, '')
  .replace('<link rel="stylesheet" href="style.css">', `<style>\n${css}\n</style>`);
const body = html.slice(html.indexOf('<main id="app">'), html.indexOf('<script type="module" src="app.js">'));
writeFileSync(out, `${head}\n${body}\n<script>globalThis.DC_PRACTICE_ONLY = true;</script>\n<script type="module">\n${js}\n</script>\n`);
console.log('wrote', out, Math.round((head.length + body.length + js.length) / 1024) + 'KB');
