import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETUP, FOCUS_SETUPS, startOf } from './capacitySetup.ts';

test('Back-of-the-envelope opens the Lab on the Speed view', () => {
  assert.equal(startOf('back-of-the-envelope').view, 'speed');
});

test('Capacity Estimation and /labs/capacity open on the Size view', () => {
  assert.equal(startOf('capacity-estimation').view, 'size');
  assert.equal(startOf(undefined), DEFAULT_SETUP);
  assert.equal(DEFAULT_SETUP.view, 'size');
});

test('the Speed view starts on the Back-of-the-envelope Diagram: a user in Europe, one call, RAM or SSD', () => {
  const speed = FOCUS_SETUPS['back-of-the-envelope'];
  assert.equal(speed.region, 'other-continent');
  assert.equal(speed.userCalls, 1);
  assert.equal(speed.dbCalls, 1);
  assert.equal(speed.missStorage, 'ssd');
  assert.ok(speed.ramHitRate > 0 && speed.ramHitRate < 1);
});

test('Back-of-the-envelope keeps its napkin Size setup one click away', () => {
  const speed = FOCUS_SETUPS['back-of-the-envelope'];
  assert.equal(speed.rounding, true);
  assert.deepEqual([speed.dau, speed.requestsPerUser, speed.objectSizeKb], [12_000_000, 8, 1.2]);
});

test('the two focuses do not start almost the same', () => {
  const a = FOCUS_SETUPS['capacity-estimation'];
  const b = FOCUS_SETUPS['back-of-the-envelope'];
  assert.notEqual(a.view, b.view);
  assert.notEqual(a.rounding, b.rounding);
});
