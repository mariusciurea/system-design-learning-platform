/**
 * The latency arithmetic behind the Speed view of the Capacity Lab: how long one request takes,
 * hop by hop, and which hop dominates.
 *
 * Simplified model, not a measurement. Every constant is the standard order of magnitude people
 * memorise (the same ones the Back-of-the-envelope Diagram shows); real numbers drift with hardware,
 * distance and load. Calls run one after another, never in parallel, there is no queueing, and a
 * response crosses one 1 Gbit/s link at full speed.
 *
 * Imports nothing, so `npm test` runs it on Node as it is.
 */

export type UserRegion = 'same-region' | 'other-continent';
/** Where a read that is not in RAM goes. */
export type MissStorage = 'ssd' | 'hdd';

export interface SpeedInputs {
  /** Where the user is, relative to the datacenter that runs the app. */
  region: UserRegion;
  /** Calls the user makes to the app, one after another. */
  userCalls: number;
  /** Database calls the app makes for each of those, one after another. */
  dbCalls: number;
  /** Share of database reads answered from RAM, 0..1. The rest go to `missStorage`. */
  ramHitRate: number;
  missStorage: MissStorage;
  /** Size of one response to the user, in KB (1 KB = 1,000 bytes). */
  responseKb: number;
}

/** A round trip between the user and the app: ~10 ms nearby, ~150 ms across an ocean. */
export const USER_ROUND_TRIP_MS: Record<UserRegion, number> = {
  'same-region': 10,
  'other-continent': 150,
};
/** A round trip between two machines in the same datacenter: ~0.5 ms. */
export const DATACENTER_HOP_MS = 0.5;
/** A main memory reference: ~100 ns. */
export const RAM_READ_MS = 100e-6;
/** An SSD random read: ~100 us. */
export const SSD_READ_MS = 0.1;
/** A spinning-disk seek: ~10 ms. */
export const HDD_SEEK_MS = 10;
export const STORAGE_READ_MS: Record<MissStorage, number> = { ssd: SSD_READ_MS, hdd: HDD_SEEK_MS };
/** 1 Gbit/s is 125 MB/s: 125,000 bytes every millisecond. */
export const LINK_BYTES_PER_MS = 1e9 / 8 / 1_000;

export type HopId = 'user' | 'transfer' | 'datacenter' | 'ram' | 'storage';

export interface Hop {
  id: HopId;
  label: string;
  /** How many times one request pays it - fractional for reads split by the hit rate. */
  count: number;
  eachMs: number;
  totalMs: number;
}

export interface RequestTime {
  hops: Hop[];
  totalMs: number;
  /** The hop that costs the most in total. */
  dominant: HopId;
}

/** The time of one request from the user, split into the hops it pays. */
export function requestTime(inputs: SpeedInputs): RequestTime {
  const { region, userCalls, dbCalls, ramHitRate, missStorage, responseKb } = inputs;
  const queries = userCalls * dbCalls;
  const hop = (id: HopId, label: string, count: number, eachMs: number): Hop => ({
    id,
    label,
    count,
    eachMs,
    totalMs: count * eachMs,
  });
  const hops = [
    hop('user', region === 'other-continent' ? 'Ocean round trip' : 'Round trip to the user', userCalls, USER_ROUND_TRIP_MS[region]),
    hop('transfer', 'Response over 1 Gbit/s', userCalls, (responseKb * 1_000) / LINK_BYTES_PER_MS),
    hop('datacenter', 'Datacenter hop', queries, DATACENTER_HOP_MS),
    hop('ram', 'RAM read', queries * ramHitRate, RAM_READ_MS),
    hop('storage', missStorage === 'ssd' ? 'SSD read' : 'Disk seek', queries * (1 - ramHitRate), STORAGE_READ_MS[missStorage]),
  ];
  const dominant = hops.reduce((most, each) => (each.totalMs > most.totalMs ? each : most)).id;
  return { hops, totalMs: hops.reduce((sum, each) => sum + each.totalMs, 0), dominant };
}

/** The average time of one database read at this hit rate: hits from RAM, misses from storage. */
export const averageReadMs = (ramHitRate: number, missStorage: MissStorage) =>
  ramHitRate * RAM_READ_MS + (1 - ramHitRate) * STORAGE_READ_MS[missStorage];

const grouped = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

/** Two significant figures below 10, whole numbers above. */
const figure = (value: number) => (value >= 10 ? grouped.format(value) : `${Number(value.toPrecision(2))}`);

/** A duration in milliseconds in the unit that reads best: "100 ns", "100 us", "0.5 ms", "150 ms", "4.5 s". */
export function formatDuration(ms: number) {
  if (ms <= 0) return '0 ns';
  if (ms < 0.001) return `${figure(ms * 1e6)} ns`;
  if (ms < 0.5) return `${figure(ms * 1_000)} us`;
  if (ms < 1_000) return `${figure(ms)} ms`;
  return `${figure(ms / 1_000)} s`;
}
