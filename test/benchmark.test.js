import test from 'node:test';
import assert from 'node:assert/strict';
import { align, collectResults, csv, json, score, stats, timings, transcripts } from '../site/benchmark.js';
import { builtInCases, loadCases, parseDataset } from '../site/dataset.js';

test('WER reports all edit types and can exceed 100%', () => {
  const result = score('one two three', 'two four five six');
  assert.equal(result.substitution + result.deletion + result.insertion, 4);
  assert.equal(result.wer, 4 / 3);
  assert.equal(score('one', 'one two three').accuracy, -1);
  assert.equal(score('', 'one').wer, null);
  assert.deepEqual(align(['a', 'b', 'c'], ['a', 'x', 'c', 'y']).map(edit => edit.kind),
    ['equal', 'substitution', 'equal', 'insertion']);
  assert.equal(score('one two', 'one').deletion, 1);
});

test('normalization maps numbers and selected filler tokens with lexical phrase matching', () => {
  const options = { mode: 'normalized', fillers: ['um'] };
  assert.equal(score('Um, two coffees', '02 coffees', ['two coffees'], options).critical[0].matched, true);
  assert.equal(score('Um, two coffees', '02 coffees', [], options).wer, 0);
  assert.equal(score('Two coffees.', '2 coffees').wer, 0.5);
  assert.equal(score('no onions', 'no fried onions', ['no onions'], options).critical[0].matched, false);
});

test('deduplicates final indexes, updates interim text and preserves raw segments', () => {
  const result = (transcript, isFinal) => Object.assign([{ transcript }], { isFinal });
  const first = collectResults([], { resultIndex: 0, results: [result('Hi, ', true), result('um', false)] });
  const second = collectResults(first.slots, { resultIndex: 0, results: [result('Hi, ', true), result('two!', true)] });
  assert.equal(second.newFinal, true);
  assert.deepEqual(transcripts(second.slots), { final: 'Hi, two!', interim: '', full: 'Hi, two!' });
  assert.equal(collectResults(second.slots, { resultIndex: 0, results: [result('Hi, ', true), result('two!', true)] }).newFinal, false);
  assert.equal(collectResults(first.slots, { resultIndex: 1, results: [result('Hi, ', true)] }).slots.length, 1);
});

test('missing or out-of-order events never become synthetic latency', () => {
  assert.deepEqual(timings([
    { name: 'start()', ms: 0 }, { name: 'onstart', ms: 10 },
    { name: 'onresult', ms: 15, hasResult: true, newFinal: true },
    { name: 'onspeechstart', ms: 20 }, { name: 'onspeechend', ms: 30 },
    { name: 'onresult', ms: 40, hasResult: true, newFinal: false },
    { name: 'onend', ms: 60 }
  ]), { startup: 10, firstResult: 15, speechToResult: null, speechToFinal: null, speechToEnd: 30, stopToEnd: null });
});

test('final transcript latency waits for the last final segment', () => {
  assert.equal(timings([
    { name: 'onspeechend', ms: 100 },
    { name: 'onresult', ms: 140, newFinal: true },
    { name: 'onresult', ms: 175, newFinal: true },
    { name: 'onend', ms: 180 }
  ]).speechToFinal, 75);
});

test('latency stats skip missing values and interpolate P50/P95', () => {
  const { p95, ...summary } = stats([null, 30, 0, 10, 20]);
  assert.deepEqual(summary, { count: 4, missing: 1, average: 15, p50: 15, min: 0, max: 30 });
  assert.ok(Math.abs(p95 - 28.5) < 1e-12);
  assert.equal(stats([null]).p95, null);
});

test('exports preserve JSON and escape CSV punctuation and spreadsheet formulas', () => {
  const records = [{ raw: 'x, "y"\n!', ms: null }, { raw: '=3+5', ms: 0 }];
  assert.deepEqual(JSON.parse(json(records)), records);
  assert.equal(csv(records), "\"raw\",\"ms\"\r\n\"x, \"\"y\"\"\n!\",\"\"\r\n\"'=3+5\",\"0\"\r\n");
});

test('dataset replaces cached built-in cases with the 50 benchmark prompts', () => {
  const entries = parseDataset({ cases: builtInCases });
  assert.equal(entries.length, 50);
  assert.equal(entries.filter(entry => entry.category === 'English · Short').length, 40);
  assert.equal(entries.filter(entry => entry.category === 'English · Long').length, 10);
  assert.equal(entries[0].id, 'ASR-01');
  assert.equal(entries[49].id, 'ASR-50');
  assert.throws(() => parseDataset([entries[0], entries[0]]), /Duplicate/u);

  const custom = { id: 'CUSTOM-1', reference: 'A custom prompt', category: 'Custom' };
  const legacy = { ...custom, id: 'ORD-01' };
  const migrated = loadCases([legacy, custom]);
  assert.equal(migrated.length, 51);
  assert.equal(migrated.some(entry => entry.id === legacy.id), false);
  assert.ok(migrated.includes(custom));
  assert.deepEqual(loadCases([custom]), [custom]);
});

test('normalized scoring equates spoken and written dollar amounts while retaining their value and unit', () => {
  const options = { mode: 'normalized' };
  for (const transcript of ['$10', '10$', '10 dollars', '$10.00']) {
    const evaluation = score('ten dollars', transcript, ['ten dollars'], options);
    assert.equal(evaluation.wer, 0, transcript);
    assert.equal(evaluation.critical[0].matched, true, transcript);
  }
  assert.equal(score('one hundred and fifty dollars', '150$', [], options).wer, 0);
  assert.equal(score('twenty-five dollars', '$25', [], options).wer, 0);
  assert.equal(score('十份 ten dollars', '十份 10$', [], options).mer, 0);
  for (const transcript of ['$11', 'ten', '€10', '$10.50']) {
    const evaluation = score('ten dollars', transcript, ['ten dollars'], options);
    assert.ok(evaluation.wer > 0, transcript);
    assert.equal(evaluation.critical[0].matched, false, transcript);
  }
  assert.ok(score('no peanuts, eighty dollars', 'peanuts, $80', ['no peanuts'], options).wer > 0);
  assert.equal(score('three, no sorry, four people', '3, no sorry, 4 people', [], options).wer, 0);
  assert.ok(score('ten dollars', '$10', [], { mode: 'strict' }).wer > 0);
});

test('aggregation counts failed runs, excludes missing timings and keeps methods separate', async () => {
  const { aggregate, groupMetrics } = await import('../site/benchmark.js');
  const runs = [
    { method: 'live', success: true, evaluation: score('two coffees', 'two coffees', ['two']), latency: { firstResult: 120 } },
    { method: 'external', success: false, evaluation: score('two coffees', '', ['two']), latency: { firstResult: null } }
  ];
  const total = aggregate(runs);
  assert.equal(total.successRate, 0.5);
  assert.equal(total.wer.average, 0.5);
  assert.deepEqual(total.critical, { matched: 1, total: 2, rate: 0.5 });
  assert.equal(total.latency.firstResult.average, 120);
  assert.equal(total.latency.firstResult.missing, 1);
  const [live, external] = groupMetrics(runs, run => run.method);
  assert.equal(live.latency.firstResult.p95, 120);
  assert.equal(external.latency.firstResult.p95, null);
});

test('mixed scoring handles adjacent Han characters and English words with lexical matching', () => {
  const result = score('我要两杯iced latte，不要糖。', '我要两杯 ICED LATTE，不要盐。', ['两杯 iced latte', '不要糖']);
  assert.equal(result.metric, 'MER');
  assert.equal(result.referenceTokens, 9);
  assert.equal(result.wer, null);
  assert.equal(result.mer, 1 / 9);
  assert.deepEqual(result.critical.map(item => item.matched), [true, false]);
  assert.equal(score('不要糖', '不要糖').mer, 0);
  assert.equal(score('iced latte', 'iced latte').metric, 'WER');
});

test('mixed and English error rates aggregate independently, including older saved WER runs', async () => {
  const { aggregate } = await import('../site/benchmark.js');
  const old = { wer: 0.25, critical: [] };
  const mixed = score('两杯 latte', '两杯 latte');
  const totals = aggregate([old, mixed].map(evaluation => ({ success: true, evaluation, latency: {} })));
  assert.equal(totals.wer.average, 0.25);
  assert.equal(totals.wer.count, 1);
  assert.equal(totals.mer.average, 0);
  assert.equal(totals.mer.count, 1);
});
