// Bundles the browser UI into public/. Run with: npm run build
import * as esbuild from 'esbuild';
import fs from 'node:fs';

fs.mkdirSync('public', { recursive: true });
// sourcemap off: keeps the committed bundles small; debug with the sources in web/src
const common = { bundle: true, format: 'esm', target: 'es2022', minify: true, sourcemap: false, logLevel: 'info' };
await esbuild.build({ ...common, entryPoints: ['web/src/main.js'], outfile: 'public/app.js' });
await esbuild.build({ ...common, entryPoints: ['web/src/hub.js'], outfile: 'public/hub.js' }); // the hub page (server/hub.js)
fs.copyFileSync('web/index.html', 'public/index.html');
fs.copyFileSync('web/style.css', 'public/style.css');
fs.copyFileSync('web/hub.html', 'public/hub.html');
fs.copyFileSync('web/hub.css', 'public/hub.css');
fs.copyFileSync('node_modules/pdfjs-dist/build/pdf.worker.min.mjs', 'public/pdf.worker.min.mjs');
