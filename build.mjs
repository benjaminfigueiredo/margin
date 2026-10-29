// Bundles the browser UI into public/. Run with: npm run build
import * as esbuild from 'esbuild';
import fs from 'node:fs';

fs.mkdirSync('public', { recursive: true });
await esbuild.build({
  entryPoints: ['web/src/main.js'],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  minify: true,
  sourcemap: false, // keeps the committed bundle small; debug with the sources in web/src
  outfile: 'public/app.js',
  logLevel: 'info',
});
fs.copyFileSync('web/index.html', 'public/index.html');
fs.copyFileSync('web/style.css', 'public/style.css');
fs.copyFileSync('node_modules/pdfjs-dist/build/pdf.worker.min.mjs', 'public/pdf.worker.min.mjs');
