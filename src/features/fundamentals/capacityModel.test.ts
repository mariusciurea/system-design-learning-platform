import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  capacitySteps,
  exactEstimate,
  formatBandwidth,
  formatGigabitsPerSec,
  formatMegabytesPerSec,
  roughEstimate,
  sameDecision,
  serversFor,
  toOneFigure,
  writeDecisionOf,
  type CapacityInputs,
} from './capacityModel.ts';

/** The /labs/capacity default: 10M users, 20 requests, 10% writes, 2 KB, 5x peak. */
const DEFAULT: CapacityInputs = {
  dau: 10_000_000,
  requestsPerUser: 20,
  writeShare: 0.1,
  objectSizeKb: 2,
  peakFactor: 5,
  retentionYears: 5,
  replicationFactor: 3,
};

const step = (input: CapacityInputs, rounding: boolean, id: string) => {
  const found = capacitySteps(input, rounding).find((candidate) => candidate.id === id);
  assert.ok(found, `expected a step "${id}"`);
  return found;
};

test('one significant figure rounds halves up, despite floating point', () => {
  assert.equal(toOneFigure(0.15), 0.2);
  assert.equal(toOneFigure(0.35), 0.4);
  assert.equal(toOneFigure(0.25), 0.3);
  assert.equal(toOneFigure(0.45), 0.5);
});

test('one significant figure keeps its other answers', () => {
  assert.equal(toOneFigure(11_574), 10_000);
  assert.equal(toOneFigure(365), 400);
  assert.equal(toOneFigure(0.1), 0.1);
  assert.equal(toOneFigure(0.3), 0.3);
  assert.equal(toOneFigure(1), 1);
  assert.equal(toOneFigure(1_000), 1_000);
  assert.equal(toOneFigure(95), 100);
  assert.equal(toOneFigure(0), 0);
});

test('a 15% write share stays 20% on the napkin, not 10%', () => {
  assert.equal(roughEstimate({ ...DEFAULT, writeShare: 0.15 }).used.writeShare, 0.2);
});

test('the write decision follows the planning limit of one primary', () => {
  assert.equal(writeDecisionOf(9_999), 'one-primary');
  assert.equal(writeDecisionOf(10_000), 'one-primary');
  assert.equal(writeDecisionOf(11_574), 'partition');
});

test('rough and exact make the same decision on the default setup', () => {
  assert.equal(sameDecision(roughEstimate(DEFAULT), exactEstimate(DEFAULT)), true);
});

test('a different database decision is not the same decision, even in one scale category', () => {
  const allWrites = { ...DEFAULT, writeShare: 1 };
  const exact = exactEstimate(allWrites);
  const rough = roughEstimate(allWrites);
  // Both peaks sit in the fleet category, so comparing peak QPS alone would say "same".
  assert.ok(exact.peakQps > 1_000 && exact.peakQps <= 50_000);
  assert.ok(rough.peakQps > 1_000 && rough.peakQps <= 50_000);
  assert.equal(writeDecisionOf(exact.peakWriteQps), 'partition');
  assert.equal(writeDecisionOf(rough.peakWriteQps), 'one-primary');
  assert.equal(sameDecision(rough, exact), false);
});

test('servers at peak and servers with headroom are two numbers', () => {
  assert.deepEqual(serversFor(7_200), { serversAtPeak: 8, servers: 12 });
});

test('the servers steps show the servers at peak, then the servers with headroom', () => {
  // 12,441,600 x 10 / 86,400 x 5 = 7,200 peak requests/sec.
  const input = { ...DEFAULT, dau: 12_441_600, requestsPerUser: 10 };
  const atPeak = step(input, false, 'servers-at-peak');
  const withHeadroom = step(input, false, 'servers-with-headroom');
  assert.equal(atPeak.value, 8);
  assert.match(atPeak.formula, /7,200/);
  assert.equal(withHeadroom.value, 12);
  assert.match(withHeadroom.formula, /^8 servers x 1\.5/);
  assert.match(withHeadroom.result, /^12 servers/);
});

test('a Peak writes step produces the number the database card shows', () => {
  for (const rounding of [false, true]) {
    const estimate = rounding ? roughEstimate(DEFAULT) : exactEstimate(DEFAULT);
    const peakWrites = step(DEFAULT, rounding, 'peak-writes');
    assert.equal(peakWrites.value, estimate.peakWriteQps);
    assert.equal(peakWrites.part, 'Database');
  }
  assert.match(step(DEFAULT, false, 'peak-writes').result, /1,157 writes\/sec/);
});

test('bandwidth reads in megabytes and in gigabits per second', () => {
  // 5,000 req/sec x 1 MB: the bits-versus-bytes trap of the Quiz.
  assert.equal(formatMegabytesPerSec(5e9), '5,000 MB/s');
  assert.equal(formatGigabitsPerSec(5e9), '40 Gbit/s');
  assert.equal(formatMegabytesPerSec(500e6), '500 MB/s');
  assert.equal(formatGigabitsPerSec(500e6), '4 Gbit/s');
  // The default setup: 11,574 req/sec x 2 KB = 23 MB/s, under a fifth of a gigabit.
  assert.equal(formatMegabytesPerSec(23_148_148), '23 MB/s');
  assert.equal(formatGigabitsPerSec(23_148_148), '0.19 Gbit/s');
  assert.equal(formatBandwidth(5e9), '5,000 MB/s = 40 Gbit/s');
  assert.equal(formatGigabitsPerSec(1), '< 0.01 Gbit/s');
});

test('the bandwidth step shows both units', () => {
  const bandwidth = step(DEFAULT, false, 'peak-bandwidth');
  assert.match(bandwidth.result, /MB\/s/);
  assert.match(bandwidth.result, /Gbit\/s/);
});
