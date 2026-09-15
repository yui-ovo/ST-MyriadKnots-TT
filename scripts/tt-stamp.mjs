import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const root = new URL('../', import.meta.url);
const manifestUrl = new URL('manifest.json', root);
const manifest = JSON.parse(await readFile(manifestUrl, 'utf8'));
const bundle = await readFile(new URL('dist/qqj-app.js', root));
const digest = createHash('sha256').update(bundle).digest('hex').slice(0, 16);
const previous = /\?v=(\d{8})\.(\d+)-/.exec(manifest.js);
const day = new Date().toISOString().slice(0, 10).replaceAll('-', '');
const sequence = previous?.[1] === day ? Number(previous[2]) + 1 : 1;
manifest.js = `dist/qqj-app.js?v=${day}.${sequence}-${digest}`;
await writeFile(manifestUrl, `${JSON.stringify(manifest)}\n`);
console.log(manifest.js);
