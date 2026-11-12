import test from 'node:test';
import assert from 'node:assert/strict';
import { RecordedSpeechRun } from '../site/recorded-speech.js';

test('Manual recording captures after a pause and transcribes two runs on the same page', async t => {
  let openTracks = 0;
  let recorder;
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { mediaDevices: {
      async getUserMedia() {
        assert.equal(openTracks, 0);
        openTracks++;
        return { getTracks: () => [{ stop() { openTracks--; } }] };
      }
    } }
  });
  t.after(() => {
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
    else delete globalThis.navigator;
    delete globalThis.MediaRecorder;
  });

  globalThis.MediaRecorder = class {
    state = 'inactive';
    mimeType = 'audio/mp4';
    constructor() { recorder = this; }
    start() {
      this.state = 'recording';
      queueMicrotask(() => this.onstart());
    }
    stop() {
      this.state = 'inactive';
      queueMicrotask(() => {
        this.ondataavailable({ data: new Blob([' second half']) });
        this.onstop();
      });
    }
  };

  let attempts = 0;
  for (let i = 0; i < 2; i++) {
    const run = { language: 'en-AU', events: [], errors: [] };
    let finish;
    const ended = new Promise(resolve => { finish = resolve; });
    const capture = new RecordedSpeechRun(run, () => {
      if (capture.state === 'finished') finish();
    }, async (blob, language, onProgress) => {
      assert.equal(openTracks, 0);
      assert.equal(blob.type, 'audio/mp4');
      assert.equal(await blob.text(), 'first half second half');
      assert.equal(language, 'en-AU');
      onProgress('transcribing');
      attempts++;
      return 'Complete order ' + attempts;
    });
    await capture.start();
    assert.equal(capture.state, 'listening');
    recorder.ondataavailable({ data: new Blob(['first half']) });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(capture.state, 'listening');
    assert.equal(openTracks, 1);
    assert.equal(attempts, i);
    capture.requestStop();
    await ended;
    assert.equal(run.transcripts.final, 'Complete order ' + (i + 1));
    assert.ok(run.latency.endToTranscript >= 0);
    assert.equal(run.termination, 'manual');
  }
});
