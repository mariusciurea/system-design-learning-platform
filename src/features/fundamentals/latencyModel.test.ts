import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DATACENTER_HOP_MS,
  RAM_READ_MS,
  SSD_READ_MS,
  USER_ROUND_TRIP_MS,
  averageReadMs,
  formatDuration,
  requestTime,
  type SpeedInputs,
} from './latencyModel.ts';

/** The Back-of-the-envelope Diagram: a user in Europe, the app in the US, one database call. */
const DIAGRAM: SpeedInputs = {
  region: 'other-continent',
  userCalls: 1,
  dbCalls: 1,
  ramHitRate: 0.9,
  missStorage: 'ssd',
  responseKb: 1,
};

const close = (actual: number, expected: number) =>
  assert.ok(Math.abs(actual - expected) < 1e-9 * Math.max(1, Math.abs(expected)), `${actual} is not ${expected}`);

const hop = (inputs: SpeedInputs, id: string) => {
  const found = requestTime(inputs).hops.find((candidate) => candidate.id === id);
  assert.ok(found, `expected a hop "${id}"`);
  return found;
};

test('the Speed view uses the numbers of the Diagram', () => {
  assert.equal(USER_ROUND_TRIP_MS['other-continent'], 150);
  assert.equal(DATACENTER_HOP_MS, 0.5);
  close(RAM_READ_MS, 100e-6);
  close(SSD_READ_MS, 0.1);
});

test('one request across an ocean is dominated by the ocean round trip', () => {
  const time = requestTime(DIAGRAM);
  assert.equal(time.dominant, 'user');
  assert.ok(time.totalMs >= 150 && time.totalMs < 152);
});

test('the ocean round trip costs 300x the datacenter hop', () => {
  assert.equal(hop(DIAGRAM, 'user').eachMs / hop(DIAGRAM, 'datacenter').eachMs, 300);
});

test('a user in the same region pays a much shorter round trip', () => {
  const near = hop({ ...DIAGRAM, region: 'same-region' }, 'user');
  assert.ok(near.totalMs < 150 / 10);
});

test('botec-1: 50 random reads in a row are 5 ms on SSD and 500 ms on spinning disk', () => {
  const allOnDisk = { ...DIAGRAM, dbCalls: 50, ramHitRate: 0 };
  close(hop({ ...allOnDisk, missStorage: 'ssd' }, 'storage').totalMs, 5);
  close(hop({ ...allOnDisk, missStorage: 'hdd' }, 'storage').totalMs, 500);
  assert.equal(requestTime({ ...allOnDisk, missStorage: 'hdd' }).dominant, 'storage');
});

test('botec-2: 30 calls in a row across the ocean take 4.5 s; one batched call takes 150 ms', () => {
  close(hop({ ...DIAGRAM, userCalls: 30 }, 'user').totalMs, 4_500);
  close(hop({ ...DIAGRAM, userCalls: 1 }, 'user').totalMs, 150);
});

test('botec-7: 500 MB over one 1 Gbit/s link takes 4 s, so a second of it needs four links', () => {
  close(hop({ ...DIAGRAM, responseKb: 500_000 }, 'transfer').eachMs, 4_000);
  assert.equal(requestTime({ ...DIAGRAM, responseKb: 500_000 }).dominant, 'transfer');
});

test('botec-8: with everything else fast, the ocean round trip is the floor', () => {
  const fastest = requestTime({ ...DIAGRAM, ramHitRate: 1, responseKb: 1 });
  assert.ok(fastest.totalMs >= 150);
  assert.equal(fastest.dominant, 'user');
});

test('botec-9: 200 queries in the same datacenter are 100 ms of hops', () => {
  const nPlusOne = { ...DIAGRAM, region: 'same-region' as const, dbCalls: 200, ramHitRate: 1 };
  close(hop(nPlusOne, 'datacenter').totalMs, 100);
  assert.equal(requestTime(nPlusOne).dominant, 'datacenter');
});

test('botec-10: at a 90% hit rate the misses dominate the average read', () => {
  close(hop(DIAGRAM, 'ram').totalMs, 0.9 * RAM_READ_MS);
  close(hop(DIAGRAM, 'storage').totalMs, 0.1 * SSD_READ_MS);
  close(averageReadMs(0.9, 'ssd'), 0.9 * RAM_READ_MS + 0.1 * SSD_READ_MS);
  // Raising the hit rate from 90% to 99% cuts the average almost tenfold.
  assert.ok(averageReadMs(0.9, 'ssd') / averageReadMs(0.99, 'ssd') > 9);
});

test('database work repeats for every call from the user', () => {
  const twice = { ...DIAGRAM, userCalls: 2, dbCalls: 3 };
  assert.equal(hop(twice, 'datacenter').count, 6);
  close(hop(twice, 'datacenter').totalMs, 3);
});

test('the total is the sum of the hops', () => {
  const time = requestTime({ ...DIAGRAM, userCalls: 3, dbCalls: 7, ramHitRate: 0.5, missStorage: 'hdd' });
  close(
    time.totalMs,
    time.hops.reduce((sum, each) => sum + each.totalMs, 0),
  );
});

test('durations read in the unit that fits', () => {
  assert.equal(formatDuration(100e-6), '100 ns');
  assert.equal(formatDuration(0.1), '100 us');
  assert.equal(formatDuration(0.0101), '10 us');
  assert.equal(formatDuration(0.5), '0.5 ms');
  assert.equal(formatDuration(150), '150 ms');
  assert.equal(formatDuration(4_500), '4.5 s');
  assert.equal(formatDuration(0), '0 ns');
});
