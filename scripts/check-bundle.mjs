/**
 * Size budget for the JavaScript every route downloads before it can render.
 *
 * That is the entry script in dist/index.html plus the chunks Vite modulepreloads
 * next to it - the shell (router, layout, sidebar, concept index). It was 167 KB
 * gzip before the lessons were split out of it, and 119 KB before the search
 * index moved into the Search dialog's own chunk (104 KB after); this keeps a later
 * static import of lesson data, a chart library or an icon namespace from
 * quietly putting it back. Runs after `vite build`, as part of `npm run build`.
 *
 * Raise the budget deliberately, in the same commit as the code that needs it.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const BUDGET_KB = 110;
const DIST = 'dist';

const html = readFileSync(join(DIST, 'index.html'), 'utf8');
const scripts = [
  ...html.matchAll(/<script[^>]+src="\/([^"]+\.js)"/g),
  ...html.matchAll(/<link[^>]+rel="modulepreload"[^>]+href="\/([^"]+\.js)"/g),
].map((match) => match[1]);

if (!scripts.length) {
  console.error('check-bundle: no scripts found in dist/index.html - did vite build run?');
  process.exit(1);
}

const sizes = [...new Set(scripts)].map((file) => ({
  file,
  gzip: gzipSync(readFileSync(join(DIST, file))).length / 1024,
}));
const total = sizes.reduce((sum, entry) => sum + entry.gzip, 0);

if (total > BUDGET_KB) {
  console.error(`Initial JavaScript is ${total.toFixed(1)} KB gzip, over the ${BUDGET_KB} KB budget:`);
  for (const { file, gzip } of sizes.sort((a, b) => b.gzip - a.gzip)) console.error(`  ${gzip.toFixed(1).padStart(6)} KB  ${file}`);
  process.exit(1);
}

console.log(`Initial JavaScript ${total.toFixed(1)} KB gzip - within the ${BUDGET_KB} KB budget`);
