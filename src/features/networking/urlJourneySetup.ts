import type { LabFocus, RequestOutcome } from '../../types/index.ts';
import { inScope, planJourney, type JourneySetup, type Scope, type StagePlan } from './urlJourneyModel.ts';

/**
 * Where the URL journey Lab starts on each Concept, which controls it shows,
 * and which particle shapes its legend lists. Pure, so `npm test` runs it:
 * it imports only types and relative `.ts` files.
 */

/** One control, or group of controls, in the side column of the Lab. */
export type ControlId = 'scope' | 'warm' | 'resolver' | 'https' | 'tls' | 'cdn' | 'originRtt' | 'cacheHit';

/**
 * `full`: every control. `journey`: only the ones that change which parts the
 * request walks - for the beginner who meets this Lab first, with the resolver
 * cache, the TLS version and the origin distance left as they start.
 */
export type ControlSet = 'full' | 'journey';

export interface Setup extends JourneySetup {
  /** The learner never changes this; it comes from the Lab focus. */
  controls: ControlSet;
}

const CONTROLS: Record<ControlSet, ControlId[]> = {
  full: ['scope', 'warm', 'resolver', 'https', 'tls', 'cdn', 'originRtt', 'cacheHit'],
  journey: ['scope', 'warm', 'cdn', 'cacheHit'],
};

/** The controls to show, in order. The TLS version has nothing to set on plain HTTP. */
export const shownControls = (setup: Setup): ControlId[] =>
  CONTROLS[setup.controls].filter((id) => id !== 'tls' || setup.https);

/** What the lab opens on at /labs/url-journey, with no Lab focus: the whole cold journey. */
export const DEFAULT_SETUP: Setup = {
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
};

/**
 * The Lab focus of each Concept that hosts this lab, each looping the part of
 * the journey it teaches.
 *
 * What Happens When You Type a URL is the first Lab many learners meet, so it
 * starts the way a real lookup usually goes: a busy resolver looked example.com
 * up 30 s ago (TTL 5 min), so the browser still asks it but root, TLD and
 * authoritative are skipped - the two DNS steps of its Diagram. TLS stays 1.3
 * and only the controls that reshape the journey show.
 *
 * DNS, HTTP / HTTPS and TLS / HTTPS start cold so every stage of their part
 * happens. HTTP / HTTPS opens on plain HTTP, so one toggle shows what HTTPS
 * adds and costs.
 */
export const FOCUS_SETUPS: Record<LabFocus<'url-journey'>, Setup> = {
  'what-happens-when-you-type-a-url': { ...DEFAULT_SETUP, resolverCache: '30s', controls: 'journey' },
  dns: { ...DEFAULT_SETUP, scope: 'dns', startStage: 'dns-ask' },
  'http-https': { ...DEFAULT_SETUP, scope: 'http', startStage: 'request', https: false },
  'tls-https': { ...DEFAULT_SETUP, scope: 'connect', startStage: 'tls' },
};

/** Where the Lab starts, and where Reset takes it back to. */
export const startSetup = (focus: LabFocus<'url-journey'> | undefined): Setup =>
  focus ? FOCUS_SETUPS[focus] : DEFAULT_SETUP;

/** The stages the request walks in a loop: in the chosen scope, and not skipped. */
export const playedStages = (plans: StagePlan[], scope: Scope): StagePlan[] =>
  plans.filter((stage) => inScope(stage, scope) && !stage.skipped);

const LEGEND_ORDER: RequestOutcome[] = ['success', 'cache-hit', 'warning', 'failure'];

/** The particle outcomes this setup draws, in legend order - the legend lists these and no others. */
export function drawnOutcomes(setup: JourneySetup, plans: StagePlan[] = planJourney(setup)): RequestOutcome[] {
  const drawn = new Set(playedStages(plans, setup.scope).flatMap((stage) => stage.hops.map((hop) => hop.outcome)));
  return LEGEND_ORDER.filter((outcome) => drawn.has(outcome));
}
