import { collectResults, timings, transcripts } from './benchmark.js';

export const inputLabels = {
  live: 'Live speech',
  external: 'External audio playback',
  track: 'AudioTrack'
};

export function audioTrackCandidate(environment = window) {
  const { navigator, AudioContext, MediaStreamTrack, SpeechRecognition, webkitSpeechRecognition } = environment;
  // A browser that lacks the overload may silently ignore its argument and open the microphone.
  // Limit attempts to desktop Chrome versions with a documented implementation.
  const ua = navigator.userAgent;
  const version = Number(navigator.userAgentData?.brands.find(brand => brand.brand === 'Google Chrome')?.version);
  return Boolean(version >= 135 && !navigator.userAgentData.mobile &&
    /\b(?:Macintosh|Windows NT|X11|CrOS)\b/u.test(ua) &&
    navigator.maxTouchPoints < 2 && !/Android|iPhone|iPad|Mobile/u.test(ua) &&
    (SpeechRecognition || webkitSpeechRecognition) &&
    AudioContext?.prototype.createMediaStreamDestination && MediaStreamTrack);
}

const browserErrors = {
  'not-allowed': 'Recognition permission was denied. Check microphone or speech permissions in the browser and device settings.',
  'service-not-allowed': 'The browser or device blocked the speech recognition service.',
  'no-speech': 'The browser detected no speech.',
  'audio-capture': 'The browser could not capture audio.',
  network: 'The browser reported a recognition network error.',
  aborted: 'Recognition was aborted.',
  'language-not-supported': 'The recognition service rejected the selected language.'
};

export class RecognitionRun {
  constructor(Recognition, run, onChange) {
    this.Recognition = Recognition;
    this.run = run;
    this.onChange = onChange;
    this.state = 'preparing';
    this.origin = performance.now();
    this.slots = [];
    this.closing = false;
  }

  log(name, details = {}) {
    this.run.events.push({ name, ms: performance.now() - this.origin, ...details });
  }

  notify() {
    this.run.transcripts = transcripts(this.slots);
    this.run.segments = this.slots;
    this.run.latency = timings(this.run.events);
    this.onChange();
  }

  async start(file) {
    this.notify();
    try {
      const recognition = this.recognition = new this.Recognition();
      recognition.lang = this.run.language;
      recognition.interimResults = this.run.interim;
      recognition.continuous = true;

      for (const name of ['audiostart', 'soundstart', 'speechstart', 'speechend', 'soundend', 'audioend']) {
        recognition['on' + name] = () => {
          if (this.state === 'finished') return;
          this.log('on' + name);
          this.notify();
        };
      }
      recognition.onstart = () => {
        if (this.state === 'finished') return;
        this.log('onstart');
        if (this.state === 'starting') {
          clearTimeout(this.deadline);
          this.state = 'listening';
          try {
            if (this.source) {
              this.source.start();
              this.log('audioPlaybackStart');
            }
          } catch (error) {
            this.fail('audio-playback', error.message);
            this.abort('audio-playback');
            return;
          }
        }
        this.notify();
      };
      recognition.onresult = event => {
        if (this.state === 'finished') return;
        const { slots, newFinal } = collectResults(this.slots, event);
        const results = Array.from(event.results).slice(event.resultIndex).map(result => ({
          text: result[0].transcript, isFinal: result.isFinal, confidence: result[0].confidence
        }));
        this.slots = slots;
        this.log('onresult', { resultIndex: event.resultIndex, results, hasResult: slots.some(slot => slot.text.length > 0), newFinal });
        this.notify();
      };
      recognition.onerror = event => {
        if (this.state === 'finished') return;
        this.log('onerror', { code: event.error, message: event.message });
        this.fail(event.error, browserErrors[event.error] || event.message || 'The recognition service reported an error.', event.message);
        this.stopAudio();
        this.state = 'stopping';
        this.armEndTimeout();
        this.notify();
      };
      recognition.onend = () => {
        if (this.state === 'finished') return;
        this.log('onend');
        this.finish(this.run.termination ?? 'browser');
      };

      let track;
      if (this.run.method === 'track') {
        this.deadline = setTimeout(() => this.timeout('Audio preparation timed out.'), 20000);
        track = await this.prepareTrack(file);
        clearTimeout(this.deadline);
        if (this.state === 'finished') return;
        if (track.readyState !== 'live' || track.kind !== 'audio') throw new Error('An active audio track is required.');
      }
      this.state = 'starting';
      this.deadline = setTimeout(() => this.timeout('The browser did not confirm recognition start.'), 30000);
      this.log('start()');
      this.invoked = true;
      if (track) recognition.start(track);
      else recognition.start();
      this.notify();
    } catch (error) {
      if (this.state === 'finished') return;
      const code = error.name || 'start-error';
      this.log('startException', { code, message: error.message });
      this.fail(code, this.run.method === 'track' ? 'AudioTrack could not start. ' + error.message : error.message);
      this.finish('start-error');
    }
  }

  async prepareTrack(file) {
    if (!file || !audioTrackCandidate()) throw new Error('AudioTrack is unavailable in this browser.');
    const context = this.context = new AudioContext();
    const [, buffer] = await Promise.all([
      context.resume(),
      file.arrayBuffer().then(bytes => context.decodeAudioData(bytes))
    ]);
    if (this.state === 'finished') return null;
    if (context.state !== 'running') throw new Error('The browser suspended the audio context.');
    const destination = context.createMediaStreamDestination();
    destination.channelCount = 1;
    this.track = destination.stream.getAudioTracks()[0];
    const source = this.source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(destination);
    source.onended = () => {
      if (this.state !== 'listening') return;
      this.log('audioPlaybackEnd');
      this.requestStop('audio-ended');
    };
    return this.track;
  }

  fail(code, message, browserMessage = '') {
    this.run.errors.push({ code, message, browserMessage });
  }

  timeout(message) {
    this.log('appTimeout', { message });
    this.fail('timeout', message);
    this.abort('timeout');
  }

  armEndTimeout() {
    clearTimeout(this.deadline);
    if (this.closing) return;
    this.deadline = setTimeout(() => {
      this.log('appTimeout', { message: 'No recognition end event arrived.' });
      this.fail('missing-end', 'The browser did not send a recognition end event.');
      this.abort(this.run.termination ?? 'timeout');
    }, 5000);
  }

  requestStop(reason = 'manual') {
    if (!['starting', 'listening'].includes(this.state)) return;
    this.run.termination = reason;
    this.run.manualStop = reason === 'manual';
    this.state = 'stopping';
    this.log(reason === 'manual' ? 'stop()' : 'stop() [audio ended]');
    this.armEndTimeout();
    try {
      this.recognition.stop();
    } catch (error) {
      this.fail('stop-error', error.message);
      this.abort(reason);
      return;
    }
    this.stopAudio();
    this.notify();
  }

  abort(reason) {
    if (this.state === 'finished' || this.closing) return;
    this.closing = true;
    this.run.termination = reason;
    if (this.invoked) {
      this.log('abort()', { reason });
      try { this.recognition.abort(); } catch (error) { this.fail('abort-error', error.message); }
    }
    this.stopAudio();
    if (this.state !== 'finished') {
      this.state = 'stopping';
      clearTimeout(this.deadline);
      // Keep handlers briefly so genuine trailing onerror/onend events can be recorded.
      this.deadline = setTimeout(() => this.finish(reason), 1200);
      this.notify();
    }
  }

  stopAudio() {
    if (this.source) {
      this.source.onended = null;
      try { this.source.stop(); } catch { /* Source may not have started. */ }
      this.source.disconnect();
      this.source = null;
    }
    this.track?.stop();
    this.track = null;
    if (this.context && this.context.state !== 'closed') this.context.close().catch(() => {});
    this.context = null;
  }

  finish(reason) {
    clearTimeout(this.deadline);
    this.state = 'finished';
    this.run.termination = reason;
    this.run.finishedAt = new Date().toISOString();
    this.stopAudio();
    if (this.recognition) {
      for (const event of ['start', 'audiostart', 'soundstart', 'speechstart', 'result', 'speechend', 'soundend', 'audioend', 'error', 'end']) {
        this.recognition['on' + event] = null;
      }
    }
    this.notify();
  }
}
