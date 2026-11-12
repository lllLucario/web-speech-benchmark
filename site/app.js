import { builtInCases, mixedCases, parseDataset } from './dataset.js';
import { aggregate, csv, groupMetrics, json, browserLatencyLabels, latencyLabels, recordingLatencyLabels, score } from './benchmark.js';
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

const ios = /iPhone|iPad|iPod/u.test(browser.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

const params = new URLSearchParams(location.search);
const manualEndTest = params.get('manual-end') === '1';
const iphoneCompatibilityAvailable = ios && !manualEndTest &&
  Boolean(window.speechSynthesis && window.SpeechSynthesisUtterance);
const muteStartupAudio = params.get('startup-audio') === 'muted';

const STORAGE = 'order-signal-v1';
let storageError = false;
function readStorage() {
  try { return JSON.parse(localStorage.getItem(STORAGE)) ?? {}; }
  catch { storageError = true; return {}; }
}
const stored = readStorage();
let cases = stored.cases ?? structuredClone(builtInCases);
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

const errorMetric = evaluation => evaluation.metric === 'MER' ? 'MER' : 'WER';
const errorValue = evaluation => errorMetric(evaluation) === 'MER' ? evaluation.mer : evaluation.wer;

function accuracyView(run, showTranscripts = true) {
  if (!run) return el('p', 'Finish a recognition attempt to compare it with the reference.', 'muted');
  const root = el('div');
  const evaluation = run.evaluation ?? score(run.reference, run.transcripts.final, run.criticalTerms, run.scoring);
  const summary = el('div', '', 'metrics');
  const matched = evaluation.critical.filter(item => item.matched).length;
  const mixed = errorMetric(evaluation) === 'MER';
  summary.append(metric(errorMetric(evaluation), pct(errorValue(evaluation))),
    metric(mixed ? 'Token accuracy' : 'Word accuracy', pct(evaluation.accuracy)),
    metric('Substitutions / Deletions / Insertions', [evaluation.substitution, evaluation.deletion, evaluation.insertion].join(' / ')),
    metric('Critical terms', evaluation.critical.length ? matched + ' / ' + evaluation.critical.length : 'N/A'));
  root.append(summary);
  if (showTranscripts) {
    const comparison = el('div', '', 'comparison');
    for (const [title, value] of [['Reference', run.reference], ['Original transcript', run.transcripts.final || '—']]) {
      const column = el('div');
      column.append(el('h3', title), el('p', value, 'raw'));
      comparison.append(column);
    }
    root.append(comparison);
  }
  const diff = el('div', '', 'diff');
  for (const { kind, ref, hyp } of evaluation.edits) {
    const token = el('span', kind === 'substitution' ? ref + ' → ' + hyp :
      kind === 'deletion' ? '−' + ref : kind === 'insertion' ? '+' + hyp : hyp, kind);
    token.title = kind;
    diff.append(token);
  }
  root.append(el('h3', (mixed ? 'Token' : 'Word') + ' alignment · ' + run.scoring.mode), diff);
  if (evaluation.critical.length) {
    root.append(el('h3', 'Critical phrase matches'),
      el('p', evaluation.critical.map(item => (item.matched ? '✓ ' : '✗ ') + item.term).join(' · ')));
  }
  return root;
}

function inputName(run) {
  const label = inputLabels[run.method];
  if (run.manualEndTest) return label + ' · Manual end test';
  if (run.iphoneCompatibility) return label + ' · Automatic end on iPhone';
  return label;
}

function runRecord(run) {
  const { events, evaluation, ...rest } = run;
  return {
    ...rest, browser: browserText(run.browser), userAgent: run.browser.userAgent,
    rawTranscript: run.transcripts.final, interimTranscript: run.transcripts.interim,
    fullTranscript: run.transcripts.full, errorMetric: errorMetric(evaluation), wer: evaluation.wer, mer: evaluation.mer ?? null,
    wordAccuracy: errorMetric(evaluation) === 'WER' ? evaluation.accuracy : null,
    tokenAccuracy: errorMetric(evaluation) === 'MER' ? evaluation.accuracy : null,
    substitutions: evaluation.substitution, deletions: evaluation.deletion, insertions: evaluation.insertion,
    critical: evaluation.critical, eventCount: events.length,
    ...Object.fromEntries(Object.entries(run.latency).map(([key, value]) => [key + 'Ms', value]))
  };
}

function eventRecords(run) {
  const metadata = runRecord(run);
  return run.events.map((event, index) => ({ ...metadata, eventIndex: index, ...event }));
}
function browserText(info) {
  const version = {
    Edge: /Edg(?:A|iOS)?\/([\d.]+)/u,
    Chrome: /(?:Chrome|CriOS)\/([\d.]+)/u,
    Firefox: /(?:Firefox|FxiOS)\/([\d.]+)/u,
    Safari: /Version\/([\d.]+)/u
  }[info.name]?.exec(info.userAgent)?.[1];
  return version ? info.name + ' ' + version : info.name;
}

function renderCase() {
  const item = selectedCase();
  $('case-select').value = caseId;
  $('reference').textContent = item.reference;
  $('case-progress').textContent = item.id + (item.completed ? ' ✓' : '');
  $('case-notes').textContent = item.notes;
  $('case-notes').hidden = !item.notes;
  $('mixed-help').hidden = !/\p{Script=Han}/u.test(item.reference);
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
  $('iphone-help').hidden = !iphoneCompatibilityAvailable || method !== 'live';
  $('manual-end-help').hidden = !manualEndTest || method !== 'live';
  $('audio-area').hidden = method === 'live';
  $('file-label').hidden = method !== 'track';
  $('preview').hidden = method !== 'track' || !file;
  $('method-help').textContent = method === 'external'
    ? 'Start recognition on this device, then play the case recording from a separate device. Tap the same button to end recognition, then save the run.'
    : trackAvailable ? 'Choose and preview a file. Recognition routes it through an audio track. This path requires a successful file test.'
      : 'AudioTrack is unavailable here. Choose External audio playback to test a recording from a separate device.';
}

function renderSave() {
  const run = current?.run;
  const saved = session?.runs.find(item => item.id === run?.id);
  const hasEdits = saved && saved.editedTranscript !== run.editedTranscript;
  $('save').disabled = current?.state !== 'finished' || Boolean(saved && !hasEdits);
  $('save').textContent = hasEdits ? 'Save edits' : saved ? 'Run saved' : 'Save run';
}

function canReset() {
  return current?.state === 'finished' && Boolean(
    current.run.transcripts.final.trim() && $('transcript').value.trim()
  );
}

function renderRun() {
  const run = current?.run;
  const busy = active();
  const ready = current?.state === 'finished';
  const method = $('method').value;
  const canStart = Recognition && window.isSecureContext && (method !== 'track' || (trackAvailable && file));
  const state = current?.state ?? 'idle';
  const statuses = {
    idle: Recognition ? 'Idle' : 'API unavailable',
    preparing: method === 'track' ? 'Preparing audio' : 'Starting…',
    starting: 'Starting…',
    listening: 'Listening',
    stopping: 'Finishing',
    finished: run?.success ? 'Complete' : 'Unsuccessful'
  };
  const status = $('status');
  if (status.textContent !== statuses[state]) status.textContent = statuses[state];
  status.dataset.state = state;
  const error = run?.errors.at(-1)?.message || (ready && run.termination === 'page-hidden' ? 'Recognition stopped when the page was hidden.' :
    ready && run.manualEndTest && run.termination === 'browser' ? 'The browser ended recognition before you tapped End.' :
    ready && !run.transcripts.final.trim() ? 'No final transcript was returned.' :
    !window.isSecureContext ? 'Recognition requires HTTPS or localhost.' :
    !Recognition ? 'This browser does not expose the speech recognition API.' : '');
  if ($('error').textContent !== error) $('error').textContent = error;
  $('error').hidden = !error;
  const compatibility = Boolean(run?.iphoneCompatibility);
  const captureHint = current?.waitingForResult
    ? compatibility
      ? 'The browser has not ended the run yet. If it is stuck, cancel the run and reopen the browser.'
      : 'No transcription yet. If you are already speaking, end the run and try again.'
    : ios && ready && !run.transcripts.full.trim() &&
      run.events.some(event => event.name === 'onstart') &&
      !run.errors.some(item => ['not-allowed', 'service-not-allowed', 'network'].includes(item.code))
      ? 'If the next run still produces no text, fully close and reopen the browser.'
      : '';
  $('capture-hint').textContent = captureHint;
  $('capture-hint').hidden = !captureHint;
  const labels = compatibility
    ? {
        preparing: 'Cancel', starting: 'Starting…',
        listening: current.waitingForResult ? 'Cancel stalled run' : 'Ends automatically', stopping: 'Finishing…'
      }
    : { preparing: 'Cancel audio setup', starting: 'End recognition', listening: 'End recognition', stopping: 'Finishing…' };
  $('start-label').textContent = labels[state] ?? (method === 'track' ? 'Test audio file' : 'Start recognition');
  $('start').disabled = busy
    ? state === 'stopping' || (compatibility && state !== 'preparing' && !current.waitingForResult)
    : !canStart;
  for (const id of ['language', 'method', 'case-select', 'mode', 'fillers', 'audio-file', 'next', 'repeat', 'mixed-case', 'new-session', 'queue', 'network', 'environment']) $(id).disabled = busy;
  renderSave();
  for (const id of ['run-json', 'run-csv', 'event-json', 'event-csv']) $(id).disabled = !ready;
  const transcript = $('transcript');
  transcript.readOnly = !ready;
  const value = ready ? (run.editedTranscript ?? run.transcripts.final) : (run?.transcripts?.full ?? '');
  if (transcript.value !== value) transcript.value = value;
  $('reset').disabled = !canReset();
  $('latencies').replaceChildren(...Object.entries(browserLatencyLabels).map(([key, label]) => metric(label, ms(run?.latency[key]))));
  const events = run?.events ?? [];
  $('event-count').textContent = '(' + events.length + ')';
  const eventLabels = {
    readyPromptRequested: 'Startup audio requested',
    readyPromptEnd: 'Startup audio finished',
    readyPromptError: 'Startup audio failed'
  };
  $('events').replaceChildren(...events.map(event => el('li', ms(event.ms) + ' · ' + (eventLabels[event.name] ?? event.name) +
    (event.code ? ' · ' + event.code : '') + (event.newFinal ? ' · new final' : ''))));
  if (ready || state === 'idle' || state === 'preparing') $('accuracy').replaceChildren(accuracyView(ready ? run : null));
  const sequence = queueIds();
  const position = sequence.indexOf(caseId);
  const progress = position < 0 ? 'Outside the current sequence' : 'Case ' + (position + 1) + ' of ' + sequence.length;
  $('session-label').textContent = progress + (session ? ' · ' + session.runs.length + ' saved in current session' : '');
  $('next').disabled = busy || position === sequence.length - 1;
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
function queueIds() {
  const chosen = (session?.queue ?? []).filter(id => cases.some(item => item.id === id));
  return chosen.length ? chosen : cases.map(item => item.id);
}
const configuration = () => ({
  language: $('language').value, method: $('method').value,
  manualEndTest: manualEndTest && $('method').value === 'live',
  iosAudioSessionTest: ios && manualEndTest && $('method').value === 'live',
  iphoneCompatibility: iphoneCompatibilityAvailable && $('method').value === 'live',
  mutedStartupAudio: muteStartupAudio && iphoneCompatibilityAvailable && $('method').value === 'live',
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
  if (!session) return makeSession();
  const previous = {
    ...session,
    manualEndTest: Boolean(session.manualEndTest),
    iosAudioSessionTest: Boolean(session.iosAudioSessionTest),
    iphoneCompatibility: Boolean(session.iphoneCompatibility),
    mutedStartupAudio: Boolean(session.mutedStartupAudio)
  };
  if (Object.entries(settings).some(([key, value]) => previous[key] !== value)) return makeSession();
  return session;
}

function startRun() {
  if (active() || $('start').disabled) return;
  if (!$('preview').paused) $('preview').pause();
  const item = selectedCase();
  const parent = sessionForRun();
  const run = {
    id: uuid(), sessionId: parent.id, startedAt: new Date().toISOString(),
    caseId, category: item.category, reference: item.reference, criticalTerms: [...item.criticalTerms],
    notes: item.notes, audioReference: item.audio, fileName: parent.method === 'track' ? file.name : null,
    browser, device, ...configuration(), interim: true,
    scoring: { mode: $('mode').value, fillers: $('fillers').value.split(',').map(value => value.trim()).filter(Boolean) },
    events: [], errors: [], manualStop: false, termination: null
  };
  current = new RecognitionRun(Recognition, run, () => {
    if (current?.run !== run) return;
    if (current.state === 'finished') {
      run.success = Boolean(run.transcripts.final.trim()) && !run.errors.length &&
        (run.manualEndTest ? run.termination === 'manual' && run.events.some(event => event.name === 'onend')
          : ['manual', 'browser', 'audio-ended'].includes(run.termination));
      run.evaluation = score(run.reference, run.transcripts.final, run.criticalTerms, run.scoring);
    }
    renderRun();
  });
  current.start(file);
}

function saveRun() {
  const run = current?.run;
  if ($('save').disabled || !run) return;
  const index = session.runs.findIndex(item => item.id === run.id);
  run.saved = true;
  const snapshot = { ...run };
  if (index < 0) {
    session.runs.push(snapshot);
    if (!sessions.includes(session)) sessions.push(session);
    const item = cases.find(candidate => candidate.id === run.caseId);
    if (run.success && item) item.completed = true;
    fillCaseOptions(batchSelection());
  } else {
    session.runs[index] = snapshot;
  }
  if (persist()) notice(index < 0 ? 'Run saved on this device.' : 'Transcript edits saved.');
  renderRun();
}

bind('start', () => {
  if (current?.state === 'preparing') current.abort('cancelled');
  else if (active() && current.run.iphoneCompatibility) {
    if (current.waitingForResult) current.abort('cancelled');
  } else if (active()) current.requestStop();
  else startRun();
});
bind('transcript', () => {
  if (current?.state !== 'finished') return;
  const { run } = current;
  const value = $('transcript').value;
  run.editedTranscript = value === run.transcripts.final ? undefined : value;
  $('reset').disabled = !canReset();
  renderSave();
}, 'input');
bind('reset', () => {
  if (canReset()) clearRun();
});
bind('save', saveRun);
bind('case-select', () => selectCase($('case-select').value), 'change');
bind('next', () => {
  const ids = queueIds();
  const next = ids.indexOf(caseId) + 1;
  if (next < ids.length) selectCase(ids[next]);
  else notice('You’ve reached the end of the selected cases.');
});
bind('repeat', clearRun);
bind('mixed-case', () => {
  if (active()) return;
  const missing = mixedCases.filter(item => !cases.some(existing => existing.id === item.id));
  if (missing.length) {
    cases = [...cases, ...structuredClone(missing)];
    fillCaseOptions(batchSelection());
    persist();
  }
  const prompt = cases.find(item =>
    mixedCases.some(example => example.id === item.id) && /\p{Script=Han}/u.test(item.reference));
  if (prompt) selectCase(prompt.id);
  else notice('The built-in mixed prompt IDs are already used in this dataset.');
});
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
  if (!$('preview').paused) $('preview').pause();
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

if (session) {
  $('language').value = session.language;
  if (!manualEndTest && ['external', 'track'].includes(session.method)) $('method').value = session.method;
  $('network').value = session.network;
  $('environment').value = session.environment;
}
fillCaseOptions(session?.queue);
renderMethod();
renderRun();
if (storageError) notice('Browser storage could not be read.');

let editingId = null;

function showEditor(item) {
  editingId = item?.id ?? null;
  $('editor-title').textContent = item ? 'Edit case' : 'Add case';
  $('edit-id').value = item?.id ?? 'CUSTOM-' + uuid().slice(0, 8);
  $('edit-category').value = item?.category ?? 'Custom';
  $('edit-reference').value = item?.reference ?? '';
  $('edit-terms').value = item?.criticalTerms.join('\n') ?? '';
  $('edit-audio').value = item?.audio ?? '';
  $('edit-notes').value = item?.notes ?? '';
  $('edit-completed').checked = item?.completed ?? false;
  $('use-case').disabled = !item;
  for (const button of $('case-list').children) {
    button.setAttribute('aria-pressed', String(button.dataset.id === editingId));
  }
}

function renderDataset() {
  $('case-list').replaceChildren(...cases.map(item => {
    const button = el('button', item.id + ' · ' + item.category + (item.completed ? ' ✓' : ''));
    button.type = 'button';
    button.dataset.id = item.id;
    button.append(el('small', item.reference));
    button.addEventListener('click', () => showEditor(item));
    return button;
  }));
  showEditor(cases.find(item => item.id === editingId) ?? selectedCase());
}

bind('custom-case', () => {
  showEditor(null);
  $('edit-reference').focus();
});
bind('edit-form', event => {
  event.preventDefault();
  if (active()) { notice('Finish the current recognition attempt before editing cases.'); return; }
  const index = cases.findIndex(item => item.id === editingId);
  const draft = [...cases];
  const item = {
    id: $('edit-id').value.trim(), category: $('edit-category').value.trim(), reference: $('edit-reference').value,
    criticalTerms: $('edit-terms').value.split('\n').map(term => term.trim()).filter(Boolean),
    audio: $('edit-audio').value.trim(), notes: $('edit-notes').value, completed: $('edit-completed').checked
  };
  if (index < 0) draft.push(item);
  else draft[index] = item;
  try {
    const previousId = editingId;
    const selection = batchSelection().map(id => id === previousId ? item.id : id);
    cases = parseDataset(draft);
    if (caseId === previousId) caseId = item.id;
    editingId = item.id;
    fillCaseOptions(selection);
    renderDataset();
    renderRun();
    if (persist()) notice('Case saved.');
  } catch (error) { notice(error.message); }
}, 'submit');
bind('use-case', () => {
  if (active()) { notice('Finish the current recognition attempt before changing cases.'); return; }
  selectCase(editingId);
  location.hash = 'bench';
});
bind('import-dataset', async () => {
  const input = $('import-dataset');
  const selected = input.files[0];
  input.value = '';
  if (!selected) return;
  try {
    const imported = parseDataset(JSON.parse(await selected.text()));
    if (active()) throw new Error('Finish the current recognition attempt before importing a dataset.');
    cases = imported;
    caseId = cases[0].id;
    editingId = caseId;
    fillCaseOptions();
    clearRun();
    renderDataset();
    if (persist()) notice('Loaded ' + cases.length + ' cases.');
  } catch (error) { notice('Import failed. ' + error.message); }
}, 'change');
bind('export-dataset', () => download('order-signal-dataset', { schemaVersion: 1, cases }));

const localDate = value => new Date(value).toLocaleString();
const sessionName = item => localDate(item.createdAt) + ' · ' + item.id.slice(0, 8);
const scope = () => {
  const selection = $('history-select').value;
  return selection ? sessions.filter(item => item.id === selection) : sessions;
};

function table(columns, rows, label) {
  const wrapper = el('div', '', 'scroll');
  wrapper.tabIndex = 0;
  wrapper.setAttribute('role', 'region');
  wrapper.setAttribute('aria-label', label);
  const element = el('table');
  const header = element.createTHead().insertRow();
  for (const value of columns) {
    const th = el('th', value);
    th.scope = 'col';
    header.append(th);
  }
  const body = element.createTBody();
  for (const values of rows) {
    const row = body.insertRow();
    for (const value of values) row.append(el('td', String(value)));
  }
  wrapper.append(element);
  return wrapper;
}

function breakdown(runs) {
  return {
    language: groupMetrics(runs, run => run.language),
    browser: groupMetrics(runs, run => browserText(run.browser)),
    input: groupMetrics(runs, inputName),
    languageAndInput: groupMetrics(runs, run => run.language + ' · ' + inputName(run)),
    browserAndInput: groupMetrics(runs, run => browserText(run.browser) + ' · ' + inputName(run))
  };
}

const overviewColumns = ['Group', 'Runs', 'Success rate', 'Average WER', 'Median WER', 'Average MER', 'Median MER', 'First result P50', 'First result P95', 'Critical terms'];
const overviewRow = (label, metrics) => [
  label, metrics.total, pct(metrics.successRate), pct(metrics.wer.average), pct(metrics.wer.p50),
  pct(metrics.mer.average), pct(metrics.mer.p50),
  ms(metrics.latency.firstResult.p50), ms(metrics.latency.firstResult.p95), pct(metrics.critical.rate)
];

function historicalRun(run) {
  const entry = el('details', '', 'run-item');
  entry.append(el('summary', [run.caseId, run.success ? 'Recognized' : 'Failed', pct(errorValue(run.evaluation)) + ' ' + errorMetric(run.evaluation), localDate(run.startedAt)].join(' · ')),
    detailsList([
      ['Browser / device', browserText(run.browser) + ' · ' + (run.device.platform || 'Unknown')],
      ['Input', inputName(run)],
      ['Language', run.language],
      ['Network', run.network || 'Unspecified'],
      ['Environment', run.environment],
      ['Termination', run.termination],
      ['Errors', run.errors.map(error => error.code + ' · ' + error.message).join(' / ') || 'None']
    ]), accuracyView(run));
  if (run.editedTranscript !== undefined) {
    entry.append(el('h3', 'Edited transcript'), el('p', run.editedTranscript, 'raw'));
  }
  const latency = el('div', '', 'metrics');
  latency.append(...Object.entries(run.method === 'recorded' ? recordingLatencyLabels : browserLatencyLabels).map(([key, label]) => metric(label, ms(run.latency[key]))));
  entry.append(latency);
  const actions = el('div', '', 'actions');
  for (const [label, suffix, type, data] of [
    ['Run JSON', '', 'json', () => run], ['Run CSV', '', 'csv', () => [runRecord(run)]],
    ['Events JSON', '-events', 'json', () => eventRecords(run)], ['Events CSV', '-events', 'csv', () => eventRecords(run)]
  ]) {
    const button = el('button', label);
    button.type = 'button';
    button.addEventListener('click', () => download(run.id + suffix, data(), type));
    actions.append(button);
  }
  entry.append(actions);
  return entry;
}

function renderHistory() {
  const selected = $('history-select').value;
  $('history-select').replaceChildren(new Option('All saved sessions', ''),
    ...[...sessions].reverse().map(item => new Option(sessionName(item), item.id, false, item.id === selected)));
  const visible = scope();
  const root = $('history');
  root.replaceChildren();
  for (const id of ['session-json', 'session-csv', 'aggregate-json', 'aggregate-csv']) $(id).disabled = visible.length === 0;
  if (!visible.length) {
    root.append(el('p', 'Save a recognition run to see session history and metrics here.', 'muted'));
    return;
  }
  const runs = visible.flatMap(item => item.runs);
  const total = aggregate(runs);
  const stats = el('div', '', 'metrics');
  stats.append(metric('Runs', String(total.total)), metric('Successful', String(total.successful)),
    metric('Failed', String(total.failed)), metric('Success rate', pct(total.successRate)),
    metric('Average WER', pct(total.wer.average)), metric('Median WER', pct(total.wer.p50)),
    metric('Average MER', pct(total.mer.average)), metric('Median MER', pct(total.mer.p50)),
    metric('Critical phrase matches', pct(total.critical.rate)));
  root.append(el('p', visible.length + ' session(s) · ' + [...new Set(runs.map(inputName))].join(' / '), 'muted'), stats);
  const groups = breakdown(runs);
  for (const [title, entries] of [
    ['By input method', groups.input], ['By language', groups.language], ['By browser', groups.browser],
    ['Language and input method', groups.languageAndInput], ['Browser and input method', groups.browserAndInput]
  ]) {
    const section = el('section', '', 'ruled');
    section.append(el('h2', title), table(overviewColumns, entries.map(item => overviewRow(item.group, item)), title));
    root.append(section);
  }
  const latency = el('section', '', 'ruled');
  latency.append(el('h2', 'Latency by input method'),
    table(['Input method / interval', 'Measured', 'Missing', 'Average', 'P50', 'P95', 'Min', 'Max'],
      groups.input.flatMap(item => Object.entries(item.latency).map(([key, value]) =>
        [item.group + ' · ' + latencyLabels[key], value.count, value.missing,
          ms(value.average), ms(value.p50), ms(value.p95), ms(value.min), ms(value.max)])), 'Latency by input method'));
  root.append(latency);
  if ($('compare-sessions').checked && sessions.length > 1) {
    const comparison = el('section', '', 'ruled');
    comparison.append(el('h2', 'Saved session comparison'),
      table(overviewColumns, [...sessions].reverse().map(item => overviewRow(
        [sessionName(item), browserText(item.browser), item.language, inputName(item), item.environment, item.network || 'Network unspecified'].join(' · '),
        aggregate(item.runs))), 'Saved session comparison'));
    root.append(comparison);
  }
  const list = el('section', '', 'ruled');
  list.append(el('h2', 'Saved runs'));
  for (const item of [...visible].reverse()) {
    const group = el('details', '', 'run-item');
    group.open = visible.length === 1;
    group.append(el('summary', sessionName(item) + ' · ' + inputName(item) + ' · ' + item.runs.length + ' runs'),
      ...[...item.runs].reverse().map(historicalRun));
    list.append(group);
  }
  root.append(list);
}

bind('history-select', renderHistory, 'change');
bind('compare-sessions', renderHistory, 'change');
bind('session-json', () => download('order-signal-sessions', { schemaVersion: 1, sessions: scope() }));
bind('session-csv', () => download('order-signal-sessions', scope().flatMap(item =>
  item.runs.map(run => ({ ...runRecord(run), sessionCreatedAt: item.createdAt, queue: item.queue, events: run.events }))), 'csv'));

function metricsExport() {
  const selection = scope();
  const runs = selection.flatMap(item => item.runs);
  return {
    exportedAt: new Date().toISOString(), sessionIds: selection.map(item => item.id),
    inputs: [...new Set(runs.map(inputName))],
    overall: aggregate(runs), ...breakdown(runs),
    sessions: selection.map(item => ({ group: item.id, method: item.method, ...aggregate(item.runs) }))
  };
}

bind('aggregate-json', () => download('order-signal-metrics', metricsExport()));
bind('aggregate-csv', () => {
  const { exportedAt, sessionIds, inputs, overall, ...groups } = metricsExport();
  const rows = Object.entries({ overall: [{ group: inputs.join(' / '), ...overall }], ...groups })
    .flatMap(([dimension, entries]) => entries.flatMap(({ latency, ...item }) =>
      Object.entries(latency).map(([interval, values]) => ({
        exportedAt, sessionIds, dimension, ...item, interval, label: latencyLabels[interval], ...values
      }))));
  download('order-signal-metrics', rows, 'csv');
});

function renderScoringLab() {
  const example = {
    reference: $('lab-reference').value,
    transcripts: { final: $('lab-transcript').value },
    criticalTerms: $('lab-terms').value.split('\n'),
    scoring: {
      mode: $('lab-mode').value,
      fillers: $('fillers').defaultValue.split(',').map(word => word.trim()).filter(Boolean)
    }
  };
  $('lab-score').replaceChildren(accuracyView(example, false));
}

for (const id of ['lab-reference', 'lab-transcript', 'lab-terms', 'lab-mode']) bind(id, renderScoringLab, 'input');

const resultTabs = { history: '#results', scoring: '#results/scoring' };
for (const [tab, hash] of Object.entries(resultTabs)) {
  bind('tab-' + tab, () => { location.hash = hash; });
  bind('tab-' + tab, event => {
    const next = { ArrowLeft: tab === 'history' ? 'scoring' : 'history', ArrowRight: tab === 'history' ? 'scoring' : 'history', Home: 'history', End: 'scoring' }[event.key];
    if (!next) return;
    event.preventDefault();
    $('tab-' + next).focus();
    location.hash = resultTabs[next];
  }, 'keydown');
}

let sourceRequested = false;
bind('scoring-code-details', async () => {
  if (!$('scoring-code-details').open || sourceRequested) return;
  sourceRequested = true;
  try {
    const response = await fetch($('scoring-source-link').href);
    if (!response.ok) throw new Error('Could not load source');
    $('scoring-code').textContent = await response.text();
  } catch {
    sourceRequested = false;
    $('scoring-code').textContent = 'Could not load source. Reopen this section to retry.';
  }
}, 'toggle');

function route() {
  const scoring = location.hash === resultTabs.scoring;
  const view = scoring ? 'results' : ['bench', 'dataset', 'results'].find(id => '#' + id === location.hash) ?? 'bench';
  for (const link of document.querySelectorAll('nav [data-view]')) {
    const selected = link.dataset.view === view;
    $(link.dataset.view).hidden = !selected;
    if (selected) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  if (view === 'dataset') renderDataset();
  if (view === 'results') {
    for (const tab of Object.keys(resultTabs)) {
      const selected = tab === (scoring ? 'scoring' : 'history');
      $('tab-' + tab).setAttribute('aria-selected', String(selected));
      $('tab-' + tab).tabIndex = selected ? 0 : -1;
      $('panel-' + tab).hidden = !selected;
    }
    if (scoring) renderScoringLab();
    else renderHistory();
  }
}

window.addEventListener('hashchange', route);
route();
