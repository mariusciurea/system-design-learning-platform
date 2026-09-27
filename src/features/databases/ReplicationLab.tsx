import { useCallback, useRef } from 'react';
import { Power, RotateCw, ShieldAlert } from 'lucide-react';
import {
  ArchNode,
  DiagramCanvas,
  NodeStatRow,
  ParticleLegend,
  spread,
  type DiagramEdge,
  type Layout,
  type ParticleView,
} from '@/components/architecture';
import { Insight, LabShell, MetricsPanel } from '@/components/learning';
import { Button, SegmentedControl, Slider, Toggle } from '@/components/ui';
import {
  advanceParticles,
  nextParticleId,
  RateCounter,
  useEventLog,
  useTicker,
  type Particle,
} from '@/simulations/engine';
import { useLabSetup } from '@/hooks/useLabSetup';
import { useRerender } from '@/hooks/useRerender';
import { sampleArrivals } from '@/utils/math';
import { formatLatency, formatNumber, formatPercent } from '@/utils/format';
import type { LabFocus, LabProps, NodeStatus } from '@/types';
import { useLabRunning } from '@/hooks/useLabRunning';

/**
 * When the primary acknowledges a write:
 * - async: as soon as it has committed it locally;
 * - semi-sync: once one replica has applied it too (like PostgreSQL `ANY 1`);
 * - sync: once every replica has applied it.
 */
type Mode = 'async' | 'semi-sync' | 'sync';

interface Setup {
  mode: Mode;
  writeRate: number;
  readRate: number;
  lagMs: number;
  readFromReplicas: boolean;
  /** Send a user who just wrote to the primary for their next read. */
  readYourWrites: boolean;
}

/** What the lab opens on at /labs/replication, with no Lab focus. */
const DEFAULT_SETUP: Setup = {
  mode: 'async',
  writeRate: 20,
  readRate: 80,
  lagMs: 400,
  readFromReplicas: true,
  readYourWrites: false,
};

/**
 * The Lab focus of each Concept that hosts this lab:
 * - Replication: the leader and its followers, with lag and stale reads.
 * - Read replicas: reads on the replicas and users missing their own save.
 * - Strong consistency: synchronous replication, reads from a replica are never behind.
 * - Eventual consistency: a long lag, so replica reads are visibly stale until writes stop.
 * - Leader / follower: writes to the leader, reads spread over the followers, short lag.
 */
const FOCUS_SETUPS: Record<LabFocus<'replication'>, Setup> = {
  replication: DEFAULT_SETUP,
  'read-replicas': { ...DEFAULT_SETUP, readRate: 200, lagMs: 800 },
  'strong-consistency': { ...DEFAULT_SETUP, mode: 'sync', lagMs: 100 },
  'eventual-consistency': { ...DEFAULT_SETUP, lagMs: 1500 },
  'leader-follower': { ...DEFAULT_SETUP, readRate: 120, lagMs: 200 },
};

/** Simplified: the time the primary takes to commit a write locally. */
const COMMIT_MS = 8;
/** Simplified: half of the writes are followed by the same user reading the row back. */
const OWN_READ_SHARE = 0.5;
/** Simplified: that read comes 150 ms after the acknowledgement - a redirect after Save. */
const REDIRECT_MS = 150;
/** Simplified: how long the automated failover takes to promote a replica. */
const FAILOVER_MS = 3000;
/**
 * Simplified: the table has 100 rows, and every write and every read picks one
 * at random. A read is only stale if its row changed within the lag - with no
 * hot rows, so a real hot key would make it worse.
 */
const ROWS = 100;

interface Node {
  id: string;
  name: string;
  role: 'primary' | 'replica';
  status: NodeStatus;
  /** Highest write version this node has applied. */
  applied: number;
  /** Per row, the version of the newest write to it this node has applied. */
  rows: number[];
  reads: number;
  staleReads: number;
  /**
   * A former primary that is down after a failover. It is not part of the
   * synchronous set until it recovers, so synchronous writes do not wait for it.
   */
  outOfSet: boolean;
}

interface State {
  nodes: Node[];
  /** Newest write the primary has committed. */
  version: number;
  /** Newest write the primary has acknowledged to a client. */
  acked: number;
  /** Per row, the newest acknowledged write to it. */
  ackedRows: number[];
  particles: Particle[];
  writes: number;
  refused: number;
  reads: number;
  staleReads: number;
  ownReads: number;
  ownMissed: number;
  /**
   * Rolling copies of the counters, used for the percentages. Switching modes
   * or dragging the lag has to move those numbers now, not once the lifetime
   * average has been diluted enough to notice.
   */
  recentReads: RateCounter;
  recentStale: RateCounter;
  recentOwn: RateCounter;
  recentOwnMissed: RateCounter;
  recentRefused: RateCounter;
  lostWrites: number;
  failoverAt: number | null;
  cursor: number;
  /** Replication in flight: the replica applies `version` (a write to `row`) at `at`. */
  pending: { id: string; at: number; version: number; row: number }[];
  /** Acknowledgements in flight: the client hears "saved" at `at`. */
  acks: { at: number; version: number; row: number }[];
  /** The same user reading back the row they just saved. */
  followUps: { at: number; version: number; row: number }[];
  /** Moving average of the time from write to acknowledgement. */
  ackMs: number;
}

const node = (id: string, name: string, role: Node['role']): Node => ({
  id,
  name,
  role,
  status: 'healthy',
  applied: 0,
  rows: new Array<number>(ROWS).fill(0),
  reads: 0,
  staleReads: 0,
  outOfSet: false,
});

const createState = (): State => {
  const counters = Array.from({ length: 5 }, () => new RateCounter(3000));
  // Start every ring at the same instant, so their buckets stay in step and a
  // share like stale/reads can never be computed from misaligned windows.
  const t0 = performance.now();
  for (const counter of counters) counter.rate(t0);
  const [recentReads, recentStale, recentOwn, recentOwnMissed, recentRefused] = counters;
  return {
    nodes: [
      node('primary', 'Primary', 'primary'),
      node('r1', 'Replica 1', 'replica'),
      node('r2', 'Replica 2', 'replica'),
      node('r3', 'Replica 3', 'replica'),
    ],
    version: 0,
    acked: 0,
    ackedRows: new Array<number>(ROWS).fill(0),
    particles: [],
    writes: 0,
    refused: 0,
    reads: 0,
    staleReads: 0,
    ownReads: 0,
    ownMissed: 0,
    recentReads,
    recentStale,
    recentOwn,
    recentOwnMissed,
    recentRefused,
    lostWrites: 0,
    failoverAt: null,
    cursor: 0,
    pending: [],
    acks: [],
    followUps: [],
    ackMs: COMMIT_MS,
  };
};

const MODE_LABEL: Record<Mode, string> = {
  async: 'primary only',
  'semi-sync': '1 replica',
  sync: 'all replicas',
};

export function ReplicationLab({ focus }: LabProps<'replication'>) {
  // The page keys this lab by Concept, so the focus never changes under a mounted lab.
  const start = focus ? FOCUS_SETUPS[focus] : DEFAULT_SETUP;
  // Every control lives in one object, so Reset cannot miss one.
  const { setup, setSetup, change } = useLabSetup(start);
  const { mode, writeRate, readRate, lagMs, readFromReplicas, readYourWrites } = setup;
  const [running, setRunning] = useLabRunning();

  const state = useRef<State>(createState());
  const rerender = useRerender(30);
  const { events, log, clear } = useEventLog(50);

  const rebuild = useCallback(() => {
    state.current = createState();
    clear();
  }, [clear]);

  const reset = useCallback(() => {
    // Back to this Concept's starting setup, not the lab's global default.
    setSetup(start);
    rebuild();
  }, [start, rebuild, setSetup]);

  const killNode = useCallback(
    (id: string) => {
      const current = state.current;
      const target = current.nodes.find((item) => item.id === id);
      if (!target || target.status === 'down') return;
      target.status = 'down';
      if (target.role === 'primary') {
        log('Primary unreachable - health checks failing', 'danger');
        current.failoverAt = performance.now() + FAILOVER_MS;
        // Changes still waiting to ship died with the primary, and so did the
        // acknowledgements not yet sent: those clients get a timeout, not "saved".
        current.pending = [];
        current.acks = [];
      } else {
        log(`${target.name} down - read capacity reduced`, 'warn');
      }
      rerender();
    },
    [log, rerender],
  );

  const reviveNode = useCallback(
    (id: string) => {
      const current = state.current;
      const target = current.nodes.find((item) => item.id === id);
      if (!target) return;
      target.status = 'healthy';
      target.outOfSet = false;
      // Compare against the other nodes: this one is already marked healthy, so
      // matching itself turned a recovered primary into a replica and left the
      // cluster with no primary until the pending failover promoted one.
      const otherPrimary = current.nodes.some(
        (item) => item !== target && item.role === 'primary' && item.status !== 'down',
      );
      if (target.role === 'primary' && !otherPrimary) {
        current.failoverAt = null;
        log(`${target.name} recovered before failover - it stays the primary`, 'ok');
        rerender();
        return;
      }
      target.role = 'replica';
      // Simplified: it copies the current primary at once instead of replaying the log.
      const leader = current.nodes.find((item) => item.role === 'primary' && item.status === 'healthy');
      if (leader) {
        target.applied = leader.applied;
        target.rows = [...leader.rows];
      }
      log(`${target.name} recovered and caught up as a replica`, 'ok');
      rerender();
    },
    [log, rerender],
  );

  useTicker(running, (dt) => {
    const current = state.current;
    const now = performance.now();

    // Failover: promote the most up-to-date replica.
    if (current.failoverAt && now >= current.failoverAt) {
      current.failoverAt = null;
      const candidates = current.nodes.filter((item) => item.role === 'replica' && item.status === 'healthy');
      if (candidates.length > 0) {
        const winner = candidates.reduce((best, item) => (item.applied > best.applied ? item : best), candidates[0]);
        // Only acknowledged writes count as lost: the client was told "saved".
        const lost = Math.max(0, current.acked - winner.applied);
        current.lostWrites += lost;
        // The failed primary is no longer the primary; if it comes back it
        // rejoins as a replica. Leaving it as 'primary' kept the dead node in
        // the diagram and hid the promoted one.
        for (const item of current.nodes) {
          if (item.role === 'primary') {
            item.role = 'replica';
            item.outOfSet = item.status === 'down';
            // A demoted node sits in a replica box: drop the old role from its title.
            item.name = item.id === 'primary' ? 'Old primary' : item.name.replace(' (promoted)', '');
          }
        }
        winner.role = 'primary';
        winner.name = winner.id === 'primary' ? 'Primary' : `${winner.name} (promoted)`;
        current.version = winner.applied;
        current.acked = Math.min(current.acked, winner.applied);
        // Whatever the new primary holds is now the truth for every row.
        current.ackedRows = [...winner.rows];
        log(`${winner.name} promoted to PRIMARY`, 'ok');
        if (lost > 0) {
          log(`${lost} acknowledged write(s) lost - the promoted replica never received them`, 'danger');
        } else {
          log('No acknowledged writes lost - the promoted replica had all of them', 'ok');
        }
      } else {
        log('No healthy replica available to promote - the database is down', 'danger');
      }
    }

    const primary = current.nodes.find((item) => item.role === 'primary' && item.status === 'healthy');
    const deadPrimary = current.nodes.find((item) => item.role === 'primary' && item.status === 'down');
    const replicas = current.nodes.filter((item) => item.role === 'replica' && item.status === 'healthy');
    const syncSet = current.nodes.filter((item) => item.role === 'replica' && !item.outOfSet);
    // Sync waits for every replica in the set, so one that is down blocks every write.
    // Semi-sync needs any one healthy replica.
    const cannotAck =
      (mode === 'sync' && syncSet.some((item) => item.status === 'down')) ||
      (mode === 'semi-sync' && replicas.length === 0);

    // Writes
    const writes = sampleArrivals(writeRate, dt);
    for (let index = 0; index < writes; index += 1) {
      if (!primary || cannotAck) {
        current.refused += 1;
        current.recentRefused.add(1, now);
        const to = primary ?? deadPrimary;
        if (to) {
          current.particles.push({
            id: nextParticleId(),
            route: ['client', to.id],
            leg: 0,
            t: 0,
            speed: 1.4,
            outcome: 'failure',
          });
        }
        continue;
      }
      current.version += 1;
      current.writes += 1;
      const version = current.version;
      const row = Math.floor(Math.random() * ROWS);
      primary.applied = version;
      primary.rows[row] = version;

      current.particles.push({
        id: nextParticleId(),
        route: ['client', primary.id],
        leg: 0,
        t: 0,
        speed: 1.4,
        outcome: 'success',
      });

      // Every replica receives the change after its own network delay, in every
      // mode. What the mode changes is when the client is told "saved".
      let fastest = Infinity;
      let slowest = 0;
      for (const replica of replicas) {
        const delay = lagMs * (0.7 + Math.random() * 0.6);
        fastest = Math.min(fastest, delay);
        slowest = Math.max(slowest, delay);
        current.pending.push({ id: replica.id, at: now + delay, version, row });
        current.particles.push({
          id: nextParticleId(),
          route: [primary.id, replica.id],
          leg: 0,
          t: 0,
          speed: 1000 / Math.max(120, delay),
          outcome: mode === 'async' ? 'warning' : 'success',
        });
      }
      const wait = mode === 'async' || replicas.length === 0 ? 0 : mode === 'semi-sync' ? fastest : slowest;
      const ackMs = COMMIT_MS + wait;
      current.ackMs += (ackMs - current.ackMs) * 0.1;
      current.acks.push({ at: now + ackMs, version, row });
    }

    // Apply replication that has arrived.
    current.pending = current.pending.filter((item) => {
      if (now < item.at) return true;
      const replica = current.nodes.find((entry) => entry.id === item.id);
      if (replica && replica.status === 'healthy') {
        replica.applied = Math.max(replica.applied, item.version);
        replica.rows[item.row] = Math.max(replica.rows[item.row], item.version);
      }
      return false;
    });

    // Acknowledge writes whose wait is over.
    current.acks = current.acks.filter((item) => {
      if (now < item.at) return true;
      current.acked = Math.max(current.acked, item.version);
      current.ackedRows[item.row] = Math.max(current.ackedRows[item.row], item.version);
      if (primary) {
        current.particles.push({
          id: nextParticleId(),
          route: [primary.id, 'client'],
          leg: 0,
          t: 0,
          speed: 2,
          outcome: 'success',
        });
      }
      if (Math.random() < OWN_READ_SHARE) {
        current.followUps.push({ at: now + REDIRECT_MS, version: item.version, row: item.row });
      }
      return false;
    });

    // The user who saved reads the row back.
    current.followUps = current.followUps.filter((item) => {
      if (now < item.at) return true;
      const toPrimary = !readFromReplicas || (readYourWrites && primary !== undefined);
      let target: Node | undefined;
      if (toPrimary && primary) target = primary;
      else if (replicas.length > 0) {
        current.cursor = (current.cursor + 1) % replicas.length;
        target = replicas[current.cursor];
      } else target = primary;
      if (!target) return false;
      const missed = target.rows[item.row] < item.version;
      target.reads += 1;
      current.ownReads += 1;
      current.recentOwn.add(1, now);
      if (missed) {
        current.ownMissed += 1;
        current.recentOwnMissed.add(1, now);
      }
      current.particles.push({
        id: nextParticleId(),
        route: ['client', target.id],
        leg: 0,
        t: 0,
        speed: 1.5,
        outcome: missed ? 'failure' : 'cache-hit',
      });
      return false;
    });

    // Other reads
    const reads = sampleArrivals(readRate, dt);
    const readTargets = readFromReplicas && replicas.length > 0 ? replicas : primary ? [primary] : [];
    for (let index = 0; index < reads; index += 1) {
      if (readTargets.length === 0) continue;
      current.cursor = (current.cursor + 1) % readTargets.length;
      const target = readTargets[current.cursor];
      // Behind means missing a write to this row that a client was already told is saved.
      const row = Math.floor(Math.random() * ROWS);
      const stale = target.rows[row] < current.ackedRows[row];
      target.reads += 1;
      current.reads += 1;
      current.recentReads.add(1, now);
      if (stale) {
        target.staleReads += 1;
        current.staleReads += 1;
        current.recentStale.add(1, now);
      }
      current.particles.push({
        id: nextParticleId(),
        route: ['client', target.id],
        leg: 0,
        t: 0,
        speed: 1.5,
        outcome: stale ? 'warning' : 'cache-hit',
      });
    }

    const { alive } = advanceParticles(current.particles, dt);
    current.particles = alive.slice(-120);
    rerender();
  });

  const current = state.current;
  const primary = current.nodes.find((item) => item.role === 'primary');
  const primaryUp = primary?.status === 'healthy';
  const replicas = current.nodes.filter((item) => item.role === 'replica');
  // One timestamp for every counter: reading them at different instants put
  // their buckets out of step, and a share could climb past 100%.
  const renderNow = performance.now();
  const recentReadQps = current.recentReads.rate(renderNow);
  const staleRate = recentReadQps ? Math.min(1, current.recentStale.rate(renderNow) / recentReadQps) : 0;
  const recentOwnQps = current.recentOwn.rate(renderNow);
  const ownMissRate = recentOwnQps ? Math.min(1, current.recentOwnMissed.rate(renderNow) / recentOwnQps) : 0;
  const refusedQps = current.recentRefused.rate(renderNow);
  const writeLatency = current.ackMs;
  const downInSet = current.nodes.find((item) => item.role === 'replica' && !item.outOfSet && item.status === 'down');

  const xs = spread(replicas.length, 480, 170, 30);
  const layout: Layout = {
    client: { x: 380, y: 16, w: 200, h: 73 },
  };
  if (primary) layout[primary.id] = { x: 370, y: 124, w: 220, h: 173 };
  replicas.forEach((replica, index) => {
    layout[replica.id] = { x: xs[index], y: 336, w: 170, h: 173 };
  });

  const replicaEdgeLabel = mode === 'async' ? `lag ${lagMs} ms` : mode === 'sync' ? 'sync' : `sync 1 of ${replicas.length}`;
  const edges: DiagramEdge[] = [
    ...(primary ? [{ from: 'client', to: primary.id, tone: 'brand' as const, width: 2, label: 'writes' }] : []),
    ...(primary
      ? replicas.map<DiagramEdge>((replica) => ({
          from: primary.id,
          to: replica.id,
          tone: replica.status === 'healthy' ? (mode === 'async' ? 'warn' : 'ok') : 'muted',
          dashed: mode === 'async',
          label: replicaEdgeLabel,
        }))
      : []),
    ...(readFromReplicas
      ? replicas
          .filter((replica) => replica.status === 'healthy')
          .map<DiagramEdge>((replica) => ({
            from: 'client',
            to: replica.id,
            tone: 'ok',
            curvature: 0.8,
          }))
      : []),
  ];

  const particleViews: ParticleView[] = current.particles
    .filter((particle) => layout[particle.route[particle.leg]] && layout[particle.route[particle.leg + 1]])
    .map((particle) => ({
      id: particle.id,
      from: particle.route[particle.leg],
      to: particle.route[particle.leg + 1],
      t: particle.t,
      outcome: particle.outcome ?? 'success',
    }));

  const ownMissNote =
    readFromReplicas && !readYourWrites && ownMissRate > 0.05 ? (
      <p className="mt-2">
        And {formatPercent(ownMissRate, 0)} of users who save and reload do not see their own change: the reload
        reaches a replica {REDIRECT_MS} ms after the save, and that replica has not caught up. Nothing failed. Turn on
        read-your-writes routing and the crosses disappear.
      </p>
    ) : null;

  const insight = (() => {
    if (!primaryUp) {
      return (
        <p>
          There is no primary, so no write can be accepted - every write is refused until failover promotes the most
          up-to-date replica, about {FAILOVER_MS / 1000} s here. That gap is the price of having exactly one writer.
          Reads from the replicas keep working meanwhile.
        </p>
      );
    }
    if (mode === 'sync' && downInSet) {
      return (
        <p>
          Synchronous replication waits for every replica, and {downInSet.name} is down, so no write can be
          acknowledged: {formatNumber(Math.round(refusedQps))} writes/s are refused. That is the cost of never
          serving an old value - when a copy is unreachable, the system stops rather than let copies disagree.
          Recover it, or switch to semi-sync.
        </p>
      );
    }
    if (mode === 'async') {
      return (
        <p>
          Asynchronous replication acknowledges the write as soon as the primary has it, so writes cost about{' '}
          {formatLatency(writeLatency)} - but replicas are up to {Math.round(lagMs * 1.3)} ms behind, so{' '}
          {formatPercent(staleRate, 1)} of reads miss a write that was already acknowledged. Drag the write rate to 0
          and every replica catches up: that is eventual consistency. Kill the primary and any write not yet shipped
          is lost.
        </p>
      );
    }
    if (mode === 'semi-sync') {
      return (
        <p>
          Semi-sync waits for one replica, so an acknowledged write is always on at least two machines and a failover
          that promotes the most up-to-date replica loses nothing. The other replicas still lag, so{' '}
          {formatPercent(staleRate, 1)} of reads are behind: a durable write is not the same as a consistent read.
        </p>
      );
    }
    return (
      <p>
        Synchronous replication acknowledges only after every replica has applied the write, so a read from any
        replica returns the latest acknowledged write ({formatPercent(staleRate, 1)} behind). The price: every write
        waits about {formatLatency(writeLatency)} for the slowest replica - drag the network delay and watch it follow -
        and killing one replica stops all writes.
      </p>
    );
  })();

  return (
    <LabShell
      title="Database Replication Lab"
      description="Writes go to the primary (the leader) and stream to replicas (its followers). Watch replication lag create stale reads, choose when a write counts as saved, then kill the primary and see what a failover costs."
      running={running}
      onRunningChange={setRunning}
      onReset={reset}
      legend={
        <ParticleLegend
          outcomes={[
            { outcome: 'success', label: 'Write or acknowledgement' },
            { outcome: 'cache-hit', label: 'Up-to-date read' },
            { outcome: 'warning', label: 'Async copy, or a read missing an acknowledged write' },
            { outcome: 'failure', label: 'Own save not seen, or a refused write' },
          ]}
        />
      }
      events={events}
      actions={
        primaryUp && primary ? (
          <Button variant="danger" onClick={() => killNode(primary.id)}>
            <ShieldAlert className="h-4 w-4" />
            Kill primary
          </Button>
        ) : (
          <Button variant="success" onClick={rebuild}>
            <RotateCw className="h-4 w-4" />
            Rebuild cluster
          </Button>
        )
      }
      insight={
        <Insight>
          {insight}
          {ownMissNote}
        </Insight>
      }
      metrics={
        <>
          <MetricsPanel
            items={[
              { key: 'writes', label: 'Writes', value: formatNumber(current.writes), hint: 'Writes the primary accepted.' },
              {
                key: 'refused',
                label: 'Writes refused',
                value: formatNumber(current.refused),
                tone: current.refused > 0 ? 'danger' : 'ok',
                hint: 'Writes that could not be accepted: no primary during a failover, or a synchronous replica unreachable. Simplified: a real database would make them wait until a timeout.',
              },
              {
                key: 'staleReads',
                label: 'Reads behind',
                value: formatPercent(staleRate, 1),
                tone: staleRate > 0.05 ? 'warn' : 'ok',
                hint: `Reads that got an old value: the row they asked for had a newer write that a client was already told is saved. Every read and write picks one of ${ROWS} rows at random, so more lag or more writes means more stale reads.`,
                simulated: true,
              },
              {
                key: 'ownMissed',
                label: 'Own save not seen',
                value: formatPercent(ownMissRate, 0),
                tone: ownMissRate > 0.05 ? 'danger' : 'ok',
                hint: `Users who read back their own write ${REDIRECT_MS} ms after it was acknowledged and got the old value - a read-your-writes violation. Half of the writes are followed by such a read.`,
                simulated: true,
              },
              {
                key: 'latency',
                label: 'Write latency',
                value: formatLatency(writeLatency),
                hint: `Time until the write is acknowledged: ${COMMIT_MS} ms to commit on the primary, plus the wait for replicas the mode asks for.`,
                simulated: true,
              },
              {
                key: 'lost',
                label: 'Lost writes',
                value: formatNumber(current.lostWrites),
                tone: current.lostWrites > 0 ? 'danger' : 'ok',
                hint: 'Acknowledged writes that did not survive a failover.',
              },
            ]}
          />
          <div className="card p-4">
            <p className="label mb-3">Per-node state</p>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[520px] text-left font-mono text-[11px]">
                <thead className="text-faint">
                  <tr>
                    <th className="py-1.5 font-medium">node</th>
                    <th className="py-1.5 font-medium">role</th>
                    <th className="py-1.5 font-medium">status</th>
                    <th className="py-1.5 font-medium">applied version</th>
                    <th className="py-1.5 font-medium">behind</th>
                    <th className="py-1.5 font-medium">stale reads</th>
                  </tr>
                </thead>
                <tbody>
                  {current.nodes.map((item) => (
                    <tr key={item.id} className="border-t border-line">
                      <td className="py-1.5 text-ink">{item.name}</td>
                      <td className="py-1.5 text-muted">{item.role === 'primary' ? 'primary (leader)' : 'replica (follower)'}</td>
                      <td className={`py-1.5 ${item.status === 'down' ? 'text-danger' : 'text-ok'}`}>{item.status}</td>
                      <td className="py-1.5 text-muted">{item.applied}</td>
                      <td className={`py-1.5 ${current.version - item.applied > 0 ? 'text-warn' : 'text-ok'}`}>
                        {Math.max(0, current.version - item.applied)}
                      </td>
                      <td className="py-1.5 text-muted">{item.staleReads}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      }
      controls={
        <>
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted">Acknowledge the write after</p>
            <SegmentedControl
              value={mode}
              size="sm"
              className="w-full"
              options={[
                { value: 'async', label: 'Async' },
                { value: 'semi-sync', label: 'Semi-sync' },
                { value: 'sync', label: 'Sync' },
              ]}
              onChange={(value) => {
                change('mode')(value);
                log(
                  value === 'sync'
                    ? 'Synchronous: a write is acknowledged once every replica has it'
                    : value === 'semi-sync'
                      ? 'Semi-sync: a write is acknowledged once one replica has it'
                      : 'Asynchronous: a write is acknowledged as soon as the primary has it',
                  'info',
                );
              }}
            />
            <p className="text-[11px] text-faint">
              {mode === 'async'
                ? 'The primary only. Replicas get it later.'
                : mode === 'semi-sync'
                  ? 'The primary and one replica.'
                  : 'The primary and every replica.'}
            </p>
          </div>
          <Slider
            label="Write rate"
            value={writeRate}
            min={0}
            max={200}
            onChange={change('writeRate')}
            format={(value) => `${value} writes/sec`}
            hint="Set it to 0 and watch every replica converge on the same version."
          />
          <Slider
            label="Read rate"
            value={readRate}
            min={1}
            max={500}
            onChange={change('readRate')}
            format={(value) => `${value} reads/sec`}
          />
          <Slider
            label="Network delay to replicas"
            value={lagMs}
            min={50}
            max={3000}
            step={50}
            onChange={change('lagMs')}
            format={(value) => `${value} ms`}
            tone={lagMs > 1000 ? 'danger' : 'warn'}
            hint={
              mode === 'async'
                ? 'How long a change takes to reach a replica - the replication lag (each replica varies by 30%, simplified).'
                : 'Synchronous modes make the write wait this long for replicas, so a slower network means slower writes (simplified model).'
            }
          />
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-muted">Route reads to</span>
            <SegmentedControl
              size="sm"
              value={readFromReplicas ? 'replicas' : 'primary'}
              options={[
                { value: 'replicas', label: 'Replicas' },
                { value: 'primary', label: 'Primary' },
              ]}
              onChange={(value) => change('readFromReplicas')(value === 'replicas')}
            />
          </div>
          <Toggle
            label="Read-your-writes routing"
            checked={readYourWrites}
            onChange={(value) => {
              change('readYourWrites')(value);
              log(
                value
                  ? 'Read-your-writes: a user who just saved reads from the primary'
                  : 'Read-your-writes off: a user who just saved may read from a replica',
                'info',
              );
            }}
            disabled={!readFromReplicas}
            description="Right after a save, that user reads from the primary."
          />
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted">Failure injection</p>
            {current.nodes.map((item) => (
              <Button
                key={item.id}
                size="sm"
                variant={item.status === 'down' ? 'success' : 'secondary'}
                className="w-full justify-center"
                onClick={() => (item.status === 'down' ? reviveNode(item.id) : killNode(item.id))}
              >
                {item.status === 'down' ? <RotateCw className="h-3 w-3" /> : <Power className="h-3 w-3" />}
                {item.status === 'down' ? `Recover ${item.name}` : `Kill ${item.name}`}
              </Button>
            ))}
          </div>
        </>
      }
    >
      <DiagramCanvas layout={layout} edges={edges} particles={particleViews} height={525} className="bg-canvas">
        <ArchNode
          kind="client"
          title="Application"
          subtitle={`${writeRate} writes/s - ${readRate} reads/s`}
          placed={layout.client}
          compact
        />
        {primary ? (
          <ArchNode
            kind="sql"
            title={primary.name}
            subtitle="leader - takes every write"
            placed={layout[primary.id]}
            status={primary.status}
          >
            <NodeStatRow label="Version" value={current.version} />
            <NodeStatRow label="Ack after" value={MODE_LABEL[mode]} />
            <NodeStatRow label="Write latency" value={formatLatency(writeLatency)} />
            <NodeStatRow label="Reads" value={formatNumber(primary.reads)} />
          </ArchNode>
        ) : null}
        {replicas.map((replica) => {
          const behind = Math.max(0, current.version - replica.applied);
          return (
            <ArchNode
              key={replica.id}
              kind="sql"
              title={replica.name}
              subtitle="follower - read-only"
              placed={layout[replica.id]}
              status={replica.status}
              alert={behind > 10}
            >
              <NodeStatRow label="Applied" value={replica.applied} />
              <NodeStatRow label="Behind" value={behind} tone={behind > 0 ? 'text-warn' : 'text-ok'} />
              <NodeStatRow label="Reads" value={formatNumber(replica.reads)} />
              <NodeStatRow
                label="Stale"
                value={formatNumber(replica.staleReads)}
                tone={replica.staleReads > 0 ? 'text-warn' : 'text-ok'}
              />
            </ArchNode>
          );
        })}
      </DiagramCanvas>
    </LabShell>
  );
}

export default ReplicationLab;
