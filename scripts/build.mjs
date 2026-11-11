import { cp, rm, writeFile } from 'node:fs/promises';

const source = new URL('../site/', import.meta.url);
const output = new URL('../dist/', import.meta.url);
await rm(output, { recursive: true, force: true });
await cp(source, output, { recursive: true });
await writeFile(new URL('.nojekyll', output), '');
console.log('Built static site in dist/');
