const numbers = 'zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty'.split(' ');
const numericWords = new Map(numbers.map((word, number) => [word, String(number)]));

function words(text) {
  return text.toLowerCase().replace(/['’‘]/gu, '').match(/[\p{L}\p{N}]+/gu) ?? [];
}

const han = /\p{Script=Han}/u;

export function tokenize(text, { mode = 'strict', fillers = [], mixed = false } = {}) {
  const tokens = words(mixed ? text.replace(/\p{Script=Han}/gu, ' $& ') : text);
  if (mode !== 'normalized') return tokens;
  const ignored = new Set(fillers.flatMap(words).filter(word => !mixed || !han.test(word)));
  return tokens.filter(word => !ignored.has(word)).map(word => {
    if (/^\d+$/u.test(word)) return word.replace(/^0+(?=\d)/u, '');
    return numericWords.get(word) ?? word;
  });
}

export function align(reference, hypothesis) {
  const matrix = Array.from({ length: reference.length + 1 },
    () => new Uint32Array(hypothesis.length + 1));
  matrix.forEach((row, i) => { row[0] = i; });
  for (let j = 1; j <= hypothesis.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= reference.length; i++) {
    for (let j = 1; j <= hypothesis.length; j++) {
      const same = reference[i - 1] === hypothesis[j - 1];
      matrix[i][j] = Math.min(matrix[i - 1][j] + 1, matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + Number(!same));
    }
  }

  let i = reference.length;
  let j = hypothesis.length;
  const edits = [];
  while (i || j) {
    const ref = reference[i - 1];
    const hyp = hypothesis[j - 1];
    const same = ref === hyp;
    // Resolve equal-cost paths by preferring diagonal, deletion, then insertion.
    if (i && j && matrix[i][j] === matrix[i - 1][j - 1] + Number(!same)) {
      edits.push({ kind: same ? 'equal' : 'substitution', ref, hyp });
      i--;
      j--;
    } else if (i && matrix[i][j] === matrix[i - 1][j] + 1) {
      edits.push({ kind: 'deletion', ref, hyp: '' });
      i--;
    } else {
      edits.push({ kind: 'insertion', ref: '', hyp });
      j--;
    }
  }
  return edits.reverse();
}

export function score(reference, transcript, terms = [], options = {}) {
  const mixed = han.test(reference);
  const scoring = { ...options, mixed };
  const ref = tokenize(reference, scoring);
  const hyp = tokenize(transcript, scoring);
  const edits = align(ref, hyp);
  const counts = { substitution: 0, deletion: 0, insertion: 0 };
  for (const { kind } of edits) {
    if (kind !== 'equal') counts[kind]++;
  }
  const errorRate = ref.length ? (counts.substitution + counts.deletion + counts.insertion) / ref.length : null;
  const termOptions = { ...scoring, fillers: [] };
  const lexicalTokens = tokenize(transcript, termOptions);
  const critical = [...new Set(terms.map(term => term.trim()).filter(Boolean))].flatMap(term => {
    const phrase = tokenize(term, termOptions);
    if (!phrase.length) return [];
    return [{ term, matched: lexicalTokens.some((_, i) =>
      phrase.every((word, offset) => word === lexicalTokens[i + offset])) }];
  });
  return {
    metric: mixed ? 'MER' : 'WER', wer: mixed ? null : errorRate, mer: mixed ? errorRate : null,
    accuracy: errorRate === null ? null : 1 - errorRate,
    referenceWords: mixed ? null : ref.length, referenceTokens: ref.length, ...counts, edits, critical
  };
}

// Process only revised result indexes. Previously final slots are immutable.
export function collectResults(previous, event) {
  const slots = previous.slice(0, event.results.length);
  let newFinal = false;
  for (let i = event.resultIndex; i < event.results.length; i++) {
    if (slots[i]?.isFinal) continue;
    const result = event.results[i];
    slots[i] = { text: result[0].transcript, isFinal: result.isFinal };
    newFinal ||= result.isFinal;
  }
  return { slots, newFinal };
}

export function joinRaw(text, segment) {
  if (!text || !segment || /\s$/u.test(text) || /^\s/u.test(segment)) return text + segment;
  return text + ' ' + segment;
}

export function transcripts(slots) {
  const combine = filter => slots.filter(filter).map(slot => slot.text).reduce(joinRaw, '');
  return { final: combine(slot => slot.isFinal), interim: combine(slot => !slot.isFinal), full: combine(() => true) };
}

export const browserLatencyLabels = {
  startup: 'Start request → recognition start',
  firstResult: 'Start request → first result',
  speechToResult: 'Speech start → first result',
  speechToFinal: 'Speech end → first new final result',
  speechToEnd: 'Speech end → recognition end',
  stopToEnd: 'Manual stop → recognition end'
};

export const recordingLatencyLabels = {
  recordingStartup: 'Start request → recording start',
  endToTranscript: 'End request → final transcript'
};

export const latencyLabels = { ...browserLatencyLabels, ...recordingLatencyLabels };

export function timings(events) {
  const first = (name, predicate = () => true) =>
    events.find(event => event.name === name && predicate(event))?.ms;
  const interval = (start, end) => start !== undefined && end !== undefined && end >= start ? end - start : null;
  const begin = first('start()');
  const speechStart = first('onspeechstart');
  const speechEndIndex = events.findLastIndex(event => event.name === 'onspeechend');
  const speechEnd = events[speechEndIndex]?.ms;
  const end = first('onend');
  const result = first('onresult', event => event.hasResult);
  const final = speechEndIndex < 0 ? undefined :
    events.slice(speechEndIndex + 1).find(event => event.name === 'onresult' && event.newFinal)?.ms;
  return {
    startup: interval(begin, first('onstart')),
    firstResult: interval(begin, result),
    speechToResult: interval(speechStart, result),
    speechToFinal: interval(speechEnd, final),
    speechToEnd: interval(speechEnd, end),
    stopToEnd: interval(first('stop()'), end)
  };
}

export function stats(values) {
  const valid = values.filter(Number.isFinite).sort((a, b) => a - b);
  const count = valid.length;
  const percentile = p => {
    if (!count) return null;
    const index = (count - 1) * p;
    const floor = Math.floor(index);
    return valid[floor] + (valid[Math.ceil(index)] - valid[floor]) * (index - floor);
  };
  return {
    count, missing: values.length - count,
    average: count ? valid.reduce((sum, value) => sum + value, 0) / count : null,
    p50: percentile(0.5), p95: percentile(0.95), min: valid[0] ?? null, max: valid.at(-1) ?? null
  };
}

export function aggregate(runs) {
  const successful = runs.filter(run => run.success).length;
  const terms = runs.flatMap(run => run.evaluation.critical);
  const matched = terms.filter(term => term.matched).length;
  return {
    total: runs.length, successful, failed: runs.length - successful,
    successRate: runs.length ? successful / runs.length : null,
    wer: stats(runs.filter(run => run.evaluation.metric !== 'MER').map(run => run.evaluation.wer)),
    mer: stats(runs.filter(run => run.evaluation.metric === 'MER').map(run => run.evaluation.mer)),
    critical: { matched, total: terms.length, rate: terms.length ? matched / terms.length : null },
    latency: Object.fromEntries(Object.keys(latencyLabels).map(key => [key, stats(runs.map(run => run.latency[key]))]))
  };
}

export function groupMetrics(runs, by) {
  const groups = new Map();
  for (const run of runs) {
    const key = by(run);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(run);
  }
  return Array.from(groups, ([group, entries]) => ({ group, ...aggregate(entries) }));
}

export function json(data) {
  return JSON.stringify(data, null, 2) + '\n';
}

export function csv(records) {
  if (!records.length) return '';
  const columns = [...new Set(records.flatMap(Object.keys))];
  const escape = value => {
    let text = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
    // Keep spreadsheet formula prefixes inert while JSON retains the exact raw value.
    if (typeof value === 'string' && /^(?:\s*[=+@-]|[\t\r\n])/u.test(text)) text = "'" + text;
    return '"' + text.replaceAll('"', '""') + '"';
  };
  return [columns.map(escape), ...records.map(record => columns.map(key => escape(record[key])))]
    .map(row => row.join(',')).join('\r\n') + '\r\n';
}
