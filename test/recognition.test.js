import test from 'node:test';
import assert from 'node:assert/strict';
import { audioTrackCandidate, RecognitionRun } from '../site/recognition.js';

class FakeRecognition {
  start() { this.onstart(); }
  stop() { this.onend(); }
  abort() { this.onend(); }
}

function makeRun(Recognition = FakeRecognition) {
  return new RecognitionRun(Recognition, {
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
  const recognition = capture.recognition;
  capture.requestStop();
  assert.equal(capture.state, 'finished');
  assert.equal(capture.run.termination, 'manual');
  assert.equal(capture.run.manualStop, true);
  assert.equal(capture.run.transcripts.final, ' two coffees');
  assert.ok(capture.run.latency.stopToEnd >= 0);
  assert.equal(capture.run.latency.speechToEnd, null);
  assert.equal(recognition.onresult, null);
  assert.equal(capture.recognition, null);

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

test('A delayed stop releases capture before the next run', async () => {
  let owner = null;
  class ExclusiveRecognition {
    start() {
      assert.equal(owner, null);
      owner = this;
      this.onstart();
    }
    stop() {}
    abort() { assert.fail('The pending stop was interrupted'); }
    end() {
      owner = null;
      this.onend();
    }
  }

  const first = makeRun(ExclusiveRecognition);
  await first.start();
  const recognizer = first.recognition;
  first.requestStop();
  assert.equal(first.state, 'stopping');
  assert.equal(owner, recognizer);
  recognizer.onresult({
    resultIndex: 0,
    results: [Object.assign([{ transcript: ' first order' }], { isFinal: true })]
  });
  recognizer.end();
  assert.equal(first.state, 'finished');
  assert.equal(first.recognition, null);
  assert.equal(first.run.transcripts.final, ' first order');
  assert.deepEqual(first.run.events.map(event => event.name), ['start()', 'onstart', 'stop()', 'onresult', 'onend']);

  const second = makeRun(ExclusiveRecognition);
  await second.start();
  second.recognition.onresult({
    resultIndex: 0,
    results: [Object.assign([{ transcript: ' second order' }], { isFinal: true })]
  });
  second.requestStop();
  second.recognition.end();
  assert.equal(second.run.transcripts.final, ' second order');
  assert.equal(owner, null);
});

test('Cancelling audio preparation cannot start a recognizer later', async () => {
  class NeverStarts {
    start() { assert.fail('Cancelled recognition started'); }
    abort() { assert.fail('Recognition was not started'); }
  }
  const capture = makeRun(NeverStarts);
  capture.run.method = 'track';
  let resolveTrack;
  capture.prepareTrack = () => new Promise(resolve => { resolveTrack = resolve; });
  const start = capture.start();
  capture.abort('cancelled');
  assert.equal(capture.state, 'finished');
  resolveTrack({ readyState: 'live', kind: 'audio' });
  await start;
  assert.equal(capture.recognition, null);
  assert.deepEqual(capture.run.events, []);
});

test('A silent session shows a hint and can still receive speech without restarting', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const capture = makeRun();
  await capture.start();
  t.mock.timers.tick(8000);
  assert.equal(capture.state, 'listening');
  assert.equal(capture.waitingForResult, true);
  capture.recognition.onresult({
    resultIndex: 0,
    results: [Object.assign([{ transcript: ' one coffee' }], { isFinal: true })]
  });
  assert.equal(capture.waitingForResult, false);
  capture.requestStop();
  assert.equal(capture.run.transcripts.final, ' one coffee');
});

test('A delayed end event triggers abort and still records the real end', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  class StuckRecognition extends FakeRecognition {
    stop() {}
    abort() {}
  }
  const capture = makeRun(StuckRecognition);
  await capture.start();
  capture.requestStop();
  t.mock.timers.tick(5000);
  assert.equal(capture.state, 'stopping');
  assert.equal(capture.run.errors[0].code, 'missing-end');
  assert.equal(capture.run.latency.stopToEnd, null);
  assert.equal(capture.run.events.at(-1).name, 'abort()');
  capture.recognition.onend();
  assert.equal(capture.state, 'finished');
  assert.equal(capture.recognition, null);
  assert.ok(capture.run.latency.stopToEnd >= 0);
});
