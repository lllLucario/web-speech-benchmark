import test from 'node:test';
import assert from 'node:assert/strict';
import { audioTrackCandidate, RecognitionRun } from '../site/recognition.js';

class FakeRecognition {
  start() { this.onstart(); }
  stop() { this.onend(); }
  abort() { this.onend(); }
}

function makeRun() {
  return new RecognitionRun(FakeRecognition, {
    language: 'en-AU', method: 'live', interim: true, errors: [], events: []
  }, () => {});
}

test('manual stop records only genuine browser timing events and supports another run', async () => {
  const capture = makeRun();
  await capture.start();
  assert.equal(capture.state, 'listening');
  capture.recognition.onspeechstart();
  capture.recognition.onresult({
    resultIndex: 0,
    results: [Object.assign([{ transcript: ' two coffees', confidence: 0.9 }], { isFinal: true })]
  });
  capture.requestStop();
  assert.equal(capture.state, 'finished');
  assert.equal(capture.run.termination, 'manual');
  assert.equal(capture.run.manualStop, true);
  assert.equal(capture.run.transcripts.final, ' two coffees');
  assert.ok(capture.run.latency.stopToEnd >= 0);
  assert.equal(capture.run.latency.speechToEnd, null);
  assert.equal(capture.recognition.onresult, null);

  const next = makeRun();
  await next.start();
  next.recognition.onend();
  assert.equal(next.run.termination, 'browser');
  assert.equal(next.run.latency.stopToEnd, null);
});

test('browser errors and their trailing end event are kept', async () => {
  const capture = makeRun();
  await capture.start();
  capture.recognition.onerror({ error: 'not-allowed', message: 'denied' });
  capture.recognition.onend();
  assert.equal(capture.run.errors[0].code, 'not-allowed');
  assert.deepEqual(capture.run.events.map(event => event.name), ['start()', 'onstart', 'onerror', 'onend']);
});

test('AudioTrack attempts require a supported desktop browser and Web Audio primitives', () => {
  const environment = {
    navigator: {
      userAgent: 'Mozilla/5.0 (Macintosh)',
      userAgentData: { brands: [{ brand: 'Google Chrome', version: '135' }], mobile: false },
      maxTouchPoints: 0
    },
    AudioContext: class { createMediaStreamDestination() {} },
    SpeechRecognition: FakeRecognition,
    MediaStreamTrack: class {}
  };
  assert.equal(audioTrackCandidate(environment), true);
  environment.navigator.userAgentData.mobile = true;
  assert.equal(audioTrackCandidate(environment), false);
  delete environment.navigator.userAgentData;
  assert.equal(audioTrackCandidate(environment), false);
});
