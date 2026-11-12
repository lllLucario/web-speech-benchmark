import {
  AutomaticSpeechRecognitionPipeline, env, WhisperFeatureExtractor, WhisperForConditionalGeneration, WhisperProcessor, WhisperTokenizer
} from './vendor/transformers.min.js';

env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = new URL('./models/', import.meta.url).href;
env.backends.onnx.wasm.wasmPaths = {
  mjs: new URL('./vendor/ort-wasm-simd-threaded.mjs', import.meta.url).href,
  wasm: new URL('./vendor/ort-wasm-simd-threaded.wasm', import.meta.url).href
};
env.backends.onnx.wasm.numThreads = 1;

let recognizer;

const modelId = 'onnx-community/whisper-tiny';

async function loadConfig(file) {
  const response = await fetch(new URL(modelId + '/' + file, env.localModelPath));
  if (!response.ok) throw new Error('Could not load speech model file ' + file + '.');
  return response.json();
}

function loadRecognizer() {
  recognizer ??= Promise.all([
    WhisperForConditionalGeneration.from_pretrained(modelId, { device: 'wasm', dtype: 'q8' }),
    loadConfig('tokenizer.json'),
    loadConfig('tokenizer_config.json'),
    loadConfig('preprocessor_config.json')
  ]).then(([model, tokenizerData, tokenizerConfig, featureConfig]) => {
    const tokenizer = new WhisperTokenizer(tokenizerData, tokenizerConfig);
    const featureExtractor = new WhisperFeatureExtractor(featureConfig);
    const processor = new WhisperProcessor({}, { tokenizer, feature_extractor: featureExtractor }, null);
    return new AutomaticSpeechRecognitionPipeline({ task: 'automatic-speech-recognition', model, tokenizer, processor });
  }).catch(error => {
    recognizer = undefined;
    throw error;
  });
  return recognizer;
}

self.onmessage = async ({ data: { id, samples, language } }) => {
  try {
    if (!recognizer) self.postMessage({ id, state: 'loading' });
    const transcribe = await loadRecognizer();
    self.postMessage({ id, state: 'transcribing' });
    const result = await transcribe(samples, {
      language: language.startsWith('zh') ? 'chinese' : 'english',
      task: 'transcribe', chunk_length_s: 25, stride_length_s: 4
    });
    self.postMessage({ id, text: result.text });
  } catch (error) {
    self.postMessage({ id, error: error.message ?? String(error) });
  }
};
