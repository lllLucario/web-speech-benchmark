import test from 'node:test';
import assert from 'node:assert/strict';
import { align, collectResults, csv, json, score, stats, timings, transcripts } from '../site/benchmark.js';
import { builtInCases, parseDataset } from '../site/dataset.js';

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

test('dataset includes 30 unique prompts across ten categories', () => {
  const entries = parseDataset({ cases: builtInCases });
  assert.equal(entries.length, 30);
  assert.equal(new Set(entries.map(entry => entry.category)).size, 10);
  assert.throws(() => parseDataset([entries[0], entries[0]]), /Duplicate/u);
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
