export function supportsRecordedSpeech(environment = window) {
  return Boolean(environment.isSecureContext && environment.navigator.mediaDevices?.getUserMedia &&
    environment.MediaRecorder && environment.OfflineAudioContext && environment.Worker && environment.WebAssembly);
}

let worker;
let requestId = 0;
const sampleRate = 16000;

async function transcribeRecording(blob, language, onProgress, signal) {
  const decoder = new OfflineAudioContext(1, 1, sampleRate);
  const decoded = await decoder.decodeAudioData(await blob.arrayBuffer());
  signal.throwIfAborted();
  const samples = new Float32Array(decoded.length);
  for (let channel = 0; channel < decoded.numberOfChannels; channel++) {
    const input = decoded.getChannelData(channel);
    for (let i = 0; i < input.length; i++) samples[i] += input[i] / decoded.numberOfChannels;
  }

  const id = ++requestId;
  const engine = worker ??= new Worker(new URL('./transcription-worker.js', import.meta.url), { type: 'module' });
  return new Promise((resolve, reject) => {
    const clean = () => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', cancel);
      engine.removeEventListener('message', receive);
      engine.removeEventListener('error', failed);
      engine.removeEventListener('messageerror', failed);
    };
    const reset = error => {
      clean();
      engine.terminate();
      if (worker === engine) worker = undefined;
      reject(error);
    };
    const cancel = () => reset(signal.reason);
    const failed = () => reset(new Error('The browser could not run the speech model.'));
    const receive = ({ data }) => {
      if (data.id !== id) return;
      if (data.state) {
        onProgress(data.state);
        return;
      }
      clean();
      if (data.error) reject(new Error(data.error));
      else resolve(data.text);
    };
    const timeout = setTimeout(() => reset(new Error('Transcription took too long. Try again.')),
      Math.max(180000, decoded.duration * 10000));
    signal.addEventListener('abort', cancel, { once: true });
    engine.addEventListener('message', receive);
    engine.addEventListener('error', failed);
    engine.addEventListener('messageerror', failed);
    try {
      engine.postMessage({ id, samples, language }, [samples.buffer]);
    } catch (error) {
      reset(error);
    }
  });
}

export class RecordedSpeechRun {
  state = 'preparing';
  origin = performance.now();
  controller = new AbortController();
  chunks = [];

  constructor(run, onChange, transcribe = transcribeRecording) {
    this.run = run;
    this.onChange = onChange;
    this.transcribe = transcribe;
    this.run.transcripts = { final: '', interim: '', full: '' };
    this.run.segments = [];
    this.run.latency = { recordingStartup: null, endToTranscript: null };
  }

  log(name, details = {}) {
    const ms = performance.now() - this.origin;
    this.run.events.push({ name, ms, ...details });
    return ms;
  }

  async start() {
    const requested = this.log('recordingStartRequested');
    this.onChange();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (this.state === 'finished') {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      this.stream = stream;
      const recorder = this.recorder = new MediaRecorder(stream);
      recorder.onstart = () => {
        if (this.state !== 'preparing') return;
        this.run.latency.recordingStartup = this.log('recordingStarted') - requested;
        this.state = 'listening';
        this.onChange();
      };
      recorder.ondataavailable = ({ data }) => {
        if (data.size) this.chunks.push(data);
      };
      recorder.onerror = ({ error }) => {
        this.fail('recording-error', 'The browser could not finish recording.', error?.message);
      };
      recorder.onstop = () => this.finishRecording(recorder.mimeType);
      recorder.start();
    } catch (error) {
      this.fail(error.name, 'Could not start recording. Check microphone access and try again.', error.message);
    }
  }

  requestStop() {
    if (this.state !== 'listening') return;
    this.stopRequestedAt = this.log('recordingStopRequested');
    this.run.manualStop = true;
    this.state = 'stopping';
    this.onChange();
    try {
      this.stopDeadline = setTimeout(() => {
        this.fail('recording-timeout', 'The browser did not finish the recording.');
      }, 10000);
      this.recorder.stop();
    } catch (error) {
      this.fail('recording-stop-error', 'Could not end the recording.', error.message);
    }
  }

  async finishRecording(mimeType) {
    if (this.state === 'finished') return;
    clearTimeout(this.stopDeadline);
    this.releaseMicrophone();
    this.log('recordingEnded');
    if (!this.run.manualStop) {
      this.fail('recording-interrupted', 'Recording was interrupted. Tap Start to try again.');
      return;
    }
    const blob = new Blob(this.chunks, { type: mimeType || this.chunks[0]?.type });
    this.chunks = [];
    if (!blob.size) {
      this.fail('empty-recording', 'The browser returned an empty recording.');
      return;
    }
    this.state = 'transcribing';
    this.log('transcriptionRequested', { audioBytes: blob.size, mimeType: blob.type });
    this.onChange();
    try {
      const text = await this.transcribe(blob, this.run.language, state => {
        this.state = state;
        this.log(state === 'loading' ? 'modelLoading' : 'transcriptionStarted');
        this.onChange();
      }, this.controller.signal);
      if (this.state === 'finished') return;
      if (!text?.trim()) {
        this.fail('empty-transcript', 'No speech was recognized. Tap Start to try again.');
        return;
      }
      this.run.transcripts = { final: text, interim: '', full: text };
      this.run.segments = [{ text, isFinal: true }];
      this.run.latency.endToTranscript = this.log('transcriptionFinished') - this.stopRequestedAt;
      this.finish('manual');
    } catch (error) {
      this.fail('transcription-error', 'Could not transcribe this recording. Tap Start to try again.', error.message);
    }
  }

  releaseMicrophone() {
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
  }

  fail(code, message, browserMessage = '') {
    if (this.state === 'finished') return;
    this.log('recordedSpeechError', { code, message, browserMessage });
    this.run.errors.push({ code, message, browserMessage });
    this.finish('error');
  }

  abort(reason) {
    // Once End is tapped, let the recorder finalize its last audio chunk.
    if (this.state === 'preparing' || this.state === 'listening') this.finish(reason);
  }

  finish(reason) {
    clearTimeout(this.stopDeadline);
    this.state = 'finished';
    this.controller.abort();
    if (this.recorder) {
      this.recorder.onstart = null;
      this.recorder.ondataavailable = null;
      this.recorder.onstop = null;
      this.recorder.onerror = null;
      if (this.recorder.state !== 'inactive') {
        try { this.recorder.stop(); } catch { /* Releasing tracks also ends capture. */ }
      }
      this.recorder = null;
    }
    this.releaseMicrophone();
    this.chunks = [];
    this.run.termination = reason;
    this.run.finishedAt = new Date().toISOString();
    this.onChange();
  }
}
