import { execFile } from 'node:child_process';
import { cp, mkdir, rename, rm, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const model = 'onnx-community/whisper-tiny';
const revision = 'ff4177021cc41f7db950912b73ea4fdf7d01d8e7';
const cache = new URL('../node_modules/.cache/order-signal-models/' + revision + '/', import.meta.url);
const library = new URL('../node_modules/@huggingface/transformers/', import.meta.url);
const modelFiles = [
  'config.json', 'generation_config.json', 'preprocessor_config.json', 'tokenizer.json',
  'tokenizer_config.json', 'README.md', 'onnx/encoder_model_quantized.onnx',
  'onnx/decoder_model_merged_quantized.onnx'
];

export async function copyTranscriptionAssets(output) {
  const vendor = new URL('vendor/', output);
  await mkdir(vendor, { recursive: true });
  const runtime = new URL('../node_modules/onnxruntime-web/dist/', import.meta.url);
  const wasmFiles = ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm'];
  await Promise.all([
    cp(new URL('dist/transformers.min.js', library), new URL('transformers.min.js', vendor)),
    cp(new URL('LICENSE', library), new URL('LICENSE', vendor)),
    cp(new URL('./licenses/onnxruntime.txt', import.meta.url), new URL('ONNX-Runtime-LICENSE.txt', vendor)),
    cp(new URL('./licenses/whisper.txt', import.meta.url), new URL('Whisper-LICENSE.txt', vendor)),
    ...wasmFiles.map(file => cp(new URL(file, runtime), new URL(file, vendor))),
    ...modelFiles.map(async file => {
      const cachedFile = new URL(file, cache);
      const destination = new URL('models/' + model + '/' + file, output);
      await mkdir(new URL('.', destination), { recursive: true });
      if (!(await stat(cachedFile).catch(error => {
        if (error.code !== 'ENOENT') throw error;
        return null;
      }))?.size) {
        await mkdir(new URL('.', cachedFile), { recursive: true });
        const temp = new URL(file + '.' + process.pid + '.tmp', cache);
        try {
          await run('curl', ['--fail', '--location', '--silent', '--show-error', '--retry', '2',
            '--max-time', '150', '--output', fileURLToPath(temp),
            'https://huggingface.co/' + model + '/resolve/' + revision + '/' + file]);
          await rename(temp, cachedFile);
        } finally {
          await rm(temp, { force: true });
        }
      }
      await cp(cachedFile, destination);
    })
  ]);
}
