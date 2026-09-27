import { useCallback, useRef, useState } from 'react';
import { ArchNode, DiagramCanvas, NodeStatRow, ParticleLegend, type DiagramEdge, type Layout, type ParticleView } from '@/components/architecture';
import { LiveChart } from '@/components/charts';
import { Insight, LabShell, MetricsPanel, SIMULATED_HINT } from '@/components/learning';
import { Meter, Slider, Toggle } from '@/components/ui';
import {
  MetricWindow,
  RateCounter,
  advanceParticles,
  nextParticleId,
  useEventLog,
  useSeries,
  useTicker,
  visualShare,
  type Particle,
} from '@/simulations/engine';
import { useRerender } from '@/hooks/useRerender';
import { sampleArrivals } from '@/utils/math';
import { formatLatency, formatNumber, formatPercent } from '@/utils/format';
import { cn } from '@/utils/cn';
import { useLabRunning } from '@/hooks/useLabRunning';

/*
 * Simplified database model - chosen to teach, not measured:
 *
 * - The database has 8 cores. About half of each query is CPU and half is
 *   waiting on disk, so it does its best work with about 2 x cores = 16 queries
 *   in flight. Up to 16, every query runs at full speed.
 * - Past 16, the cores are shared (each query slows by 16 / in-flight) and
 *   every extra query also costs context switches and lock contention, so the
 *   total work done falls: at 200 queries in flight the database does about
 *   30% of the work it does at 16.
 * - A new connection costs 22 ms of network round trips (TCP, TLS, auth) plus
 *   3 ms of database work (forking a backend and authenticating): ~25 ms.
 * - max_connections is 200. The fleet of pools is modelled as one shared queue:
 *   the instances are identical and get equal load, so their pools behave alike.
 */
const DB_CORES = 8;
const BEST_IN_FLIGHT = DB_CORES * 2;
const CONTENTION = 0.2;
const MAX_CONNECTIONS = 200;
const HANDSHAKE_MS = 22;
const SETUP_WORK_MS = 3;
/** Simulation sub-step. Queries last a few ms, so a 16 ms frame is split up. */
const SUBSTEP_MS = 2;
/** A request that waited longer than this for a connection is drawn as a triangle. */
const WAIT_MARK_MS = 10;

interface Setup {
  pooling: boolean;
  instances: number;
  poolSize: number;
  load: number;
  queryMs: number;
  timeoutMs: number;
}

/** A healthy start: 4 instances x 5 connections = 20, close to what 8 cores use well. */
const DEFAULT_SETUP: Setup = {
  pooling: true,
  instances: 4,
  poolSize: 5,
  load: 1200,
  queryMs: 5,
  timeoutMs: 1000,
};

interface Query {
  /** When the request arrived, in simulation ms. */
  start: number;
  /** Database work still to do, in ms at full speed. */
  remaining: number;
}

interface Connecting {
  start: number;
  readyAt: number;
}

interface SimState {
  now: number;
  /** Arrival times of requests waiting for a free pooled connection (FIFO). */
  queue: number[];
  queueHead: number;
  /** New connections still in their handshake (no pool). */
  connecting: Connecting[];
  /** Queries running on the database, each holding one connection. */
  active: Query[];
  particles: Particle[];
  completed: RateCounter;
  timeouts: RateCounter;
  refused: RateCounter;
  latency: MetricWindow;
  wait: MetricWindow;
  flags: { waiting: boolean; timingOut: boolean; refused: boolean; contention: boolean; overLimit: boolean };
  nextCheck: number;
}

const createState = (): SimState => ({
  now: 0,
  queue: [],
  queueHead: 0,
  connecting: [],
  active: [],
  particles: [],
  completed: new RateCounter(2000),
  timeouts: new RateCounter(2000),
  refused: new RateCounter(2000),
  latency: new MetricWindow(600),
  wait: new MetricWindow(600),
  flags: { waiting: false, timingOut: false, refused: false, contention: false, overLimit: false },
  nextCheck: 500,
});

/** Share of full speed each running query gets with `inFlight` queries on the database. */
function querySpeed(inFlight: number) {
  if (inFlight <= BEST_IN_FLIGHT) return 1;
  return BEST_IN_FLIGHT / inFlight / contentionFactor(inFlight);
}

/** How much slower the whole database gets from context switches and locks. 1 = none. */
function contentionFactor(inFlight: number) {
  return 1 + (CONTENTION * Math.max(0, inFlight - BEST_IN_FLIGHT)) / BEST_IN_FLIGHT;
}

const LAYOUT: Layout = {
  users: { x: 16, y: 110, w: 120, h: 80 },
  api: { x: 206, y: 80, w: 180, h: 140 },
  pool: { x: 456, y: 36, w: 224, h: 228 },
  db: { x: 750, y: 58, w: 194, h: 184 },
};

export function ConnectionPoolLab() {
  const [setup, setSetup] = useState(DEFAULT_SETUP);
  const { pooling, instances, poolSize, load, queryMs, timeoutMs } = setup;
  const change =
    <K extends keyof Setup>(key: K) =>
    (value: Setup[K]) =>
      setSetup((current) => ({ ...current, [key]: value }));

  const [running, setRunning] = useLabRunning();
  const state = useRef<SimState>(createState());
  const rerender = useRerender(30);
  const { events, log, clear } = useEventLog();
  const { points, push, reset: resetSeries } = useSeries(60, 400);

  const requested = instances * poolSize;
  const usable = Math.min(requested, MAX_CONNECTIONS);

  const reset = useCallback(() => {
    state.current = createState();
    setSetup(DEFAULT_SETUP);
    clear();
    resetSeries();
  }, [clear, resetSeries]);

  useTicker(running, (dt) => {
    const sim = state.current;
    const share = visualShare(load, 14);
    const emit = (route: string[], outcome: Particle['outcome']) => {
      if (Math.random() >= share) return;
      sim.particles.push({ id: nextParticleId(), route, leg: 0, t: 0, speed: 1.5 + Math.random() * 0.4, outcome });
    };

    const steps = Math.max(1, Math.round((dt * 1000) / SUBSTEP_MS));
    const h = (dt * 1000) / steps;
    for (let step = 0; step < steps; step += 1) {
      sim.now += h;
      const now = sim.now;

      // 1. New requests arrive at the instances.
      const count = sampleArrivals(load, h / 1000);
      for (let index = 0; index < count; index += 1) {
        if (pooling) {
          sim.queue.push(now);
        } else if (sim.connecting.length + sim.active.length < MAX_CONNECTIONS) {
          sim.connecting.push({ start: now, readyAt: now + HANDSHAKE_MS });
          emit(['users', 'api', 'db'], 'success');
        } else {
          // PostgreSQL answers "sorry, too many clients already".
          sim.refused.add(1, now);
          emit(['users', 'api', 'db'], 'failure');
        }
      }

      // 2. Handshakes that finished become queries (they also pay the backend setup work).
      if (sim.connecting.length) {
        const still: Connecting[] = [];
        for (const item of sim.connecting) {
          if (item.readyAt <= now) sim.active.push({ start: item.start, remaining: queryMs + SETUP_WORK_MS });
          else still.push(item);
        }
        sim.connecting = still;
      }

      // 3. Waiting requests past the acquire timeout fail fast.
      while (sim.queueHead < sim.queue.length && now - sim.queue[sim.queueHead] > timeoutMs) {
        sim.queueHead += 1;
        sim.timeouts.add(1, now);
        emit(['users', 'api', 'pool'], 'failure');
      }

      // 4. Free pooled connections are lent to the oldest waiting requests.
      if (pooling) {
        while (sim.queueHead < sim.queue.length && sim.active.length + sim.connecting.length < usable) {
          const arrived = sim.queue[sim.queueHead];
          sim.queueHead += 1;
          const waited = now - arrived;
          sim.wait.push(waited, now);
          sim.active.push({ start: arrived, remaining: queryMs });
          emit(['users', 'api', 'pool', 'db'], waited > WAIT_MARK_MS ? 'warning' : 'success');
        }
      } else if (sim.queueHead < sim.queue.length) {
        // The pool was just switched off: whoever was waiting now tries to connect directly.
        while (sim.queueHead < sim.queue.length) {
          const arrived = sim.queue[sim.queueHead];
          sim.queueHead += 1;
          if (sim.connecting.length + sim.active.length < MAX_CONNECTIONS) {
            sim.connecting.push({ start: arrived, readyAt: now + HANDSHAKE_MS });
          } else {
            sim.refused.add(1, now);
          }
        }
      }
      if (sim.queueHead > 4000) {
        sim.queue = sim.queue.slice(sim.queueHead);
        sim.queueHead = 0;
      }

      // 5. The database works on every running query at once.
      if (sim.active.length) {
        const progress = h * querySpeed(sim.active.length);
        const still: Query[] = [];
        for (const query of sim.active) {
          query.remaining -= progress;
          if (query.remaining > 0) {
            still.push(query);
          } else {
            sim.completed.add(1, now);
            sim.latency.push(now - query.start, now);
          }
        }
        sim.active = still;
      }
    }

    const { alive } = advanceParticles(sim.particles, dt);
    sim.particles = alive.slice(-80);

    const now = sim.now;
    if (now >= sim.nextCheck) {
      sim.nextCheck = now + 500;
      const waitAvg = sim.wait.snapshot(now).avg ?? 0;
      const next = {
        waiting: pooling && waitAvg > 5,
        timingOut: sim.timeouts.rate(now) > 0,
        refused: sim.refused.rate(now) > 0,
        contention: sim.active.length > BEST_IN_FLIGHT * 2,
        overLimit: pooling && requested > MAX_CONNECTIONS,
      };
      const flags = sim.flags;
      if (next.overLimit && !flags.overLimit)
        log(`Pools ask for ${requested} connections, max_connections is ${MAX_CONNECTIONS}: ${requested - MAX_CONNECTIONS} are refused`, 'danger');
      if (next.waiting && !flags.waiting) log(`Pool exhausted: requests wait ${formatLatency(waitAvg)} on average for a connection`, 'warn');
      if (!next.waiting && flags.waiting) log('Waiting for connections is back near zero', 'ok');
      if (next.timingOut && !flags.timingOut) log(`Requests hit the ${formatLatency(timeoutMs)} acquire timeout and fail fast`, 'danger');
      if (!next.timingOut && flags.timingOut) log('No more acquire timeouts', 'ok');
      if (next.refused && !flags.refused) log(`Database refused new connections: all ${MAX_CONNECTIONS} are in use`, 'danger');
      if (!next.refused && flags.refused) log('Database accepts new connections again', 'ok');
      if (next.contention && !flags.contention)
        log(`${sim.active.length} queries in flight on ${DB_CORES} cores: contention is eating throughput`, 'warn');
      if (!next.contention && flags.contention) log('Queries in flight back near what the cores can use', 'ok');
      sim.flags = next;
    }

    push(
      {
        throughput: sim.completed.rate(now),
        errors: sim.timeouts.rate(now) + sim.refused.rate(now),
        p95: sim.latency.snapshot(now).p95 ?? NaN,
      },
      now,
    );
    rerender();
  });

  // Read straight from the simulation ref: the ticker re-renders at a capped rate.
  const sim = state.current;
  const now = sim.now;
  const inFlight = sim.active.length;
  const waiting = sim.queue.length - sim.queueHead;
  const throughput = sim.completed.rate(now);
  const errorRate = sim.timeouts.rate(now) + sim.refused.rate(now);
  const latency = sim.latency.snapshot(now);
  const waitAvg = sim.wait.snapshot(now).avg;
  const openConnections = pooling ? Math.max(usable, inFlight + sim.connecting.length) : inFlight + sim.connecting.length;
  const lostToContention = 1 - 1 / contentionFactor(inFlight);
  const busyPerPool = pooling ? Math.min(poolSize, Math.round(Math.min(inFlight, usable) / instances)) : 0;

  const particleViews: ParticleView[] = sim.particles.map((particle) => ({
    id: particle.id,
    from: particle.route[particle.leg],
    to: particle.route[particle.leg + 1],
    t: particle.t,
    outcome: particle.outcome ?? 'success',
  }));

  const edges: DiagramEdge[] = pooling
    ? [
        { from: 'users', to: 'api', tone: 'brand' },
        { from: 'api', to: 'pool', tone: waiting > 0 ? 'warn' : 'brand' },
        { from: 'pool', to: 'db', tone: inFlight > BEST_IN_FLIGHT * 2 ? 'danger' : 'ok' },
      ]
    : [
        { from: 'users', to: 'api', tone: 'brand' },
        { from: 'api', to: 'db', tone: errorRate > 0 ? 'danger' : 'warn', label: 'new connection per request', labelT: 0.45 },
      ];
  const layout: Layout = pooling ? LAYOUT : { users: LAYOUT.users, api: LAYOUT.api, db: LAYOUT.db };

  return (
    <LabShell
      title="Connection Pool Lab"
      description="App instances borrow database connections from a pool. Size the pool, push the load and slow the queries, and watch where requests wait - in the pool, or inside an overloaded database."
      running={running}
      onRunningChange={setRunning}
      onReset={reset}
      events={events}
      legend={
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
          <ParticleLegend outcomes={['success', 'warning', 'failure']} />
          <span className="text-[11px] text-faint">
            Triangle: waited over {WAIT_MARK_MS} ms for a connection. Cross: timed out or refused.
          </span>
        </div>
      }
      insight={
        <Insight>
          {!pooling ? (
            errorRate > 0 ? (
              <>
                Without a pool nothing limits how many connections the instances open. The database is past what its{' '}
                {DB_CORES} cores can serve, so queries take longer, connections pile up to all {MAX_CONNECTIONS}, and
                every new request is refused. A pool would have made the extra requests wait in the app instead.
              </>
            ) : (
              <>
                Every request opens its own connection: about {HANDSHAKE_MS + SETUP_WORK_MS} ms of handshakes and a new
                database backend, before a {queryMs} ms query. p95 is {formatLatency(latency.p95)} - most of it is
                connection setup. Turn the pool back on and the same query costs only its own time.
              </>
            )
          ) : requested > MAX_CONNECTIONS ? (
            <>
              {instances} instances x {poolSize} connections = {requested} connections, but max_connections is{' '}
              {MAX_CONNECTIONS}. The last pools to connect are refused. Multiply pool size by instance count before you
              scale out, or put a shared pooler such as PgBouncer in front of the database.
            </>
          ) : inFlight > BEST_IN_FLIGHT * 2 ? (
            <>
              The pools let {inFlight} queries into a database with {DB_CORES} cores that works best with about{' '}
              {BEST_IN_FLIGHT}. The extra ones only context-switch and fight over locks: {formatPercent(lostToContention)}{' '}
              of its work is lost and every query slows down. Shrink the pools - fewer connections serve more requests
              here.
            </>
          ) : errorRate > 0 ? (
            <>
              Every connection is busy and requests fail after waiting {formatLatency(timeoutMs)} - the acquire timeout
              turns a hang into a fast error. {inFlight < BEST_IN_FLIGHT
                ? `The database has only ${inFlight} queries in flight and could take more, so a bigger pool helps here.`
                : 'The database is already at what its cores can do, so a bigger pool will not help: reduce the load or make the queries faster.'}
            </>
          ) : waitAvg !== null && waitAvg > 5 ? (
            <>
              Requests wait {formatLatency(waitAvg)} on average for a free connection. Pool exhaustion shows up as
              latency, while the database itself looks calm. Raise the pool a little, or make the queries shorter.
            </>
          ) : (
            <>
              {usable} connections are opened once and reused: each request pays only its {queryMs} ms query, not a new
              connection. Now push the load up, make the queries slower, or give each instance a pool of 50.
            </>
          )}
        </Insight>
      }
      metrics={
        <>
          <MetricsPanel
            items={[
              { key: 'throughput', label: 'Throughput', value: formatNumber(throughput), unit: 'req/s', tone: 'ok', simulated: true },
              {
                key: 'p95',
                label: 'p95 latency',
                value: formatLatency(latency.p95),
                tone: latency.p95 !== null && latency.p95 > 200 ? 'danger' : 'neutral',
                simulated: true,
              },
              {
                key: 'wait',
                label: 'Avg wait for connection',
                value: pooling ? formatLatency(waitAvg) : `${HANDSHAKE_MS + SETUP_WORK_MS} ms setup`,
                tone: pooling && waitAvg !== null && waitAvg > 5 ? 'warn' : 'neutral',
                hint: pooling
                  ? 'Time a request spent waiting for a free pooled connection.'
                  : 'Without a pool every request opens a new connection first.',
                simulated: true,
              },
              {
                key: 'failed',
                label: 'Errors',
                value: formatNumber(errorRate),
                unit: 'req/s',
                tone: errorRate > 0 ? 'danger' : 'ok',
                hint: 'Requests that hit the acquire timeout, or were refused because the database had no connection slot left.',
                simulated: true,
              },
              {
                key: 'connections',
                label: 'DB connections',
                value: `${formatNumber(Math.min(openConnections, MAX_CONNECTIONS))} / ${MAX_CONNECTIONS}`,
                tone: openConnections >= MAX_CONNECTIONS ? 'danger' : 'neutral',
                hint: 'Connections open on the database, against max_connections.',
                simulated: true,
              },
              {
                key: 'inflight',
                label: 'Queries in flight',
                value: formatNumber(inFlight),
                tone: inFlight > BEST_IN_FLIGHT * 2 ? 'danger' : inFlight > BEST_IN_FLIGHT ? 'warn' : 'ok',
                hint: `Queries running on the database at once. This model works best at about ${BEST_IN_FLIGHT} (2 x ${DB_CORES} cores).`,
                simulated: true,
              },
            ]}
          />
          <div className="card p-4">
            <p className="label mb-3">Throughput and errors</p>
            <LiveChart
              data={points}
              series={[
                { key: 'throughput', label: 'Served req/s', color: 'ok' },
                { key: 'errors', label: 'Errors req/s', color: 'danger' },
              ]}
              height={140}
            />
            <LiveChart data={points} series={[{ key: 'p95', label: 'p95 latency (ms)', color: 'violet' }]} variant="line" height={140} />
            <p className="mt-2 text-xs text-faint">
              {SIMULATED_HINT} {DB_CORES} database cores that work best with about {BEST_IN_FLIGHT}{' '}
              queries in flight and lose work to contention past that, a new connection that costs about{' '}
              {HANDSHAKE_MS + SETUP_WORK_MS} ms, and max_connections {MAX_CONNECTIONS}. All instances get equal load, so
              their pools are modelled as one.
            </p>
          </div>
        </>
      }
      controls={
        <>
          <Toggle
            label="Connection pool"
            checked={pooling}
            onChange={(value) => {
              change('pooling')(value);
              log(value ? 'Pool on: connections are opened once and reused' : 'Pool off: every request opens its own connection', 'info');
            }}
            description="Off: every request connects, queries, then disconnects"
          />
          <Slider
            label="App instances"
            value={instances}
            min={1}
            max={12}
            onChange={change('instances')}
            format={(value) => `${value}`}
            hint="Each instance keeps its own pool."
          />
          <Slider
            label="Pool size per instance"
            value={poolSize}
            min={1}
            max={50}
            onChange={change('poolSize')}
            disabled={!pooling}
            tone={pooling && requested > MAX_CONNECTIONS ? 'danger' : 'brand'}
            format={(value) => `${value} connections`}
            hint={`Fleet total: ${instances} x ${poolSize} = ${requested} of ${MAX_CONNECTIONS} allowed.`}
          />
          <Slider
            label="Load"
            value={load}
            min={100}
            max={3000}
            step={50}
            onChange={change('load')}
            format={(value) => `${formatNumber(value)} req/s`}
            hint="Requests per second across all instances, one query each."
          />
          <Slider
            label="Query time"
            value={queryMs}
            min={1}
            max={50}
            onChange={change('queryMs')}
            format={(value) => `${value} ms`}
            hint="How long one query takes on a database that is not overloaded."
          />
          <Slider
            label="Acquire timeout"
            value={timeoutMs}
            min={100}
            max={5000}
            step={100}
            onChange={change('timeoutMs')}
            disabled={!pooling}
            format={(value) => formatLatency(value)}
            hint="How long a request waits for a free connection before failing fast."
          />
        </>
      }
    >
      <DiagramCanvas layout={layout} edges={edges} particles={particleViews} height={300} className="bg-canvas">
        <ArchNode kind="client" title="Users" subtitle={`${formatNumber(load)} req/s`} placed={LAYOUT.users} compact />
        <ArchNode kind="server" title={`API x${instances}`} subtitle="identical instances" placed={LAYOUT.api} compact>
          <NodeStatRow label="Per instance" value={`${formatNumber(load / instances)}/s`} />
          <NodeStatRow label="Query" value={`${queryMs} ms`} />
          {pooling ? (
            <NodeStatRow label="Pool each" value={`${poolSize} conns`} />
          ) : (
            <NodeStatRow label="Connecting" value={formatNumber(sim.connecting.length)} tone="text-warn" />
          )}
        </ArchNode>
        {pooling ? (
          <ArchNode
            kind="queue"
            title="Connection pool"
            subtitle={`in each instance: ${instances} x ${poolSize}`}
            placed={LAYOUT.pool}
            alert={waiting > 0}
            status={errorRate > 0 ? 'degraded' : 'healthy'}
          >
            <p className="text-[11px] text-faint">One pool, busy / idle</p>
            <div className="flex flex-wrap gap-[3px]" aria-label={`${busyPerPool} of ${poolSize} connections busy`}>
              {Array.from({ length: poolSize }, (_, index) => (
                <span
                  key={index}
                  className={cn('h-2.5 w-2.5 rounded-[2px]', index < busyPerPool ? 'bg-brand' : 'border border-line bg-elevated')}
                />
              ))}
            </div>
            <NodeStatRow label="Waiting" value={formatNumber(waiting)} tone={waiting > 0 ? 'text-warn' : 'text-ink'} />
            <NodeStatRow label="Avg wait" value={formatLatency(waitAvg)} />
            <NodeStatRow
              label="Timeouts"
              value={`${formatNumber(sim.timeouts.rate(now))}/s`}
              tone={sim.timeouts.rate(now) > 0 ? 'text-danger' : 'text-ok'}
            />
          </ArchNode>
        ) : null}
        <ArchNode
          kind="sql"
          title="PostgreSQL"
          subtitle={`${DB_CORES} cores, max ${MAX_CONNECTIONS} conns`}
          placed={LAYOUT.db}
          alert={inFlight > BEST_IN_FLIGHT * 2 || openConnections >= MAX_CONNECTIONS}
          status={errorRate > 0 || inFlight > BEST_IN_FLIGHT * 2 ? 'degraded' : 'healthy'}
        >
          <Meter label="Connections" value={Math.min(1, openConnections / MAX_CONNECTIONS)} />
          <NodeStatRow
            label="In flight"
            value={`${formatNumber(inFlight)} (best ~${BEST_IN_FLIGHT})`}
            tone={inFlight > BEST_IN_FLIGHT * 2 ? 'text-danger' : 'text-ink'}
          />
          <NodeStatRow
            label="Lost to contention"
            value={formatPercent(lostToContention)}
            tone={lostToContention > 0.2 ? 'text-danger' : 'text-ink'}
          />
          <NodeStatRow
            label="Refused"
            value={pooling ? `${Math.max(0, requested - MAX_CONNECTIONS)} pool conns` : `${formatNumber(sim.refused.rate(now))}/s`}
            tone={(pooling ? requested > MAX_CONNECTIONS : sim.refused.rate(now) > 0) ? 'text-danger' : 'text-ok'}
          />
        </ArchNode>
      </DiagramCanvas>
    </LabShell>
  );
}

export default ConnectionPoolLab;
