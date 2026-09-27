/**
 * The arithmetic behind the Capacity Lab, kept out of the component so the exact and the rough
 * estimate are the same steps with different rounding.
 *
 * Every constant here is a planning assumption, not a measurement: 1,000 requests/sec per app
 * server, 50% headroom and 10,000 writes/sec for one database primary are the round numbers people
 * use on a whiteboard. Real limits depend on the hardware, the code and the queries. Sizes are
 * decimal (1 KB = 1,000 bytes), the convention for napkin math; using 1,024 changes no decision.
 *
 * Imports only relative .ts files, so `npm test` runs it on Node as it is.
 */

import { formatCompact, formatNumber } from '../../utils/format.ts';

export interface CapacityInputs {
  dau: number;
  requestsPerUser: number;
  /** Share of requests that are writes, 0..1. */
  writeShare: number;
  objectSizeKb: number;
  peakFactor: number;
  retentionYears: number;
  replicationFactor: number;
}

/** Simplified planning assumption: requests/sec one app server handles when each request does real work. */
export const SERVER_CAPACITY = 1_000;
/** Provision 50% above the peak, so a spike or a lost server is not an outage. */
export const HEADROOM = 1.5;
/** Simplified planning assumption: writes/sec one database primary absorbs before writes must be partitioned. */
export const PRIMARY_WRITE_LIMIT = 10_000;
/** Share of one day of new objects kept in cache (the 80/20 rule of thumb). */
export const HOT_SHARE = 0.2;

export const SECONDS_PER_DAY = 86_400;
export const DAYS_PER_YEAR = 365;

/** The numbers an estimate actually multiplied - rounded ones in rough mode. */
export interface UsedInputs {
  dau: number;
  requestsPerUser: number;
  secondsPerDay: number;
  peakFactor: number;
  writeShare: number;
  objectBytes: number;
  daysPerYear: number;
  retentionYears: number;
  replicationFactor: number;
}

export interface Estimate {
  used: UsedInputs;
  requestsPerDay: number;
  avgQps: number;
  peakQps: number;
  writesPerDay: number;
  writeQps: number;
  peakWriteQps: number;
  peakReadQps: number;
  dailyBytes: number;
  yearlyBytes: number;
  retainedBytes: number;
  storedBytes: number;
  bandwidthBytesPerSec: number;
  cacheBytes: number;
  serversAtPeak: number;
  servers: number;
}

/** The nearest power of ten, measured on a log scale (so 3 rounds to 1 and 4 rounds to 10). */
export const toPowerOfTen = (value: number) => (value <= 0 ? 0 : 10 ** Math.round(Math.log10(value)));

/** One significant figure, halves rounded up: 11,574 -> 10,000; 0.15 -> 0.2; 0.35 -> 0.4; 365 -> 400. */
export function toOneFigure(value: number) {
  if (value <= 0) return 0;
  let exponent = Math.floor(Math.log10(value));
  // log10 of an exact power of ten can land just below the integer.
  if (10 ** (exponent + 1) <= value) exponent += 1;
  const scale = 10 ** exponent;
  // In floating point 0.15 / 0.1 is 1.4999999999999998, which would round down. Twelve significant
  // figures turn it back into the 1.5 it stands for, so the half rounds up as on paper.
  const mantissa = Number((value / scale).toPrecision(12));
  // Clean floating-point noise such as 0.30000000000000004.
  return Number((Math.round(mantissa) * scale).toPrecision(1));
}

/** Servers the peak needs at SERVER_CAPACITY each, then the same with HEADROOM, both rounded up. */
export function serversFor(peakQps: number) {
  const serversAtPeak = Math.max(1, Math.ceil(peakQps / SERVER_CAPACITY));
  return { serversAtPeak, servers: Math.ceil(serversAtPeak * HEADROOM) };
}

/** Every step with the inputs as given. */
export function exactEstimate(input: CapacityInputs): Estimate {
  const used: UsedInputs = {
    dau: input.dau,
    requestsPerUser: input.requestsPerUser,
    secondsPerDay: SECONDS_PER_DAY,
    peakFactor: input.peakFactor,
    writeShare: input.writeShare,
    objectBytes: input.objectSizeKb * 1_000,
    daysPerYear: DAYS_PER_YEAR,
    retentionYears: input.retentionYears,
    replicationFactor: input.replicationFactor,
  };
  const requestsPerDay = used.dau * used.requestsPerUser;
  const avgQps = requestsPerDay / used.secondsPerDay;
  const peakQps = avgQps * used.peakFactor;
  const writesPerDay = requestsPerDay * used.writeShare;
  const writeQps = avgQps * used.writeShare;
  const peakWriteQps = writeQps * used.peakFactor;
  const dailyBytes = writesPerDay * used.objectBytes;
  const yearlyBytes = dailyBytes * used.daysPerYear;
  const retainedBytes = yearlyBytes * used.retentionYears;
  return {
    used,
    requestsPerDay,
    avgQps,
    peakQps,
    writesPerDay,
    writeQps,
    peakWriteQps,
    peakReadQps: peakQps - peakWriteQps,
    dailyBytes,
    yearlyBytes,
    retainedBytes,
    storedBytes: retainedBytes * used.replicationFactor,
    bandwidthBytesPerSec: peakQps * used.objectBytes,
    cacheBytes: dailyBytes * HOT_SHARE,
    ...serversFor(peakQps),
  };
}

/**
 * The same steps done on a napkin: the big numbers (users, requests per user, seconds in a day,
 * bytes per object) become powers of ten, the small multipliers keep one significant figure, and
 * every step's result is rounded to one figure before the next step uses it.
 */
export function roughEstimate(input: CapacityInputs): Estimate {
  const r = toOneFigure;
  const used: UsedInputs = {
    dau: toPowerOfTen(input.dau),
    requestsPerUser: toPowerOfTen(input.requestsPerUser),
    secondsPerDay: 100_000,
    peakFactor: r(input.peakFactor),
    writeShare: r(input.writeShare),
    objectBytes: toPowerOfTen(input.objectSizeKb * 1_000),
    daysPerYear: r(DAYS_PER_YEAR),
    retentionYears: r(input.retentionYears),
    replicationFactor: r(input.replicationFactor),
  };
  const requestsPerDay = r(used.dau * used.requestsPerUser);
  const avgQps = r(requestsPerDay / used.secondsPerDay);
  const peakQps = r(avgQps * used.peakFactor);
  const writesPerDay = r(requestsPerDay * used.writeShare);
  const writeQps = r(avgQps * used.writeShare);
  const peakWriteQps = r(writeQps * used.peakFactor);
  const dailyBytes = r(writesPerDay * used.objectBytes);
  const yearlyBytes = r(dailyBytes * used.daysPerYear);
  const retainedBytes = r(yearlyBytes * used.retentionYears);
  return {
    used,
    requestsPerDay,
    avgQps,
    peakQps,
    writesPerDay,
    writeQps,
    peakWriteQps,
    peakReadQps: r(Math.max(0, peakQps - peakWriteQps)),
    dailyBytes,
    yearlyBytes,
    retainedBytes,
    storedBytes: r(retainedBytes * used.replicationFactor),
    bandwidthBytesPerSec: r(peakQps * used.objectBytes),
    cacheBytes: r(dailyBytes * HOT_SHARE),
    ...serversFor(peakQps),
  };
}

/** How far apart two estimates are, as a factor of at least 1 (2 means one is twice the other). */
export function offBy(rough: number, exact: number) {
  if (rough <= 0 || exact <= 0) return rough === exact ? 1 : Infinity;
  return Math.max(rough / exact, exact / rough);
}

export type ScaleCategory = 'one-machine' | 'fleet' | 'partitioned';

/**
 * The decision an estimate is really for. Boundaries are the rule of thumb from the Lesson:
 * under ~1,000 peak req/sec one machine and a spare, up to ~50,000 a scaled-out fleet with caching,
 * above that partitioned data and per-region deployment.
 */
export function scaleOf(peakQps: number): ScaleCategory {
  if (peakQps < 1_000) return 'one-machine';
  if (peakQps <= 50_000) return 'fleet';
  return 'partitioned';
}

export const SCALE_LABEL: Record<ScaleCategory, string> = {
  'one-machine': 'One machine and a spare',
  fleet: 'A fleet behind a load balancer',
  partitioned: 'Partitioned, per-region fleet',
};

export type WriteDecision = 'one-primary' | 'partition';

/** The database half of the decision: peak writes against what one primary absorbs. */
export const writeDecisionOf = (peakWriteQps: number): WriteDecision =>
  peakWriteQps > PRIMARY_WRITE_LIMIT ? 'partition' : 'one-primary';

export const WRITE_DECISION_LABEL: Record<WriteDecision, string> = {
  'one-primary': 'One primary is enough',
  partition: 'Partition the writes',
};

/**
 * Whether the rough estimate leads to the same design as the exact one: the same scale category
 * for the app tier and the same write decision for the database. Peak QPS alone is not enough - at
 * 100% writes both peaks are a fleet, while only the exact writes overflow one primary.
 */
export const sameDecision = (rough: Estimate, exact: Estimate) =>
  scaleOf(rough.peakQps) === scaleOf(exact.peakQps) &&
  writeDecisionOf(rough.peakWriteQps) === writeDecisionOf(exact.peakWriteQps);

const SUPERSCRIPT: Record<string, string> = {
  '-': '⁻',
  '0': '⁰',
  '1': '¹',
  '2': '²',
  '3': '³',
  '4': '⁴',
  '5': '⁵',
  '6': '⁶',
  '7': '⁷',
  '8': '⁸',
  '9': '⁹',
};

/** A rough number the way it is written on a napkin: 10^4, 5 x 10^3, 0.1, 400. */
export function formatPowerOfTen(value: number) {
  if (value <= 0) return '0';
  const exponent = Math.floor(Math.log10(value) + 1e-9);
  if (exponent < 3) return `${Number(value.toPrecision(2))}`;
  const mantissa = Number((value / 10 ** exponent).toPrecision(2));
  const power = `10${String(exponent)
    .split('')
    .map((char) => SUPERSCRIPT[char] ?? char)
    .join('')}`;
  return mantissa === 1 ? power : `${mantissa} x ${power}`;
}

/** Decimal byte sizes, 1 KB = 1,000 bytes. */
export function formatSize(bytes: number) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1_000 && unit < units.length - 1) {
    value /= 1_000;
    unit += 1;
  }
  return `${value < 10 ? Number(value.toFixed(1)) : Math.round(value)} ${units[unit]}`;
}

/** Rates below 10/sec keep two decimals, so a tiny product does not read as "0 req/sec". */
export const formatRate = (value: number) => (value < 10 ? value.toFixed(2) : formatNumber(value));

export const formatCopies = (count: number) => `${count} ${count > 1 ? 'copies' : 'copy'}`;

/** Two significant figures below 10, whole numbers with separators above, "< 0.01" for dust. */
function formatFigure(value: number) {
  if (value >= 10) return formatNumber(value);
  if (value < 0.01) return '< 0.01';
  return `${Number(value.toPrecision(2))}`;
}

/** Bytes per second as megabytes per second (1 MB = 10^6 bytes): the unit files are measured in. */
export const formatMegabytesPerSec = (bytesPerSec: number) => `${formatFigure(bytesPerSec / 1e6)} MB/s`;

/** Bytes per second as gigabits per second (x 8 bits): the unit network links are sold in. */
export const formatGigabitsPerSec = (bytesPerSec: number) => `${formatFigure((bytesPerSec * 8) / 1e9)} Gbit/s`;

/** Both units side by side, because reading Gbit as GB is the classic 8x mistake. */
export const formatBandwidth = (bytesPerSec: number) =>
  `${formatMegabytesPerSec(bytesPerSec)} = ${formatGigabitsPerSec(bytesPerSec)}`;

/**
 * How an estimate writes its numbers: napkin powers of ten in rough mode, the plain figures
 * otherwise. `big` is for counts, `rate` for per-second values, `small` for multipliers.
 */
export function numberFormats(rounding: boolean) {
  return {
    big: (value: number) => (rounding ? formatPowerOfTen(value) : formatCompact(value)),
    rate: (value: number) => (rounding ? formatPowerOfTen(value) : formatRate(value)),
    small: (value: number) => (rounding ? formatPowerOfTen(value) : `${Number(value.toPrecision(3))}`),
  };
}

export type CapacityStepId =
  | 'requests-per-day'
  | 'average-qps'
  | 'peak-qps'
  | 'servers-at-peak'
  | 'servers-with-headroom'
  | 'average-writes'
  | 'peak-writes'
  | 'daily-storage'
  | 'yearly-storage'
  | 'retained-storage'
  | 'replicated-storage'
  | 'peak-bandwidth';

export interface CapacityStep {
  id: CapacityStepId;
  label: string;
  /** The part of the system this number sizes. */
  part: string;
  formula: string;
  /** The number the step produces - the same one the diagram and the metrics show. */
  value: number;
  result: string;
  /** Rough mode only: the exact result of the same step. */
  exact?: string;
  emphasis?: boolean;
}

/**
 * The estimate as the chain of steps the Lab lists, each producing one number from the ones before
 * it. In rough mode the formulas show the rounded inputs and every step also carries its exact
 * result, so the learner sees where the napkin drifts.
 */
export function capacitySteps(input: CapacityInputs, rounding: boolean): CapacityStep[] {
  const exact = exactEstimate(input);
  const est = rounding ? roughEstimate(input) : exact;
  const u = est.used;
  const { big, rate, small } = numberFormats(rounding);
  const orExact = (text: string) => (rounding ? text : undefined);
  const years = input.retentionYears;
  return [
    {
      id: 'requests-per-day',
      label: 'Requests per day',
      part: 'Clients',
      formula: `${big(u.dau)} DAU x ${small(u.requestsPerUser)} requests/user/day`,
      value: est.requestsPerDay,
      result: `${big(est.requestsPerDay)} requests/day`,
      exact: orExact(formatCompact(exact.requestsPerDay)),
    },
    {
      id: 'average-qps',
      label: 'Average requests per second',
      part: 'Clients',
      formula: `${big(est.requestsPerDay)} / ${rounding ? formatPowerOfTen(u.secondsPerDay) : '86,400'} seconds`,
      value: est.avgQps,
      result: `${rate(est.avgQps)} req/sec`,
      exact: orExact(formatRate(exact.avgQps)),
      emphasis: true,
    },
    {
      id: 'peak-qps',
      label: 'Peak requests per second',
      part: 'Load balancer',
      formula: `${rate(est.avgQps)} x ${small(u.peakFactor)} peak factor`,
      value: est.peakQps,
      result: `${rate(est.peakQps)} req/sec`,
      exact: orExact(formatRate(exact.peakQps)),
      emphasis: true,
    },
    {
      id: 'servers-at-peak',
      label: 'App servers at peak',
      part: 'App tier',
      formula: `${rate(est.peakQps)} req/sec / ${formatNumber(SERVER_CAPACITY)} per server, rounded up`,
      value: est.serversAtPeak,
      result: `${formatNumber(est.serversAtPeak)} servers`,
      exact: orExact(formatNumber(exact.serversAtPeak)),
    },
    {
      id: 'servers-with-headroom',
      label: 'App servers with headroom',
      part: 'App tier',
      formula: `${formatNumber(est.serversAtPeak)} servers x ${HEADROOM} headroom, rounded up`,
      value: est.servers,
      result: `${formatNumber(est.servers)} servers`,
      exact: orExact(formatNumber(exact.servers)),
      emphasis: true,
    },
    {
      id: 'average-writes',
      label: 'Average writes per second',
      part: 'Database',
      formula: `${rate(est.avgQps)} req/sec x ${small(u.writeShare * 100)}% writes`,
      value: est.writeQps,
      result: `${rate(est.writeQps)} writes/sec`,
      exact: orExact(formatRate(exact.writeQps)),
    },
    {
      id: 'peak-writes',
      label: 'Peak writes per second',
      part: 'Database',
      formula: `${rate(est.writeQps)} writes/sec x ${small(u.peakFactor)} peak factor`,
      value: est.peakWriteQps,
      result: `${rate(est.peakWriteQps)} writes/sec`,
      exact: orExact(formatRate(exact.peakWriteQps)),
      emphasis: true,
    },
    {
      id: 'daily-storage',
      label: 'Daily storage growth',
      part: 'Object storage',
      formula: `${big(est.writesPerDay)} writes/day x ${formatSize(u.objectBytes)}`,
      value: est.dailyBytes,
      result: formatSize(est.dailyBytes),
      exact: orExact(formatSize(exact.dailyBytes)),
    },
    {
      id: 'yearly-storage',
      label: 'Annual storage growth',
      part: 'Object storage',
      formula: `${formatSize(est.dailyBytes)} x ${small(u.daysPerYear)} days`,
      value: est.yearlyBytes,
      result: formatSize(est.yearlyBytes),
      exact: orExact(formatSize(exact.yearlyBytes)),
      emphasis: true,
    },
    {
      id: 'retained-storage',
      label: `Storage after ${years} year${years > 1 ? 's' : ''}`,
      part: 'Object storage',
      formula: `${formatSize(est.yearlyBytes)} x ${small(u.retentionYears)}`,
      value: est.retainedBytes,
      result: formatSize(est.retainedBytes),
      exact: orExact(formatSize(exact.retainedBytes)),
    },
    {
      id: 'replicated-storage',
      label: 'With replication',
      part: 'Object storage',
      formula: `${formatSize(est.retainedBytes)} x ${formatCopies(u.replicationFactor)}`,
      value: est.storedBytes,
      result: formatSize(est.storedBytes),
      exact: orExact(formatSize(exact.storedBytes)),
      emphasis: true,
    },
    {
      id: 'peak-bandwidth',
      label: 'Peak bandwidth',
      part: 'Load balancer',
      formula: `${rate(est.peakQps)} req/sec x ${formatSize(u.objectBytes)}, x 8 for bits`,
      value: est.bandwidthBytesPerSec,
      result: formatBandwidth(est.bandwidthBytesPerSec),
      exact: orExact(formatBandwidth(exact.bandwidthBytesPerSec)),
    },
  ];
}
