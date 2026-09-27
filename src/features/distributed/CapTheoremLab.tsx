import { useRef } from 'react';
import { CloudOff, Cloud } from 'lucide-react';
import {
  ArchNode,
  DiagramCanvas,
  NodeStatRow,
  ParticleLegend,
  type DiagramEdge,
  type Layout,
  type ParticleView,
} from '@/components/architecture';
import { Insight, LabShell, MetricsPanel } from '@/components/learning';
import { Badge, Button, SegmentedControl } from '@/components/ui';
import { advanceParticles, nextParticleId, useEventLog, useTicker, type Particle } from '@/simulations/engine';
import { useLabSetup } from '@/hooks/useLabSetup';
import { useRerender } from '@/hooks/useRerender';
import { cn } from '@/utils/cn';
import type { LabFocus, LabProps, RequestOutcome } from '@/types';
import { useLabRunning } from '@/hooks/useLabRunning';

/**
 * CAP: two clients, each talking to its own side of a replicated store. Split
 * the network between the sides and the store must choose, per request, between
 * refusing (CP) and answering from what this side has (AP).
 *
 * Simplified model, not a measurement:
 * - Each side stands for a group of replicas. With N replicas, side A holds
 *   ceil(N/2) and side B holds floor(N/2), so side A has a majority only when N
 *   is odd.
 * - With no partition a write reaches both sides before it is acknowledged
 *   (synchronous replication), so every read sees the latest write.
 * - In CP mode only a side holding a majority serves reads and writes; a side
 *   without one refuses both, because it cannot prove its copy is the latest.
 * - Versions come from one counter that stands in for a write timestamp, so
 *   last-write-wins at heal keeps the higher version.
 */

type Side = 'a' | 'b';
type Choice = 'cp' | 'ap';
type Op = 'write' | 'read';
type Replicas = '2' | '3' | '4' | '5';
/** What the two clients send on their own. */
type Traffic = 'mixed' | 'write-a-read-b';

interface Setup {
  choice: Choice;
  partitioned: boolean;
  replicas: Replicas;
  traffic: Traffic;
}

/** What the lab opens on at /labs/cap-theorem: a healthy network, no dilemma yet. */
const DEFAULT_SETUP: Setup = { choice: 'cp', partitioned: false, replicas: '3', traffic: 'mixed' };

/**
 * The Lab focus of each Concept that hosts this lab.
 * - CAP Theorem opens mid-partition in CP mode: side B already refuses, and one
 *   click on AP shows the other answer to the same dilemma.
 * - Consistency opens mid-partition in AP mode with client A writing and client
 *   B reading, so the first reads on side B return a value older than the write
 *   side A just acknowledged.
 * - Partition Tolerance opens mid-partition with 5 replicas split 3 | 2, the
 *   quorum picture of its Diagram; 2 or 4 replicas show a split with no majority.
 */
const FOCUS_SETUPS: Record<LabFocus<'cap-theorem'>, Setup> = {
  'cap-theorem': { choice: 'cp', partitioned: true, replicas: '3', traffic: 'mixed' },
  consistency: { choice: 'ap', partitioned: true, replicas: '3', traffic: 'write-a-read-b' },
  'partition-tolerance': { choice: 'cp', partitioned: true, replicas: '5', traffic: 'mixed' },
};

const REPLICA_OPTIONS: { value: Replicas; label: string }[] = [
  { value: '2', label: '2' },
  { value: '3', label: '3' },
  { value: '4', label: '4' },
  { value: '5', label: '5' },
];

/** Simulated seconds. */
const REQUEST_INTERVAL_S = 1.8;
const LEG_SPEED = 1.3;
const DROP_VISIBLE_S = 0.7;

const LAYOUT: Layout = {
  clientA: { x: 110, y: 30, w: 170, h: 70 },
  clientB: { x: 680, y: 30, w: 170, h: 70 },
  // Tall enough for a subtitle and three stat rows.
  a: { x: 90, y: 198, w: 230, h: 154 },
  b: { x: 640, y: 198, w: 230, h: 154 },
};

const CLIENT: Record<Side, string> = { a: 'clientA', b: 'clientB' };
const OTHER: Record<Side, Side> = { a: 'b', b: 'a' };
const NAME: Record<Side, string> = { a: 'A', b: 'B' };

type Status = 'ok' | 'stale' | 'refused';

interface Msg {
  kind: Op | 'replicate' | 'answer';
  side: Side;
  /** Replication that the partition drops halfway along the wire. */
  lost?: boolean;
  droppedAt?: number;
}

interface RequestRow {
  id: number;
  side: Side;
  op: Op;
  status: Status;
  version: number;
  latest: number;
}

interface Stats {
  writesOk: number;
  readsOk: number;
  staleReads: number;
  refused: number;
  conflicts: number;
  lostWrites: number;
}

interface SimState {
  clock: number;
  next: Record<Side, number>;
  /** How many requests each client has sent, to alternate reads and writes. */
  sent: Record<Side, number>;
  value: Record<Side, number>;
  /** Highest version handed out; stands in for a write timestamp. */
  version: number;
  /** Writes each side accepted during the current partition - a conflict needs both. */
  sideWrites: Record<Side, number>;
  particles: Particle[];
  rows: RequestRow[];
  nextRow: number;
  lastRead: Record<Side, RequestRow | null>;
  stats: Stats;
}

const createState = (): SimState => ({
  clock: 0,
  next: { a: 0.3, b: 0.3 + REQUEST_INTERVAL_S / 2 },
  sent: { a: 0, b: 0 },
  value: { a: 1, b: 1 },
  version: 1,
  sideWrites: { a: 0, b: 0 },
  particles: [],
  rows: [],
  nextRow: 0,
  lastRead: { a: null, b: null },
  stats: { writesOk: 0, readsOk: 0, staleReads: 0, refused: 0, conflicts: 0, lostWrites: 0 },
});

const msgOf = (particle: Particle) => particle.meta as unknown as Msg;

/** Replicas on each side of the split: side A gets the larger half. */
const splitOf = (replicas: Replicas) => {
  const total = Number(replicas);
  const a = Math.ceil(total / 2);
  return { total, a, b: total - a };
};

export function CapTheoremLab({ focus }: LabProps<'cap-theorem'>) {
  // The page keys this lab by Concept, so the focus never changes under a mounted lab.
  const start = focus ? FOCUS_SETUPS[focus] : DEFAULT_SETUP;
  // Every control lives in one object, so Reset cannot miss one.
  const { setup, setSetup, change } = useLabSetup(start);
  const { choice, partitioned, replicas, traffic } = setup;
  const [running, setRunning] = useLabRunning();
  const sim = useRef<SimState>(createState());
  const rerender = useRerender(30);
  const { events, log, clear } = useEventLog(30);

  const split = splitOf(replicas);
  const hasMajority: Record<Side, boolean> = {
    a: split.a * 2 > split.total,
    b: split.b * 2 > split.total,
  };
  /** Whether a side answers requests right now. */
  const serves = (side: Side) => !partitioned || choice === 'ap' || hasMajority[side];

  const spawn = (route: string[], outcome: RequestOutcome, msg: Msg) => {
    sim.current.particles.push({
      id: nextParticleId(),
      route,
      leg: 0,
      t: 0,
      speed: LEG_SPEED,
      outcome,
      meta: msg as unknown as Record<string, unknown>,
    });
  };

  const send = (side: Side, op: Op) => {
    spawn([CLIENT[side], side], 'success', { kind: op, side });
    // A request sent while paused would sit still on its wire, so a click never does nothing.
    if (!running) setRunning(true);
  };

  const record = (row: Omit<RequestRow, 'id'>) => {
    const state = sim.current;
    state.nextRow += 1;
    const full = { id: state.nextRow, ...row };
    state.rows = [full, ...state.rows].slice(0, 8);
    return full;
  };

  /** A request reached its side: the store decides what to do with it. */
  const handle = (side: Side, op: Op) => {
    const state = sim.current;
    const latest = Math.max(state.value.a, state.value.b);

    if (!serves(side)) {
      state.stats.refused += 1;
      record({ side, op, status: 'refused', version: state.value[side], latest });
      if (op === 'read') state.lastRead[side] = { id: 0, side, op, status: 'refused', version: state.value[side], latest };
      spawn([side, CLIENT[side]], 'failure', { kind: 'answer', side });
      log(
        hasMajority.a || hasMajority.b
          ? `${op === 'write' ? 'Write' : 'Read'} on side ${NAME[side]} refused (503) - it cannot reach a majority`
          : `${op === 'write' ? 'Write' : 'Read'} on side ${NAME[side]} refused (503) - neither side holds a majority`,
        'danger',
      );
      return;
    }

    if (op === 'write') {
      state.version += 1;
      const version = state.version;
      state.value[side] = version;
      state.stats.writesOk += 1;
      if (!partitioned) {
        state.value[OTHER[side]] = version;
        spawn([side, OTHER[side]], 'success', { kind: 'replicate', side });
        log(`Write v${version} on side ${NAME[side]} - replicated to both sides`, 'ok');
      } else {
        state.sideWrites[side] += 1;
        spawn([side, OTHER[side]], 'failure', { kind: 'replicate', side, lost: true });
        log(
          choice === 'ap'
            ? `Write v${version} accepted on side ${NAME[side]} only - side ${NAME[OTHER[side]]} never hears of it`
            : `Write v${version} accepted on side ${NAME[side]} (majority) - side ${NAME[OTHER[side]]} is behind but refuses requests`,
          choice === 'ap' ? 'warn' : 'ok',
        );
      }
      record({ side, op, status: 'ok', version, latest: version });
      spawn([side, CLIENT[side]], 'success', { kind: 'answer', side });
      return;
    }

    const version = state.value[side];
    const stale = version < latest;
    const row = record({ side, op, status: stale ? 'stale' : 'ok', version, latest });
    state.lastRead[side] = row;
    if (stale) {
      state.stats.staleReads += 1;
      log(`Read on side ${NAME[side]} returned v${version}, but v${latest} was already acknowledged - a stale read`, 'warn');
    } else {
      state.stats.readsOk += 1;
    }
    spawn([side, CLIENT[side]], stale ? 'warning' : 'success', { kind: 'answer', side });
  };

  useTicker(running, (dt) => {
    const state = sim.current;
    state.clock += dt;

    for (const side of ['a', 'b'] as Side[]) {
      if (state.clock < state.next[side]) continue;
      state.next[side] = state.clock + REQUEST_INTERVAL_S;
      state.sent[side] += 1;
      const op: Op =
        traffic === 'write-a-read-b' ? (side === 'a' ? 'write' : 'read') : state.sent[side] % 2 === 1 ? 'write' : 'read';
      send(side, op);
    }

    // Replication across a partition never arrives: the dot stops halfway along the cut wire.
    for (const particle of state.particles) {
      const msg = msgOf(particle);
      if (msg.lost && msg.droppedAt === undefined && particle.t >= 0.5) {
        msg.droppedAt = state.clock;
        particle.speed = 0;
      }
    }

    const { alive, finished } = advanceParticles(state.particles, dt);
    state.particles = alive
      .filter((particle) => {
        const dropped = msgOf(particle).droppedAt;
        return dropped === undefined || state.clock - dropped < DROP_VISIBLE_S;
      })
      .slice(-60);
    for (const particle of finished) {
      const msg = msgOf(particle);
      if (msg.kind === 'write' || msg.kind === 'read') handle(msg.side, msg.kind);
    }
    rerender();
  });

  const partition = () => {
    const state = sim.current;
    state.sideWrites = { a: 0, b: 0 };
    setSetup((current) => ({ ...current, partitioned: true }));
    log('Network partition: side A and side B can no longer reach each other', 'danger');
  };

  const heal = () => {
    const state = sim.current;
    const { a, b } = state.value;
    const winner = Math.max(a, b);
    const winnerSide: Side = a >= b ? 'a' : 'b';
    const loserSide = OTHER[winnerSide];
    // A conflict needs writes on BOTH sides. If only one side wrote, the other is
    // merely behind and catches up - nothing is thrown away. This is decided by
    // what happened, not by the current CP/AP choice, which can change mid-partition.
    if (state.sideWrites.a > 0 && state.sideWrites.b > 0) {
      const lost = state.sideWrites[loserSide];
      state.stats.conflicts += 1;
      state.stats.lostWrites += lost;
      log(
        `Partition healed. Both sides took writes: last-write-wins keeps v${winner} from side ${NAME[winnerSide]} and silently discards the ${lost} write${lost === 1 ? '' : 's'} side ${NAME[loserSide]} acknowledged`,
        'danger',
      );
    } else if (a !== b) {
      log(`Partition healed. Side ${NAME[loserSide]} catches up to v${winner} - only one side took writes, so nothing conflicts`, 'ok');
    } else {
      log('Partition healed. Both sides already agree - no conflicts to resolve', 'ok');
    }
    if (a !== b) spawn([winnerSide, loserSide], 'success', { kind: 'replicate', side: winnerSide });
    state.value = { a: winner, b: winner };
    state.sideWrites = { a: 0, b: 0 };
    setSetup((current) => ({ ...current, partitioned: false }));
    rerender();
  };

  const reset = () => {
    sim.current = createState();
    // Back to this Concept's starting setup, not the lab's global default.
    setSetup(start);
    clear();
    rerender();
  };

  const state = sim.current;
  const { stats, value } = state;
  const refusing: Record<Side, boolean> = { a: !serves('a'), b: !serves('b') };
  // A copy that refuses every request cannot be read, so it is not an
  // inconsistency a client can observe. Only two serving sides that disagree are.
  const diverged = value.a !== value.b && !refusing.a && !refusing.b;
  const noMajority = !hasMajority.a && !hasMajority.b;
  const lastB = state.lastRead.b;

  const particleViews: ParticleView[] = state.particles.map((particle) => ({
    id: particle.id,
    from: particle.route[particle.leg],
    to: particle.route[particle.leg + 1],
    t: particle.t,
    outcome: particle.outcome ?? 'success',
  }));

  const edges: DiagramEdge[] = [
    { from: 'clientA', to: 'a', tone: refusing.a ? 'danger' : 'brand' },
    { from: 'clientB', to: 'b', tone: refusing.b ? 'danger' : 'brand' },
    {
      from: 'a',
      to: 'b',
      tone: partitioned ? 'danger' : 'ok',
      dashed: partitioned,
      label: partitioned ? undefined : 'replication',
    },
  ];

  const sideLabel = (side: Side) => {
    const count = split[side];
    const role = hasMajority[side] ? 'majority' : noMajority ? 'no majority' : 'minority';
    return `${count} of ${split.total} replicas - ${role}`;
  };

  const sideStatus = (side: Side) =>
    !partitioned ? 'healthy' : refusing[side] ? 'down' : 'degraded';

  const renderSide = (side: Side) => {
    const read = state.lastRead[side];
    return (
      <ArchNode
        kind="sql"
        title={`Side ${NAME[side]}`}
        subtitle={sideLabel(side)}
        placed={LAYOUT[side]}
        status={sideStatus(side)}
        statusLabel={!partitioned ? undefined : refusing[side] ? 'Refusing' : 'Serving alone'}
        alert={diverged}
      >
        <NodeStatRow label="Value" value={`v${value[side]}`} tone={diverged ? 'text-danger' : 'text-brand'} />
        <NodeStatRow
          label="Writes"
          value={refusing[side] ? 'refused' : 'accepted'}
          tone={refusing[side] ? 'text-danger' : 'text-ok'}
        />
        <NodeStatRow
          label="Last read"
          value={!read ? '-' : read.status === 'refused' ? '503' : read.status === 'stale' ? `v${read.version} stale` : `v${read.version}`}
          tone={!read ? 'text-muted' : read.status === 'ok' ? 'text-ok' : read.status === 'stale' ? 'text-warn' : 'text-danger'}
        />
      </ArchNode>
    );
  };

  return (
    <LabShell
      title="CAP Theorem Lab"
      description="Two clients read and write through the two sides of a replicated store. Split the network and the store must pick: refuse the request, or answer from what this side has and let the sides diverge."
      running={running}
      onRunningChange={setRunning}
      onReset={reset}
      events={events}
      legend={
        <ParticleLegend
          outcomes={[
            { outcome: 'success', label: 'Request, answer or replication' },
            { outcome: 'warning', label: 'Stale read' },
            { outcome: 'failure', label: 'Refused (503) or replication dropped' },
          ]}
        />
      }
      actions={
        <Button variant={partitioned ? 'success' : 'danger'} onClick={partitioned ? heal : partition}>
          {partitioned ? <Cloud className="h-4 w-4" /> : <CloudOff className="h-4 w-4" />}
          {partitioned ? 'Heal partition' : 'Create partition'}
        </Button>
      }
      insight={
        <Insight
          title={
            !partitioned
              ? 'Healthy network'
              : choice === 'ap'
                ? 'Partitioned - behaving as AP'
                : noMajority
                  ? 'Partitioned - CP with no majority anywhere'
                  : 'Partitioned - behaving as CP'
          }
        >
          {!partitioned ? (
            <>
              With no partition there is no dilemma: every write reaches both sides before it is acknowledged, so every
              read returns the latest write and every request gets an answer. CAP only forces a choice while the network
              is split - it describes behaviour during a failure, not a permanent label for a system. Press Create
              partition.
            </>
          ) : choice === 'ap' ? (
            <>
              An AP system keeps answering on both sides, so nobody sees an error - but side B never hears about writes
              made on side A, and the reverse. {stats.staleReads > 0 ? `${stats.staleReads} read${stats.staleReads === 1 ? '' : 's'} so far returned a value older than a write the system had already acknowledged. ` : ''}
              {lastB?.status === 'stale'
                ? `Client B last read v${lastB.version} while v${lastB.latest} already existed on side A. `
                : ''}
              When the partition heals, last-write-wins keeps the newest version and silently throws away the writes
              of the other side. Switch to CP to trade those stale reads for errors.
            </>
          ) : noMajority ? (
            <>
              {split.total} replicas split {split.a} | {split.b}: neither side holds a majority, so a CP system refuses
              every read and every write on both sides - the whole store is unavailable until the partition heals.
              Nothing diverges, but nothing works either. This is why clusters use an odd number of replicas: try 3 or
              5.
            </>
          ) : (
            <>
              A CP system keeps one truth. Side A holds {split.a} of {split.total} replicas, a majority, so it keeps
              serving reads and writes. Side B holds {split.b} and cannot prove its copy is the latest, so it refuses
              both with a 503 - client B is unavailable, but no client ever reads a stale value and no write is lost.
              Switch to AP to see the other answer to the same partition.
            </>
          )}
        </Insight>
      }
      metrics={
        <>
          <MetricsPanel
            items={[
              { key: 'a', label: 'Side A value', value: `v${value.a}`, tone: 'brand', hint: 'Latest version side A holds.' },
              {
                key: 'b',
                label: 'Side B value',
                value: `v${value.b}`,
                unit: refusing.b && value.b !== value.a ? 'not served' : undefined,
                tone: diverged ? 'danger' : value.a !== value.b ? 'warn' : 'brand',
                hint: 'Latest version side B holds. A side that refuses every request never serves its stale copy.',
              },
              {
                key: 'consistent',
                label: 'Consistent',
                value: diverged ? 'No' : 'Yes',
                tone: diverged ? 'danger' : 'ok',
                hint: 'Could two clients read two different values right now? A side that refuses requests cannot be read.',
              },
              {
                key: 'stale',
                label: 'Stale reads',
                value: stats.staleReads,
                tone: stats.staleReads > 0 ? 'warn' : 'ok',
                hint: 'Reads that returned a version older than one the system had already acknowledged.',
              },
              {
                key: 'refused',
                label: 'Refused (503)',
                value: stats.refused,
                tone: stats.refused > 0 ? 'danger' : 'ok',
                hint: 'Requests a side answered with an error because it could not reach a majority.',
              },
              {
                key: 'lost',
                label: 'Writes lost at heal',
                value: stats.lostWrites,
                tone: stats.lostWrites > 0 ? 'danger' : 'ok',
                hint: 'Acknowledged writes that last-write-wins discarded when both sides had written during a partition.',
              },
            ]}
          />

          <div className="card p-4">
            <p className="label mb-3">The triangle</p>
            <pre className="ascii">{`               Consistency
                    ^
                   / \\
        ${choice === 'cp' ? '>> CP <<' : '   CP   '}  /   \\
                 /     \\
                /       \\   ${choice === 'ap' ? '>> AP <<' : '   AP   '}
               v---------v
   Availability            Partition tolerance

Networks partition, so "CA" is not an option for a
distributed system - you are choosing CP or AP.`}</pre>
          </div>

          <div className="card p-4">
            <p className="label mb-3">Recent requests</p>
            {state.rows.length === 0 ? (
              <p className="text-sm text-muted">The clients send a request every {REQUEST_INTERVAL_S} s, or use the buttons.</p>
            ) : (
              <ul className="space-y-1.5 font-mono text-[11px]">
                {state.rows.map((row) => (
                  <li key={row.id} className={row.status === 'refused' ? 'text-danger' : 'text-muted'}>
                    <span className="text-faint">client {NAME[row.side]}</span> {row.op}{' '}
                    {row.status === 'refused' ? '' : `v${row.version}`}{' '}
                    <Badge tone={row.status === 'ok' ? 'ok' : row.status === 'stale' ? 'warn' : 'danger'} className="ml-1">
                      {row.status === 'refused' ? '503 Unavailable' : row.status === 'stale' ? '200 stale' : '200 OK'}
                    </Badge>{' '}
                    <span className="text-faint">
                      {row.status === 'stale'
                        ? `v${row.latest} already acknowledged`
                        : row.status === 'refused'
                          ? 'no majority on this side'
                          : row.op === 'write'
                            ? partitioned
                              ? 'this side only'
                              : 'on both sides'
                            : 'latest value'}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-3 text-xs text-faint">
              Simplified model: each side stands for a group of replicas, versions come from one counter that stands in for
              a write timestamp, and with no partition replication is instant.
            </p>
          </div>
        </>
      }
      controls={
        <>
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted">During a partition, prefer</p>
            <SegmentedControl
              value={choice}
              className="w-full"
              size="sm"
              options={[
                { value: 'cp', label: 'CP - consistency' },
                { value: 'ap', label: 'AP - availability' },
              ]}
              onChange={(next) => {
                change('choice')(next);
                log(
                  next === 'cp'
                    ? 'CP: refuse what cannot be answered safely'
                    : 'AP: answer everywhere and reconcile later',
                  'info',
                );
              }}
            />
            <p className="text-[11px] text-faint">
              {choice === 'cp'
                ? 'Refuse the request and keep a single truth.'
                : 'Answer the request and allow the sides to disagree.'}
            </p>
          </div>

          <div className="space-y-2">
            <p className="text-xs font-medium text-muted">Replicas in the cluster</p>
            <SegmentedControl
              value={replicas}
              className="w-full"
              size="sm"
              options={REPLICA_OPTIONS}
              onChange={change('replicas')}
            />
            <p className="text-[11px] text-faint">
              A partition splits them {split.a} | {split.b}.{' '}
              {noMajority ? 'Neither side has a majority.' : `Side A has a majority (${split.a} of ${split.total}).`}
            </p>
          </div>

          <div className="space-y-2">
            <p className="text-xs font-medium text-muted">What the clients send</p>
            <SegmentedControl
              value={traffic}
              className="w-full"
              size="sm"
              options={[
                { value: 'mixed', label: 'Reads and writes' },
                { value: 'write-a-read-b', label: 'A writes, B reads' },
              ]}
              onChange={change('traffic')}
            />
          </div>

          <div className="space-y-2">
            <p className="text-xs font-medium text-muted">Send one request now</p>
            <div className="grid grid-cols-2 gap-2">
              <Button className="justify-center" onClick={() => send('a', 'write')}>
                Write on A
              </Button>
              <Button className="justify-center" onClick={() => send('b', 'write')}>
                Write on B
              </Button>
              <Button className="justify-center" onClick={() => send('a', 'read')}>
                Read on A
              </Button>
              <Button className="justify-center" onClick={() => send('b', 'read')}>
                Read on B
              </Button>
            </div>
          </div>

          <div className="border-t border-line pt-4 text-[11px] text-muted">
            <p className="label mb-2">Where this shows up</p>
            <ul className="space-y-1">
              <li>CP: ZooKeeper, etcd, Spanner - they refuse rather than diverge</li>
              <li>AP: Cassandra at consistency level ONE, DNS, CDN caches</li>
              <li>Tunable: Cassandra per query, DynamoDB per read</li>
            </ul>
          </div>
        </>
      }
    >
      <DiagramCanvas layout={LAYOUT} edges={edges} particles={particleViews} height={400} className="bg-canvas">
        <ArchNode kind="client" title="Client A" placed={LAYOUT.clientA} compact />
        <ArchNode kind="client" title="Client B" placed={LAYOUT.clientB} compact />
        {renderSide('a')}
        {renderSide('b')}

        {partitioned ? (
          <div
            className={cn(
              'absolute left-1/2 top-[222px] -translate-x-1/2 rounded-lg border border-danger bg-surface px-3 py-1.5',
              'font-mono text-[11px] font-semibold text-danger',
            )}
          >
            X NETWORK PARTITION X
          </div>
        ) : null}
      </DiagramCanvas>
    </LabShell>
  );
}

export default CapTheoremLab;
