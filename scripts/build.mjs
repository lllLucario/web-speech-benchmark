import { createHash } from 'node:crypto';
import { cp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { copyTranscriptionAssets } from './transcription-assets.mjs';

const source = new URL('../site/', import.meta.url);
const output = new URL('../dist/', import.meta.url);
const files = (await readdir(source)).sort();
const assets = await Promise.all(files.map(async file => [file, await readFile(new URL(file, source))]));
const hash = createHash('sha256');
for (const [file, content] of assets) hash.update(file).update(content);
const version = hash.digest('hex').slice(0, 12);

await rm(output, { recursive: true, force: true });
await cp(source, output, { recursive: true });
for (const [file, content] of assets) {
  if (!/\.(?:html|js)$/u.test(file)) continue;
  // Keep all entry and module requests on the same release despite cached Pages assets.
  const versioned = content.toString('utf8').replace(/(["'])(\.\/[\w-]+\.(?:js|css))\1/gu,
    (_, quote, path) => quote + path + '?v=' + version + quote);
  await writeFile(new URL(file, output), versioned);
}
await copyTranscriptionAssets(output);
await writeFile(new URL('.nojekyll', output), '');
console.log('Built static site in dist/ (' + version + ')');
