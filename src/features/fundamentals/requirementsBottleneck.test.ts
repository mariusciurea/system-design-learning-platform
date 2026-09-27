import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FOCUS_SETUPS, LOOP_DAU, RELAXED, architecture, coreOf, routesFor, type Setup } from './requirementsArchitecture.ts';
import { formatCost, relativeCost } from './requirementsCost.ts';
import {
  FIXES,
  applyFix,
  bottleneckStat,
  findBottleneck,
  fixesFor,
  loopState,
  overloadedRoutes,
  raiseUsers,
  tradeOffsOf,
} from './requirementsBottleneck.ts';

const START = FOCUS_SETUPS['what-is-system-design'];
const TOP = LOOP_DAU.length - 1;

/**
 * Every state the loop can reach from the focus start: at each step either one fix is picked (every
 * offered one, one branch each) or, with nothing over its limit, users are raised.
 */
function walkAll(visit: (setup: Setup, path: string[]) => void) {
  const walk = (setup: Setup, path: string[]) => {
    visit(setup, path);
    const bottleneck = findBottleneck(setup);
    if (bottleneck) {
      for (const fix of fixesFor(setup)) walk(applyFix(setup, fix.id), [...path, fix.id]);
    } else if ((setup.loop?.users ?? TOP) < TOP) {
      walk(raiseUsers(setup), [...path, 'raise']);
    }
  };
  walk(START, []);
}

// ---------------------------------------------------------------------------
// The focus start
// ---------------------------------------------------------------------------

test('the focus opens on Instagram, its core features, the relaxed targets and the loop panel', () => {
  assert.equal(START.product, 'instagram');
  assert.deepEqual(START.selected, coreOf('instagram'));
  assert.deepEqual(START.nfr, RELAXED);
  assert.equal(START.panel, 'load');
  assert.deepEqual(START.loop, { users: 0, fixes: [] });
});

test('the focus opens on the simplest design with no part over its limit', () => {
  const arch = architecture(START);

  assert.equal(findBottleneck(START), null);
  assert.equal(arch.parts.api?.title, 'App server');
  assert.equal(arch.parts.db?.title, 'Database');
  assert.equal(arch.parts.lb, undefined);
  assert.equal(arch.parts.cache, undefined);
  assert.equal(formatCost(relativeCost(START)), 'x1');
  assert.equal(loopState(START).done, false);
});

test('only the What is System Design focus runs the loop', () => {
  for (const [focus, setup] of Object.entries(FOCUS_SETUPS)) {
    if (focus === 'what-is-system-design') continue;
    assert.equal(setup.loop, undefined, focus);
    assert.equal(findBottleneck(setup), null, focus);
  }
});

// ---------------------------------------------------------------------------
// The rounds
// ---------------------------------------------------------------------------

test('each users step turns one part red, on every path through the loop', () => {
  let raises = 0;
  walkAll((setup, path) => {
    if (path[path.length - 1] !== 'raise') return;
    raises += 1;
    assert.ok(findBottleneck(setup), `nothing red after ${path.join(' > ')}`);
  });
  assert.ok(raises >= 3);
});

test('the canonical path: the App server first, then the Database reads, then the Database writes', () => {
  const first = raiseUsers(START);
  assert.equal(findBottleneck(first)?.id, 'app');
  assert.equal(findBottleneck(first)?.part, 'api');

  const second = raiseUsers(applyFix(first, 'scale-out'));
  assert.equal(findBottleneck(second)?.id, 'db-reads');
  assert.equal(findBottleneck(second)?.part, 'db');

  const third = raiseUsers(applyFix(second, 'replicas'));
  assert.equal(findBottleneck(third)?.id, 'db-writes');
  assert.equal(findBottleneck(third)?.part, 'db');

  const done = applyFix(third, 'partition');
  assert.equal(findBottleneck(done), null);
  assert.equal(loopState(done).done, true);
});

test('a bottleneck names a load above its limit, from the shared sizing model', () => {
  walkAll((setup) => {
    const bottleneck = findBottleneck(setup);
    if (bottleneck) assert.ok(bottleneck.load > bottleneck.limit, JSON.stringify(bottleneck));
  });
});

test('each bottleneck offers 2-3 fixes, each clears it, and each costs a different amount', () => {
  let bottlenecks = 0;
  walkAll((setup, path) => {
    const bottleneck = findBottleneck(setup);
    if (!bottleneck) return;
    bottlenecks += 1;
    const fixes = fixesFor(setup);
    const where = `${bottleneck.id} after ${path.join(' > ') || 'start'}`;

    assert.ok(fixes.length >= 2 && fixes.length <= 3, `${fixes.length} fixes for ${where}`);
    // What each fix adds to the monthly cost is what the Lab shows beside it.
    const costs = fixes.map((fix) => formatCost(fix.added));
    assert.equal(new Set(costs).size, costs.length, `${costs.join(', ')} for ${where}`);
    for (const fix of fixes) {
      assert.ok(fix.tradeOff.length > 0, `${fix.id} names no trade-off`);
      assert.equal(fix.cost, relativeCost(applyFix(setup, fix.id)), `${fix.id} for ${where}`);
      assert.equal(fix.added, fix.cost - relativeCost(setup));
      assert.notEqual(findBottleneck(applyFix(setup, fix.id))?.id, bottleneck.id, `${fix.id} does not clear ${where}`);
    }
  });
  assert.ok(bottlenecks >= 3);
});

test('every fix adds to the monthly cost', () => {
  walkAll((setup) => {
    for (const fix of fixesFor(setup)) assert.ok(fix.added > 0, `${fix.id} at ${JSON.stringify(setup.loop)}`);
  });
});

test('the loop runs 3 rounds, then says the design meets the target', () => {
  let ends = 0;
  walkAll((setup, path) => {
    const state = loopState(setup);
    assert.ok(state.round <= 3, path.join(' > '));
    if (findBottleneck(setup) || setup.loop?.users !== TOP) {
      assert.equal(state.done, false);
      return;
    }
    ends += 1;
    assert.equal(state.round, 3);
    assert.equal(state.done, true, path.join(' > '));
    assert.deepEqual(raiseUsers(setup), setup, 'there is no fourth round');
  });
  assert.ok(ends >= 4);
});

test('users cannot be raised while a part is over its limit', () => {
  const red = raiseUsers(START);
  assert.deepEqual(raiseUsers(red), red);
  assert.equal(loopState(red).canRaise, false);
  assert.equal(loopState(START).canRaise, true);
});

test('a bigger machine buys one step: the App server turns red again at the next one', () => {
  const bigger = applyFix(raiseUsers(START), 'bigger-app');
  assert.equal(findBottleneck(bigger), null);

  const next = raiseUsers(bigger);
  assert.equal(findBottleneck(next)?.id, 'app');
  assert.ok(!fixesFor(next).some((fix) => fix.id === 'bigger-app'), 'already the largest machine');
});

test('a fix is not offered twice', () => {
  walkAll((setup) => {
    for (const fix of fixesFor(setup)) assert.ok(!setup.loop?.fixes.includes(fix.id), fix.id);
  });
});

// ---------------------------------------------------------------------------
// What the fixes draw
// ---------------------------------------------------------------------------

test('each fix draws the component it adds', () => {
  const first = raiseUsers(START);
  assert.equal(architecture(applyFix(first, 'scale-out')).parts.lb?.title, 'Load balancer x2');
  assert.equal(architecture(applyFix(first, 'scale-out')).parts.api?.title, 'App servers x3');
  assert.equal(architecture(applyFix(first, 'bigger-app')).parts.api?.title, 'App server');
  assert.equal(architecture(applyFix(first, 'bigger-app')).machineSize.api, FIXES['bigger-app'].size);

  const second = raiseUsers(applyFix(first, 'scale-out'));
  assert.equal(architecture(applyFix(second, 'cache')).parts.cache?.title, 'Cache');
  assert.match(architecture(applyFix(second, 'replicas')).parts.db?.title ?? '', /^Database x\d+$/);
  assert.match(architecture(raiseUsers(applyFix(second, 'replicas'))).parts.db?.title ?? '', /^Database x\d+$/);
  const partitioned = applyFix(raiseUsers(applyFix(second, 'replicas')), 'partition');
  assert.match(architecture(partitioned).parts.db?.title ?? '', /^DB: \d+ partitions/);
});

test('switching to a pool of servers replaces the bigger machine', () => {
  const next = raiseUsers(applyFix(raiseUsers(START), 'bigger-app'));
  const pooled = applyFix(next, 'scale-out');

  assert.deepEqual(pooled.loop?.fixes, ['scale-out']);
  assert.equal(architecture(pooled).machineSize.api, undefined);
});

test('requests past the limit of the red part fail there; the rest go through', () => {
  const red = raiseUsers(START);
  const bottleneck = findBottleneck(red);
  assert.ok(bottleneck);
  const arch = architecture(red);
  const variants = overloadedRoutes('read', routesFor('read', arch), bottleneck);
  const failed = variants.filter((variant) => variant.outcome === 'failure');
  const share = failed.reduce((sum, variant) => sum + variant.weight, 0) / variants.reduce((sum, variant) => sum + variant.weight, 0);

  assert.ok(failed.length > 0);
  assert.ok(failed.every((variant) => variant.route[variant.route.length - 1] === 'api'), 'they stop at the App server');
  assert.ok(Math.abs(share - (1 - bottleneck.limit / bottleneck.load)) < 1e-9);
});

test('the red part shows its peak load against its limit', () => {
  const red = raiseUsers(START);
  const bottleneck = findBottleneck(red);
  assert.ok(bottleneck);
  assert.deepEqual(bottleneckStat(bottleneck), { label: 'Peak load', value: '~1.7K of 1K req/s' });

  const reads = findBottleneck(raiseUsers(applyFix(red, 'scale-out')));
  assert.ok(reads);
  assert.deepEqual(bottleneckStat(reads), { label: 'Peak reads', value: '~16.5K of 10K/s' });
});

test('only the traffic of the red limit fails: writes pass a Database red for reads', () => {
  const reads = raiseUsers(applyFix(raiseUsers(START), 'scale-out'));
  const bottleneck = findBottleneck(reads);
  assert.equal(bottleneck?.id, 'db-reads');
  if (!bottleneck) return;
  const arch = architecture(reads);

  assert.ok(overloadedRoutes('read', routesFor('read', arch), bottleneck).some((variant) => variant.outcome === 'failure'));
  assert.ok(!overloadedRoutes('write', routesFor('write', arch), bottleneck).some((variant) => variant.outcome === 'failure'));
});

// ---------------------------------------------------------------------------
// Naming the cost, and Reset
// ---------------------------------------------------------------------------

test('each fix picked names its trade-off, in the order picked', () => {
  const picked = applyFix(raiseUsers(applyFix(raiseUsers(START), 'scale-out')), 'cache');

  assert.deepEqual(
    tradeOffsOf(picked).map((line) => line.fix),
    ['scale-out', 'cache'],
  );
  assert.match(tradeOffsOf(picked)[1].text, /stale/i);
});

test('the fixes live in the setup, so returning to the focus start clears them', () => {
  const played = applyFix(raiseUsers(applyFix(raiseUsers(START), 'autoscale')), 'bigger-db');

  assert.deepEqual(played.loop?.fixes, ['autoscale', 'bigger-db']);
  assert.deepEqual(FOCUS_SETUPS['what-is-system-design'], START, 'the start is never changed in place');
  assert.deepEqual(START.loop, { users: 0, fixes: [] });
});
