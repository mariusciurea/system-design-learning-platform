/**
 * The starting setups of the Capacity Lab: one object for both views, the view included, so Reset
 * (which sets the focus start back) cannot miss a control. See "A Lab focus for a shared lab" in
 * CLAUDE.md. Imports only types and relative .ts files, so `npm test` runs it on Node.
 */

import type { LabFocus } from '../../types/index.ts';
import type { CapacityInputs } from './capacityModel.ts';
import type { SpeedInputs } from './latencyModel.ts';

/** Size estimates the fleet and the storage from product numbers; Speed follows one request. */
export type CapacityView = 'size' | 'speed';

export interface SizeSetup extends CapacityInputs {
  /** Napkin mode: big numbers become powers of ten, small factors keep one significant figure. */
  rounding: boolean;
}

/** Both views in one object, the view itself included, so Reset returns to the focus start. */
export interface CapacitySetup extends SizeSetup, SpeedInputs {
  view: CapacityView;
}

/** The Speed view starts on the Back-of-the-envelope Diagram: a user in Europe, the app in the US. */
export const SPEED_START: SpeedInputs = {
  region: 'other-continent',
  userCalls: 1,
  dbCalls: 1,
  ramHitRate: 0.9,
  missStorage: 'ssd',
  responseKb: 1,
};

/** What the lab opens on at /labs/capacity, with no Lab focus. */
export const DEFAULT_SETUP: CapacitySetup = {
  view: 'size',
  ...SPEED_START,
  dau: 10_000_000,
  requestsPerUser: 20,
  writeShare: 0.1,
  objectSizeKb: 2,
  peakFactor: 5,
  retentionYears: 5,
  replicationFactor: 3,
  rounding: false,
};

/**
 * Capacity estimation opens on the Size view, the full step-by-step estimate with exact arithmetic.
 * Back-of-the-envelope opens on the Speed view, the latencies of its Diagram; one click away, its
 * Size view is in napkin mode on inputs that are not round (12M users, 8 requests, 1.2 KB), so the
 * learner watches them become powers of ten and the rough answer land close to the exact one.
 */
export const FOCUS_SETUPS: Record<LabFocus<'capacity'>, CapacitySetup> = {
  'capacity-estimation': { ...DEFAULT_SETUP, view: 'size', rounding: false },
  'back-of-the-envelope': {
    ...DEFAULT_SETUP,
    view: 'speed',
    dau: 12_000_000,
    requestsPerUser: 8,
    objectSizeKb: 1.2,
    rounding: true,
  },
};

/** The setup the Lab opens on: the focus of its Concept, or the default at /labs/capacity. */
export const startOf = (focus: LabFocus<'capacity'> | undefined): CapacitySetup =>
  focus ? FOCUS_SETUPS[focus] : DEFAULT_SETUP;
