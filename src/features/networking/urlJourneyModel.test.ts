import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CACHES_BEFORE_DNS,
  MACHINE_CACHES,
  dnsAnswer,
  frontOf,
  planJourney,
  type JourneySetup,
  type StageId,
} from './urlJourneyModel.ts';
import { DEFAULT_SETUP, FOCUS_SETUPS } from './urlJourneySetup.ts';
import { gettingStartedDepth } from '../../data/concepts/deep/getting-started.ts';

const stage = (setup: JourneySetup, id: StageId) => planJourney(setup).find((plan) => plan.id === id);
const noCdn = { ...DEFAULT_SETUP, cdn: false };

// ---- With a CDN, DNS leads the browser to the edge ---------------------------

test('with the CDN on, the authoritative answer is an ALIAS to the CDN that leads to the edge', () => {
  const answer = dnsAnswer(DEFAULT_SETUP);
  assert.equal(answer.record, 'ALIAS');
  assert.equal(answer.leadsTo, 'edge');
  assert.equal(answer.authSubtitle, 'ALIAS to CDN, TTL 5 min');
  assert.equal(stage(DEFAULT_SETUP, 'dns-auth')?.short, 'ALIAS to the CDN: CDN edge IP, TTL 5 min');
});

test('with the CDN off, the authoritative answer is an A record of the origin', () => {
  const answer = dnsAnswer(noCdn);
  assert.equal(answer.record, 'A');
  assert.equal(answer.leadsTo, 'lb');
  assert.equal(answer.authSubtitle, 'A record, TTL 5 min');
  assert.equal(stage(noCdn, 'dns-auth')?.short, 'A record: origin IP, TTL 5 min');
});

test('the DNS answer always leads to the part the browser then connects to', () => {
  for (const setup of [DEFAULT_SETUP, noCdn, ...Object.values(FOCUS_SETUPS)]) {
    assert.equal(dnsAnswer(setup).leadsTo, frontOf(setup));
  }
});

test('the authoritative subtitle follows the TTL', () => {
  assert.equal(dnsAnswer({ ...DEFAULT_SETUP, ttlS: 86400 }).authSubtitle, 'ALIAS to CDN, TTL 1 day');
  assert.equal(dnsAnswer({ ...noCdn, ttlS: 60 }).authSubtitle, 'A record, TTL 1 min');
});

test('a warm resolver answers from its cache with the edge address, as on the beginner focus', () => {
  const beginner = FOCUS_SETUPS['what-happens-when-you-type-a-url'];
  assert.equal(stage(beginner, 'dns-ask')?.short, 'cached answer: the CDN edge IP');
  assert.equal(stage({ ...beginner, cdn: false }, 'dns-ask')?.short, 'cached answer: the origin IP');
  // A cold resolver has no answer yet: it has to walk the hierarchy.
  assert.equal(stage(DEFAULT_SETUP, 'dns-ask')?.short, 'resolver cache miss');
});

// ---- The five caches, in the order the browser checks them -------------------

test('the service worker sees the request before the HTTP cache, and the resolver cache comes fifth', () => {
  assert.deepEqual(MACHINE_CACHES, ['service worker', 'HTTP cache', 'browser DNS cache', 'operating system DNS cache']);
  assert.deepEqual(CACHES_BEFORE_DNS, [...MACHINE_CACHES, 'resolver cache']);
  assert.equal(stage(DEFAULT_SETUP, 'browser')?.short, 'URL parsed, 4 caches on the machine miss');
  // A reused connection needs no address, so only the first two are asked.
  assert.equal(stage({ ...DEFAULT_SETUP, warm: true }, 'browser')?.short, 'URL parsed, service worker and HTTP cache miss');
});

test('the Lesson names the same five caches in the same order', () => {
  const lesson = gettingStartedDepth['what-happens-when-you-type-a-url'];
  const stage1 = lesson.deepDive[0];
  assert.match(stage1.heading, /five caches/);
  const text = stage1.paragraphs.join(' ');
  let from = 0;
  for (const cache of CACHES_BEFORE_DNS) {
    const at = text.indexOf(cache, from);
    assert.ok(at >= 0, `the Lesson names "${cache}" after the caches before it`);
    from = at + cache.length;
  }
});

test('the Lesson mentions HTTP/3 over QUIC', () => {
  const lesson = gettingStartedDepth['what-happens-when-you-type-a-url'];
  const text = lesson.deepDive.flatMap((section) => section.paragraphs).join(' ');
  assert.match(text, /HTTP\/3/);
  assert.match(text, /QUIC/);
});
