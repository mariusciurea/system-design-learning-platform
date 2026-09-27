import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dnsState, planJourney, type StageId } from './urlJourneyModel.ts';
import { DEFAULT_SETUP, FOCUS_SETUPS, drawnOutcomes, shownControls, startSetup, type Setup } from './urlJourneySetup.ts';

const TYPE_A_URL = FOCUS_SETUPS['what-happens-when-you-type-a-url'];

const skippedStages = (setup: Setup): StageId[] =>
  planJourney(setup)
    .filter((stage) => stage.skipped)
    .map((stage) => stage.id);

// ---- What Happens When You Type a URL: the beginner focus --------------------

test('typing a URL opens on a warm resolver: the browser asks it, root, TLD and authoritative are skipped', () => {
  const plans = planJourney(TYPE_A_URL);
  const byId = (id: StageId) => plans.find((stage) => stage.id === id);

  assert.equal(byId('dns-ask')?.skipped, null);
  assert.deepEqual(
    byId('dns-ask')?.hops.map((hop) => [hop.from, hop.to]),
    [
      ['browser', 'resolver'],
      ['resolver', 'browser'],
    ],
  );
  assert.deepEqual(skippedStages(TYPE_A_URL), ['dns-root', 'dns-tld', 'dns-auth']);
  for (const id of ['dns-root', 'dns-tld', 'dns-auth'] as const) {
    assert.equal(byId(id)?.skipped, 'The resolver had the answer cached');
  }
});

test('typing a URL opens on the whole journey over HTTPS with TLS 1.3 and a new connection', () => {
  assert.equal(TYPE_A_URL.scope, 'all');
  assert.equal(TYPE_A_URL.startStage, 'browser');
  assert.equal(TYPE_A_URL.https, true);
  assert.equal(TYPE_A_URL.tls, '1.3');
  assert.equal(TYPE_A_URL.warm, false);
});

test('typing a URL shows only the controls that reshape the journey', () => {
  assert.deepEqual(shownControls(TYPE_A_URL), ['scope', 'warm', 'cdn', 'cacheHit']);
});

test('typing a URL keeps TLS at 1.3 and the resolver warm whatever the learner toggles', () => {
  for (const change of [{ warm: true }, { cdn: false }, { cacheHit: true }, { scope: 'dns' as const }]) {
    const changed = { ...TYPE_A_URL, ...change };
    assert.deepEqual(shownControls(changed), ['scope', 'warm', 'cdn', 'cacheHit']);
    assert.equal(changed.tls, '1.3');
    assert.equal(dnsState(changed).answerCached, true);
  }
});

// ---- Every other start is what it was ---------------------------------------

test('/labs/url-journey keeps the full cold journey and every control', () => {
  assert.deepEqual(DEFAULT_SETUP, {
    scope: 'all',
    startStage: 'browser',
    https: true,
    tls: '1.3',
    warm: false,
    ttlS: 300,
    resolverCache: 'never',
    cdn: true,
    originRttMs: 80,
    cacheHit: false,
    controls: 'full',
  });
  assert.deepEqual(skippedStages(DEFAULT_SETUP), []);
  assert.deepEqual(shownControls(DEFAULT_SETUP), ['scope', 'warm', 'resolver', 'https', 'tls', 'cdn', 'originRtt', 'cacheHit']);
});

test('the DNS, HTTP / HTTPS and TLS / HTTPS focuses open exactly as before', () => {
  assert.deepEqual(FOCUS_SETUPS.dns, { ...DEFAULT_SETUP, scope: 'dns', startStage: 'dns-ask' });
  assert.deepEqual(FOCUS_SETUPS['http-https'], { ...DEFAULT_SETUP, scope: 'http', startStage: 'request', https: false });
  assert.deepEqual(FOCUS_SETUPS['tls-https'], { ...DEFAULT_SETUP, scope: 'connect', startStage: 'tls' });
});

test('the TLS version control shows only while HTTPS is on', () => {
  assert.equal(shownControls({ ...DEFAULT_SETUP, https: false }).includes('tls'), false);
  assert.equal(shownControls(FOCUS_SETUPS['http-https']).includes('tls'), false);
  assert.equal(shownControls(FOCUS_SETUPS['tls-https']).includes('tls'), true);
});

test('the Lab starts, and Reset returns, to the focus of its Concept, or to the default with none', () => {
  assert.equal(startSetup('what-happens-when-you-type-a-url'), TYPE_A_URL);
  assert.equal(startSetup('dns'), FOCUS_SETUPS.dns);
  assert.equal(startSetup(undefined), DEFAULT_SETUP);
});

// ---- The legend: only the shapes this setup draws ---------------------------

test('the legend of each start lists only the shapes it draws', () => {
  assert.deepEqual(drawnOutcomes(DEFAULT_SETUP), ['success']);
  assert.deepEqual(drawnOutcomes(TYPE_A_URL), ['success', 'cache-hit']);
  assert.deepEqual(drawnOutcomes(FOCUS_SETUPS.dns), ['success']);
  assert.deepEqual(drawnOutcomes(FOCUS_SETUPS['http-https']), ['success', 'warning']);
  assert.deepEqual(drawnOutcomes(FOCUS_SETUPS['tls-https']), ['success']);
});

test('the legend follows the controls', () => {
  // Plain HTTP puts triangles on the public hops.
  assert.deepEqual(drawnOutcomes({ ...DEFAULT_SETUP, https: false }), ['success', 'warning']);
  // A Redis hit comes back as a diamond.
  assert.deepEqual(drawnOutcomes({ ...DEFAULT_SETUP, cacheHit: true }), ['success', 'cache-hit']);
  // A cached resolver answer is a diamond too, but only while DNS is part of what plays.
  assert.deepEqual(drawnOutcomes({ ...TYPE_A_URL, scope: 'http' }), ['success']);
  // A reused connection skips DNS, so the resolver diamond goes with it.
  assert.deepEqual(drawnOutcomes({ ...TYPE_A_URL, warm: true }), ['success']);
  // Nothing plays at all: no DNS, no handshakes.
  assert.deepEqual(drawnOutcomes({ ...DEFAULT_SETUP, scope: 'dns', warm: true }), []);
  assert.deepEqual(drawnOutcomes({ ...DEFAULT_SETUP, scope: 'connect', warm: true }), []);
});
