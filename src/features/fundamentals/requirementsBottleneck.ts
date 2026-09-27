/**
 * The find-the-bottleneck loop of the What is System Design focus: raise the users, find the first
 * part over its limit, pick one fix for it, see what that fix cost, repeat.
 *
 * Every number comes from the shared sizing model (requirementsSizing.ts, the Capacity Lab
 * arithmetic): 1,000 req/s per app server, 10,000 reads/s per database copy and 10,000 writes/s per
 * primary. Those are planning assumptions, not measurements, and a bigger machine is simply
 * BIGGER_MACHINE times a standard one.
 *
 * Pure: no React and only relative imports, so `npm test` runs it.
 */
import { formatCompact } from '../../utils/format.ts';
import { PRIMARY_WRITE_LIMIT, SERVER_CAPACITY } from './capacityModel.ts';
import { CACHE_HIT, READS_PER_COPY } from './requirementsSizing.ts';
import {
  BIGGER_MACHINE,
  LOOP_DAU,
  WRITE_FLOWS,
  architecture,
  type Architecture,
  type FixId,
  type FlowKind,
  type RouteVariant,
  type Setup,
} from './requirementsArchitecture.ts';
import { relativeCost } from './requirementsCost.ts';

/** A limit a part can pass: the app server on requests, the database on reads or on writes. */
export type BottleneckId = 'app' | 'db-reads' | 'db-writes';

export interface Bottleneck {
  id: BottleneckId;
  part: 'api' | 'db';
  /** What the load is counted in, for the stat row. */
  unit: 'req/s' | 'reads/s' | 'writes/s';
  /** Peak load on the part (on each partition, for the database). */
  load: number;
  /** What the part as built absorbs. */
  limit: number;
}

/**
 * The limits in the order a request meets them. Only the first one passed is a bottleneck: a part
 * past its limit turns the rest away, so the parts behind it never see the load that would pass
 * theirs - there is exactly one bottleneck that matters at a time.
 */
function limitsOf(arch: Architecture): Bottleneck[] {
  const { sizing, machineSize, parts } = arch;
  const limits: Bottleneck[] = [];
  if (parts.api) {
    limits.push({
      id: 'app',
      part: 'api',
      unit: 'req/s',
      load: sizing.peakQps,
      limit: sizing.app.count * SERVER_CAPACITY * (machineSize.api ?? 1),
    });
  }
  if (parts.db) {
    const { partitions, readReplicas, peakReadQps, peakWriteQps } = sizing.database;
    const size = machineSize.db ?? 1;
    // The reads the cache misses reach the database; replicas share them.
    const reads = (peakReadQps * (sizing.cached ? 1 - CACHE_HIT : 1)) / partitions;
    limits.push({ id: 'db-reads', part: 'db', unit: 'reads/s', load: reads, limit: (1 + readReplicas) * READS_PER_COPY * size });
    limits.push({ id: 'db-writes', part: 'db', unit: 'writes/s', load: peakWriteQps / partitions, limit: PRIMARY_WRITE_LIMIT * size });
  }
  return limits;
}

/** The first part over its limit, or null. Only the loop has one: elsewhere every tier is sized for the load. */
export function findBottleneck(setup: Setup, arch: Architecture = architecture(setup)): Bottleneck | null {
  if (!setup.loop) return null;
  return limitsOf(arch).find((limit) => limit.load > limit.limit) ?? null;
}

const STAT_LABEL: Record<BottleneckId, string> = { app: 'Peak load', 'db-reads': 'Peak reads', 'db-writes': 'Peak writes' };

/** The stat row of the red part: its peak load against what it absorbs, "~1.7K of 1K req/s". */
export function bottleneckStat(bottleneck: Bottleneck) {
  const unit = bottleneck.id === 'app' ? ' req/s' : '/s';
  return { label: STAT_LABEL[bottleneck.id], value: `~${formatCompact(bottleneck.load)} of ${formatCompact(bottleneck.limit)}${unit}` };
}

// ---------------------------------------------------------------------------
// Fixes
// ---------------------------------------------------------------------------

export interface FixSpec {
  label: string;
  /** What the fix gives up - the new problem it brings, said out loud. */
  tradeOff: string;
  /** For a bigger machine: its size in standard machines. */
  size?: number;
}

export const FIXES: Record<FixId, FixSpec> = {
  'scale-out': {
    label: 'More app servers behind a load balancer',
    tradeOff: 'Every server must be stateless: no session can live in its memory',
  },
  autoscale: {
    label: 'An autoscaling pool of app servers',
    tradeOff: 'No spare servers: a sudden spike waits minutes for new ones',
  },
  'bigger-app': {
    label: `A bigger machine (${BIGGER_MACHINE}x)`,
    tradeOff: 'Still one server: a restart is an outage, and no size is bigger',
    size: BIGGER_MACHINE,
  },
  cache: {
    label: 'A cache in front of the database',
    tradeOff: 'A slightly stale feed: a new post can take a minute to show',
  },
  replicas: {
    label: 'Read replicas of the database',
    tradeOff: 'Replica lag: right after posting, you may not see your own post',
  },
  'bigger-db': {
    label: `A bigger database machine (${BIGGER_MACHINE}x)`,
    tradeOff: 'Still one primary: its failure stops every write, and no size is bigger',
    size: BIGGER_MACHINE,
  },
  partition: {
    label: 'Partition the writes',
    tradeOff: 'A feed across partitions must read them all, and the key is hard to change',
  },
};

/** The fixes each limit can offer, in the order they are listed. */
const OFFERED: Record<BottleneckId, FixId[]> = {
  app: ['scale-out', 'autoscale', 'bigger-app'],
  'db-reads': ['cache', 'replicas', 'bigger-db'],
  'db-writes': ['partition', 'bigger-db'],
};

/** A pool of servers replaces a single machine, whatever its size. */
const REPLACES: Partial<Record<FixId, FixId[]>> = {
  'scale-out': ['bigger-app', 'autoscale'],
  autoscale: ['bigger-app', 'scale-out'],
};

export function applyFix(setup: Setup, fix: FixId): Setup {
  if (!setup.loop) return setup;
  const replaced = REPLACES[fix] ?? [];
  const fixes = [...setup.loop.fixes.filter((id) => id !== fix && !replaced.includes(id)), fix];
  return { ...setup, loop: { ...setup.loop, fixes } };
}

export interface FixOption extends FixSpec {
  id: FixId;
  /** Monthly cost of the design with this fix, as a multiple of the simplest design (x1). */
  cost: number;
  /** What the fix adds to the monthly cost, in the same units. */
  added: number;
}

/**
 * What the learner can pick for the current bottleneck: each fix not picked yet that clears it at
 * this load. A bigger machine that is too small for this load is not offered.
 */
export function fixesFor(setup: Setup): FixOption[] {
  const bottleneck = findBottleneck(setup);
  if (!bottleneck) return [];
  const now = relativeCost(setup);
  return OFFERED[bottleneck.id]
    .filter((id) => !setup.loop?.fixes.includes(id))
    .map((id) => ({ id, next: applyFix(setup, id) }))
    .filter(({ next }) => findBottleneck(next)?.id !== bottleneck.id)
    .map(({ id, next }) => {
      const cost = relativeCost(next);
      return { id, ...FIXES[id], cost, added: cost - now };
    });
}

/** The trade-off of every fix picked, in the order picked: the costs the design now carries. */
export function tradeOffsOf(setup: Setup) {
  return (setup.loop?.fixes ?? []).map((fix) => ({ fix, label: FIXES[fix].label, text: FIXES[fix].tradeOff }));
}

// ---------------------------------------------------------------------------
// Rounds
// ---------------------------------------------------------------------------

/** The rounds of the loop: one per raise of the users after the start. */
export const ROUNDS = LOOP_DAU.length - 1;

/** The next users step - only once nothing is over its limit, so each round fixes what it found. */
export function raiseUsers(setup: Setup): Setup {
  const { loop } = setup;
  if (!loop || loop.users >= ROUNDS || findBottleneck(setup)) return setup;
  return { ...setup, loop: { ...loop, users: loop.users + 1 } };
}

export interface LoopState {
  /** 0 at the start, then 1 to ROUNDS. */
  round: number;
  bottleneck: Bottleneck | null;
  canRaise: boolean;
  /** The last round is reached and nothing is over its limit: the design meets the target. */
  done: boolean;
}

export function loopState(setup: Setup, arch: Architecture = architecture(setup)): LoopState {
  const round = setup.loop?.users ?? 0;
  const bottleneck = findBottleneck(setup, arch);
  return { round, bottleneck, canRaise: !bottleneck && round < ROUNDS, done: !bottleneck && round === ROUNDS };
}

// ---------------------------------------------------------------------------
// Traffic
// ---------------------------------------------------------------------------

/**
 * The routes of one kind of traffic with the red part turning away what is past its limit: that
 * share stops at the part as a failure, the rest carries on. Only the traffic the limit counts is
 * touched - a Database over its read limit still takes every write.
 */
export function overloadedRoutes(flow: FlowKind, variants: RouteVariant[], bottleneck: Bottleneck | null): RouteVariant[] {
  if (!bottleneck) return variants;
  const counted = bottleneck.id === 'app' || (bottleneck.id === 'db-reads' ? flow === 'read' : WRITE_FLOWS.has(flow));
  if (!counted) return variants;
  const pass = bottleneck.limit / bottleneck.load;
  return variants.flatMap((variant) => {
    const at = variant.route.indexOf(bottleneck.part);
    // Traffic that starts at the part (a push from the app server) never arrives at it.
    if (at <= 0) return [variant];
    return [
      { ...variant, weight: variant.weight * pass },
      { route: variant.route.slice(0, at + 1), outcome: 'failure' as const, weight: variant.weight * (1 - pass) },
    ];
  });
}
