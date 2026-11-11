import { builtInCases } from './dataset.js';
import { csv, json, latencyLabels, score } from './benchmark.js';
import { audioTrackCandidate, inputLabels, RecognitionRun } from './recognition.js';

const $ = id => document.getElementById(id);
const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const trackAvailable = audioTrackCandidate();
const browser = {
  name: navigator.userAgent.match(/Edg(?:A|iOS)?\//u) ? 'Edge' :
    /(?:Chrome|CriOS)\//u.test(navigator.userAgent) ? 'Chrome' :
    /(?:Firefox|FxiOS)\//u.test(navigator.userAgent) ? 'Firefox' :
    /Safari\//u.test(navigator.userAgent) ? 'Safari' : 'Other',
  userAgent: navigator.userAgent,
  brands: navigator.userAgentData?.brands ?? null
};
const device = {
  platform: navigator.userAgentData?.platform || navigator.platform || null,
  mobile: navigator.userAgentData?.mobile ?? (/Android|iPhone|iPad|Mobile/u.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)),
  touchPoints: navigator.maxTouchPoints,
  screen: { width: screen.width, height: screen.height, pixelRatio: devicePixelRatio }
};

const STORAGE = 'order-signal-v1';
let storageError = false;
function readStorage() {
  try { return JSON.parse(localStorage.getItem(STORAGE)) ?? {}; }
  catch { storageError = true; return {}; }
}
const stored = readStorage();
const cases = stored.cases ?? builtInCases;
const sessions = stored.sessions ?? [];
let session = sessions.at(-1) ?? null;
let caseId = cases[0].id;
let current = null;
let file = null;
let previewUrl = '';
let noticeTimer;

function persist() {
  try {
    localStorage.setItem(STORAGE, json({ cases, sessions }));
    return true;
  } catch {
    notice('Browser storage is unavailable or full. Export your results before closing.');
    return false;
  }
}

function el(tag, text = '', className = '') {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  return node;
}

function notice(text) {
  $('notice').textContent = text;
  $('notice').hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { $('notice').hidden = true; }, 4500);
}

function bind(id, listener, event = 'click') {
  $(id).addEventListener(event, listener);
}

const uuid = () => crypto.randomUUID?.() ?? [...crypto.getRandomValues(new Uint8Array(16))]
  .map(byte => byte.toString(16).padStart(2, '0')).join('');
const active = () => Boolean(current && current.state !== 'finished');
const selectedCase = () => cases.find(item => item.id === caseId);
const ms = value => Number.isFinite(value) ? value.toFixed(1) + ' ms' : 'N/A';
const pct = value => Number.isFinite(value) ? (100 * value).toFixed(1) + '%' : 'N/A';

function download(name, data, type = 'json') {
  const content = type === 'json' ? json(data) : csv(data);
  const url = URL.createObjectURL(new Blob([content], {
    type: type === 'json' ? 'application/json;charset=utf-8' : 'text/csv;charset=utf-8'
  }));
  const link = el('a');
  link.href = url;
  link.download = name + '.' + type;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function metric(label, value) {
  const node = el('div', '', 'metric');
  node.append(el('span', label), el('strong', value));
  return node;
}

function detailsList(entries) {
  const list = el('dl');
  for (const [label, value] of entries) list.append(el('dt', label), el('dd', String(value)));
  return list;
}

function accuracyView(run) {
  if (!run) return el('p', 'Finish a recognition attempt to compare it with the reference.', 'muted');
  const root = el('div');
  const evaluation = run.evaluation ?? score(run.reference, run.transcripts.final, run.criticalTerms, run.scoring);
  const summary = el('div', '', 'metrics');
  const matched = evaluation.critical.filter(item => item.matched).length;
  summary.append(metric('WER', pct(evaluation.wer)), metric('Word accuracy', pct(evaluation.accuracy)),
    metric('Substitutions / Deletions / Insertions', [evaluation.substitution, evaluation.deletion, evaluation.insertion].join(' / ')),
    metric('Critical terms', evaluation.critical.length ? matched + ' / ' + evaluation.critical.length : 'N/A'));
  const comparison = el('div', '', 'comparison');
  for (const [title, value] of [['Reference', run.reference], ['Recognized · final', run.transcripts.final || '—']]) {
    const column = el('div');
    column.append(el('h3', title), el('p', value, 'raw'));
    comparison.append(column);
  }
  const diff = el('div', '', 'diff');
  for (const { kind, ref, hyp } of evaluation.edits) {
    const token = el('span', kind === 'substitution' ? ref + ' → ' + hyp :
      kind === 'deletion' ? '−' + ref : kind === 'insertion' ? '+' + hyp : hyp, kind);
    token.title = kind;
    diff.append(token);
  }
  root.append(summary, comparison, el('h3', 'Word alignment · ' + run.scoring.mode), diff);
  if (evaluation.critical.length) {
    root.append(el('h3', 'Critical phrase matches'),
      el('p', evaluation.critical.map(item => (item.matched ? '✓ ' : '✗ ') + item.term).join(' · ')));
  }
  return root;
}

function runRecord(run) {
  const { events, evaluation, ...rest } = run;
  return {
    ...rest, browser: browserText(run.browser), userAgent: run.browser.userAgent,
    rawTranscript: run.transcripts.final, interimTranscript: run.transcripts.interim,
    fullTranscript: run.transcripts.full, wer: evaluation.wer, wordAccuracy: evaluation.accuracy,
    substitutions: evaluation.substitution, deletions: evaluation.deletion, insertions: evaluation.insertion,
    critical: evaluation.critical, eventCount: events.length,
    ...Object.fromEntries(Object.entries(run.latency).map(([key, value]) => [key + 'Ms', value]))
  };
}

function eventRecords(run) {
  const metadata = runRecord(run);
  return run.events.map((event, index) => ({ ...metadata, eventIndex: index, ...event }));
}
const browserText = info => info.name + (info.brands?.find(brand => brand.brand === 'Google Chrome')?.version && info.name === 'Chrome'
  ? ' ' + info.brands.find(brand => brand.brand === 'Google Chrome').version : '');

function renderCase() {
  const item = selectedCase();
  $('case-select').value = caseId;
  $('reference').textContent = item.reference;
  $('case-progress').textContent = item.id + (item.completed ? ' ✓' : '');
  $('case-notes').textContent = item.notes;
  $('case-notes').hidden = !item.notes;
  const link = $('case-audio');
  link.hidden = true;
  try {
    const url = new URL(item.audio);
    if (['https:', 'http:'].includes(url.protocol)) {
      link.href = url.href;
      link.hidden = false;
    }
  } catch { /* Local filenames are dataset metadata. */ }
}

function renderMethod() {
  const method = $('method').value;
  $('audio-area').hidden = method === 'live';
  $('file-label').hidden = method !== 'track';
  $('preview').hidden = method !== 'track' || !file;
  $('method-help').textContent = method === 'external'
    ? 'Start recognition on this device, then play the case recording from a separate device. Stop and save the result.'
    : trackAvailable ? 'Choose and preview a file. Recognition routes it through an audio track. This path requires a successful file test.'
      : 'AudioTrack is unavailable here. Choose External audio playback to test a recording from a separate device.';
  $('start-label').textContent = method === 'track' ? 'Test audio file' : 'Start recognition';
}

function renderRun() {
  const run = current?.run;
  const busy = active();
  const ready = current?.state === 'finished';
  const method = $('method').value;
  const canStart = Recognition && window.isSecureContext && (method !== 'track' || (trackAvailable && file));
  const state = current?.state ?? 'idle';
  const statuses = { idle: Recognition ? 'Idle' : 'API unavailable', preparing: 'Preparing', starting: 'Starting', listening: 'Listening', stopping: 'Finishing', finished: run?.success ? 'Complete' : 'Unsuccessful' };
  const status = $('status');
  if (status.textContent !== statuses[state]) status.textContent = statuses[state];
  status.dataset.state = state;
  const error = run?.errors.at(-1)?.message || (ready && !run.transcripts.final.trim() ? 'No final transcript was returned.' :
    !window.isSecureContext ? 'Recognition requires HTTPS or localhost.' :
    !Recognition ? 'This browser does not expose the speech recognition API.' : '');
  if ($('error').textContent !== error) $('error').textContent = error;
  $('error').hidden = !error;
  $('start').disabled = busy || !canStart;
  $('stop').disabled = !['starting', 'listening'].includes(state);
  $('reset').disabled = !current;
  for (const id of ['language', 'method', 'interim-enabled', 'case-select', 'mode', 'fillers', 'audio-file', 'next', 'repeat', 'new-session', 'queue', 'network', 'environment']) $(id).disabled = busy;
  $('save').disabled = !ready || Boolean(run?.saved);
  $('save').textContent = run?.saved ? 'Run saved' : 'Save run';
  for (const id of ['run-json', 'run-csv', 'event-json', 'event-csv']) $(id).disabled = !ready;
  for (const [key, name] of [['interim', 'interim-text'], ['final', 'final-text'], ['full', 'full-text']]) {
    $(name).textContent = run?.transcripts[key] ?? '';
  }
  $('latencies').replaceChildren(...Object.entries(latencyLabels).map(([key, label]) => metric(label, ms(run?.latency[key]))));
  const events = run?.events ?? [];
  $('event-count').textContent = '(' + events.length + ')';
  $('events').replaceChildren(...events.map(event => el('li', ms(event.ms) + ' · ' + event.name +
    (event.code ? ' · ' + event.code : '') + (event.newFinal ? ' · new final' : ''))));
  if (ready || state === 'idle' || state === 'preparing') $('accuracy').replaceChildren(accuracyView(ready ? run : null));
  $('session-label').textContent = session ? 'Current session · ' + session.runs.length + ' saved' : 'Save a run to start a session.';
}

function fillCaseOptions(queue = []) {
  const label = item => item.id + ' · ' + item.category + (item.completed ? ' ✓' : '');
  $('case-select').replaceChildren(...cases.map(item => new Option(label(item), item.id)));
  $('queue').replaceChildren(...cases.map(item => new Option(label(item), item.id, false, queue.includes(item.id))));
  renderCase();
}

function clearRun() {
  if (active()) return;
  current = null;
  renderRun();
}

function selectCase(id) {
  if (active() || !cases.some(item => item.id === id)) return;
  caseId = id;
  renderCase();
  clearRun();
}

const batchSelection = () => Array.from($('queue').selectedOptions, option => option.value);
const configuration = () => ({
  language: $('language').value, method: $('method').value,
  network: $('network').value.trim(), environment: $('environment').value
});

function makeSession() {
  session = {
    id: uuid(), createdAt: new Date().toISOString(), browser, device, ...configuration(),
    queue: batchSelection(), runs: []
  };
  return session;
}

function sessionForRun() {
  const settings = configuration();
  if (!session || Object.entries(settings).some(([key, value]) => session[key] !== value)) return makeSession();
  return session;
}

function startRun() {
  if (active() || $('start').disabled) return;
  $('preview').pause();
  const item = selectedCase();
  const parent = sessionForRun();
  const run = {
    id: uuid(), sessionId: parent.id, startedAt: new Date().toISOString(),
    caseId, category: item.category, reference: item.reference, criticalTerms: [...item.criticalTerms],
    notes: item.notes, audioReference: item.audio, fileName: parent.method === 'track' ? file.name : null,
    browser, device, ...configuration(), interim: $('interim-enabled').checked,
    scoring: { mode: $('mode').value, fillers: $('fillers').value.split(',').map(value => value.trim()).filter(Boolean) },
    events: [], errors: [], manualStop: false, termination: null
  };
  current = new RecognitionRun(Recognition, run, () => {
    if (current?.run !== run) return;
    if (current.state === 'finished') {
      run.success = Boolean(run.transcripts.final.trim()) && !run.errors.length;
      run.evaluation = score(run.reference, run.transcripts.final, run.criticalTerms, run.scoring);
    }
    renderRun();
  });
  current.start(file);
}

function saveRun() {
  const run = current?.run;
  if ($('save').disabled || !run || run.saved) return;
  run.saved = true;
  session.runs.push(run);
  if (!sessions.includes(session)) sessions.push(session);
  const item = cases.find(candidate => candidate.id === run.caseId);
  if (run.success && item) item.completed = true;
  if (persist()) notice('Run saved on this device.');
  fillCaseOptions(batchSelection());
  renderRun();
}

bind('start', startRun);
bind('stop', () => current?.requestStop());
bind('reset', () => {
  if (active()) {
    const discarded = current;
    // Wait for the old browser session to release its recognition service.
    discarded.onChange = () => { if (discarded.state === 'finished') clearRun(); else renderRun(); };
    discarded.abort('reset');
  } else clearRun();
});
bind('save', saveRun);
bind('case-select', () => selectCase($('case-select').value), 'change');
bind('next', () => {
  const chosen = session?.queue?.filter(id => cases.some(item => item.id === id)) ?? [];
  const ids = chosen.length ? chosen : cases.map(item => item.id);
  const next = ids.indexOf(caseId) + 1;
  if (next < ids.length) selectCase(ids[next]);
  else notice('You’ve reached the end of the selected cases.');
});
bind('repeat', clearRun);
bind('new-session', () => {
  const nextSession = makeSession();
  if (nextSession.queue.length) selectCase(nextSession.queue[0]);
  else clearRun();
  renderRun();
  notice('New benchmark session started.');
});
bind('method', () => { renderMethod(); renderRun(); }, 'change');
bind('mode', () => { $('fillers-label').hidden = $('mode').value !== 'normalized'; }, 'change');
bind('audio-file', () => {
  $('preview').pause();
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  file = $('audio-file').files[0] ?? null;
  previewUrl = file ? URL.createObjectURL(file) : '';
  if (previewUrl) $('preview').src = previewUrl;
  else $('preview').removeAttribute('src');
  renderMethod();
  renderRun();
}, 'change');

for (const type of ['json', 'csv']) {
  bind('run-' + type, () => {
    const run = current.run;
    download(run.id, type === 'json' ? run : [runRecord(run)], type);
  });
  bind('event-' + type, () => {
    const run = current.run;
    download(run.id + '-events', eventRecords(run), type);
  });
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) current?.abort('page-hidden');
});
window.addEventListener('pagehide', () => current?.abort('page-hidden'));
$('support-info').replaceWith(detailsList([
  ['Recognition API', Recognition ? (window.SpeechRecognition ? 'Standard constructor detected' : 'Prefixed constructor detected') : 'Unavailable'],
  ['Secure context', window.isSecureContext ? 'Yes' : 'No'],
  ['AudioTrack candidate', trackAvailable ? 'Eligible · actual recognition unverified' : 'Unavailable in this configuration'],
  ['Browser', browserText(browser)], ['Platform', device.platform || 'Unknown'],
  ['Device signals', (device.mobile ? 'Mobile' : 'Desktop') + ' · ' + device.touchPoints + ' touch points'],
  ['User agent', browser.userAgent]
]));

fillCaseOptions();
renderMethod();
renderRun();
if (storageError) notice('Browser storage could not be read.');
