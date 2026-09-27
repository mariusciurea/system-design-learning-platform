import { useCallback, useMemo, useRef, useState } from 'react';
import { Power, RotateCw } from 'lucide-react';
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
import { LiveChart } from '@/components/charts';
import { Insight, LabShell, MetricsPanel, RequestInspector } from '@/components/learning';
import { Button, Meter, Select, Slider, Stepper, Toggle } from '@/components/ui';
import {
  advanceParticles,
  MetricWindow,
  nextParticleId,
  RateCounter,
  useEventLog,
  useSeries,
  useTicker,
  visualShare,
  type Particle,
} from '@/simulations/engine';
import { computeLoad } from '@/simulations/models/load';
import { useLabSetup } from '@/hooks/useLabSetup';
import { useRerender } from '@/hooks/useRerender';
import { clamp, sampleArrivals } from '@/utils/math';
import { formatLatency, formatNumber, formatPercent } from '@/utils/format';
import type { LabFocus, LabProps, NodeStatus, SimulatedRequest } from '@/types';
import { useLabRunning } from '@/hooks/useLabRunning';

type Algorithm = 'round-robin' | 'weighted' | 'least-connections' | 'random';

const ALGORITHMS: { value: Algorithm; label: string }[] = [
  { value: 'round-robin', label: 'Round Robin' },
  { value: 'weighted', label: 'Weighted Round Robin' },
  { value: 'least-connections', label: 'Least Connections' },
  { value: 'random', label: 'Random' },
];

const algorithmLabel = (algorithm: Algorithm) => ALGORITHMS.find((item) => item.value === algorithm)?.label ?? '';

const ALGORITHM_NOTE: Record<Algorithm, string> = {
  'round-robin': 'Each server takes the next request in turn. Even distribution, but it ignores how busy a server is. Turn on "Server 1 is slow" and compare it with Least Connections.',
  weighted: 'Bigger servers receive proportionally more requests. Server 1 has weight 3 (a machine three times the size), the rest weight 1.',
  'least-connections': 'The server with the fewest in-flight requests wins, so slow servers stop receiving new work.',
  random: 'Uniformly random choice. Close to Round Robin at high volume, with no shared counter.',
};

/** Every control of the lab, in one object so Reset cannot miss one. */
interface Setup {
  traffic: number;
  serverCount: number;
  algorithm: Algorithm;
  capacity: number;
  duration: number;
  slowFirst: boolean;
  healthChecks: boolean;
  /** Seconds between two probes of the same server. */
  intervalSec: number;
  /** Consecutive failed probes before the balancer ejects a server. */
  failThreshold: number;
}

/** What the lab opens on at /labs/load-balancer, with no Lab focus. */
const DEFAULT_SETUP: Setup = {
  traffic: 500,
  serverCount: 3,
  algorithm: 'round-robin',
  capacity: 400,
  duration: 80,
  slowFirst: false,
  healthChecks: true,
  // HAProxy defaults: a probe every 2 s, 3 failures to mark a server down, 2 passes to bring it back.
  intervalSec: 2,
  failThreshold: 3,
};

/**
 * The Lab focus of each Concept that hosts this lab. Load Balancing opens on the
 * algorithms: Server 1 is slow and Round Robin keeps feeding it its full third,
 * so it saturates at 750 req/sec while the pool as a whole has room (1,000);
 * one switch to Least Connections fixes it. Health Checks opens on a healthy
 * pool with probes on, ready for the learner to kill a server.
 */
const FOCUS_SETUPS: Record<LabFocus<'load-balancer'>, Setup> = {
  'load-balancing': { ...DEFAULT_SETUP, traffic: 750, slowFirst: true },
  // The same as the default today, on purpose: spelled out so it stays on probes if the default moves.
  'health-checks': { ...DEFAULT_SETUP, healthChecks: true, intervalSec: 2, failThreshold: 3 },
};

/** Consecutive passing probes before an ejected server is readmitted. */
const RISE_THRESHOLD = 2;
/** How long a restarted server takes before its process answers at all. */
const BOOT_MS = 2000;

interface ServerModel {
  id: string;
  name: string;
  /** Whether the process itself is up. `down` = crashed, `starting` = booting. */
  status: NodeStatus;
  /** Whether the load balancer sends it traffic. Separate from `status`: that gap is the lesson. */
  inPool: boolean;
  weight: number;
  rate: RateCounter;
  /** Smoothed values used for display. */
  cpu: number;
  latency: number;
  active: number;
  /** 0..1 share of this server's requests currently failing. */
  errorRate: number;
  handled: number;
  failed: number;
  restartAt: number | null;
  /** When the next probe fires; null until the first tick schedules it. */
  nextProbeAt: number | null;
  failStreak: number;
  passStreak: number;
  /** When it crashed, and how many requests the balancer sent it since. */
  crashedAt: number | null;
  failedSinceCrash: number;
}

interface SimState {
  servers: ServerModel[];
  particles: Particle[];
  /** Particle ids that are health probes, drawn ringed and not inspectable. */
  probes: Set<number>;
  requests: Map<number, SimulatedRequest>;
  handled: number;
  failed: number;
  weightCursor: number;
  cursor: number;
  latency: MetricWindow;
  accepted: RateCounter;
  rejected: RateCounter;
}

const makeServer = (index: number): ServerModel => ({
  id: `s${index}`,
  name: `Server ${index + 1}`,
  status: 'healthy',
  inPool: true,
  weight: index === 0 ? 3 : 1,
  rate: new RateCounter(2000),
  cpu: 0,
  latency: 0,
  active: 0,
  errorRate: 0,
  handled: 0,
  failed: 0,
  restartAt: null,
  nextProbeAt: null,
  failStreak: 0,
  passStreak: 0,
  crashedAt: null,
  failedSinceCrash: 0,
});

const createState = (count: number): SimState => ({
  servers: Array.from({ length: count }, (_, index) => makeServer(index)),
  particles: [],
  probes: new Set(),
  requests: new Map(),
  handled: 0,
  failed: 0,
  weightCursor: 0,
  cursor: 0,
  latency: new MetricWindow(500),
  accepted: new RateCounter(2000),
  rejected: new RateCounter(2000),
});

const ENDPOINTS = ['/api/products/42', '/api/orders', '/api/users/me', '/api/search?q=shoes', '/api/cart'];

/**
 * Hard ceiling on particles alive at once, so the canvas stays readable. It is
 * a safety net, not the throttle: arrivals are Poisson, so the budget sits
 * above the steady-state population to keep the net from clipping every frame.
 */
const PARTICLE_BUDGET = 110;
/**
 * Requests animated per second. A route here takes about 1.2s to walk, so this
 * settles at roughly 85 particles on screen, peaking near 95.
 */
const ANIMATED_PER_SECOND = 70;
/** Sized above PARTICLE_BUDGET so no visible particle outlives its record. */
const INSPECTABLE_REQUESTS = 140;

export function LoadBalancerLab({ focus }: LabProps<'load-balancer'>) {
  // The page keys this lab by Concept, so the focus never changes under a mounted lab.
  const start = focus ? FOCUS_SETUPS[focus] : DEFAULT_SETUP;
  const { setup, setSetup, change } = useLabSetup(start);
  const { traffic, serverCount, algorithm, capacity, duration, slowFirst, healthChecks, intervalSec, failThreshold } =
    setup;

  const [running, setRunning] = useLabRunning();
  const [inspected, setInspected] = useState<SimulatedRequest | null>(null);

  const sim = useRef<SimState | null>(null);
  if (sim.current === null) sim.current = createState(start.serverCount);
  const rerender = useRerender(30);
  const { events, log, clear } = useEventLog();
  const { points, push, reset: resetSeries } = useSeries(50, 500);

  /** Adds or removes server models when the stepper changes. */
  const applyServerCount = useCallback(
    (next: number) => {
      const state = sim.current!;
      if (next > state.servers.length) {
        for (let index = state.servers.length; index < next; index += 1) {
          state.servers.push(makeServer(index));
          log(`Server ${index + 1} joined the pool`, 'ok');
        }
      } else {
        const removed = state.servers.splice(next);
        for (const server of removed) log(`${server.name} removed from the pool`, 'warn');
        state.particles = state.particles.filter((particle) =>
          state.servers.some((server) => server.id === particle.route[particle.route.length - 1]),
        );
      }
      setSetup((current) => ({ ...current, serverCount: next }));
    },
    [log, setSetup],
  );

  const reset = useCallback(() => {
    // Back to this Concept's starting setup, not the lab's global default.
    sim.current = createState(start.serverCount);
    setSetup(start);
    clear();
    resetSeries();
    setInspected(null);
  }, [start, clear, resetSeries, setSetup]);

  const killServer = useCallback(
    (id: string) => {
      const server = sim.current!.servers.find((item) => item.id === id);
      if (!server || server.status === 'down') return;
      server.status = 'down';
      server.restartAt = null;
      server.active = 0;
      server.cpu = 0;
      server.errorRate = 0;
      server.crashedAt = performance.now();
      server.failedSinceCrash = 0;
      // A crashed server serves nothing, so its measured rate must not keep
      // decaying for another window after it dies.
      server.rate.clear();
      if (!server.inPool) {
        log(`${server.name} crashed while out of the pool`, 'warn');
      } else if (healthChecks) {
        log(`${server.name} crashed. The balancer does not know yet and keeps sending it requests`, 'danger');
      } else {
        log(`${server.name} crashed. With no health checks it stays in the pool for good`, 'danger');
      }
      rerender();
    },
    [healthChecks, log, rerender],
  );

  const restartServer = useCallback(
    (id: string) => {
      const server = sim.current!.servers.find((item) => item.id === id);
      if (!server || server.status !== 'down') return;
      server.status = 'starting';
      server.restartAt = performance.now() + BOOT_MS;
      log(`${server.name}: restarting, the process needs ${BOOT_MS / 1000} s to boot`, 'info');
      rerender();
    },
    [log, rerender],
  );

  const setHealthChecks = (next: boolean) => {
    const state = sim.current!;
    for (const server of state.servers) {
      server.failStreak = 0;
      server.passStreak = 0;
      server.nextProbeAt = null;
      // With no probes the balancer has no way to tell a dead server from a live
      // one, so every registered server is in rotation.
      if (!next) server.inPool = true;
    }
    log(
      next
        ? `Health checks on: every server is probed every ${intervalSec} s`
        : 'Health checks off: the balancer now sends to every registered server, alive or not',
      next ? 'ok' : 'warn',
    );
    change('healthChecks')(next);
  };

  const isSlow = (server: ServerModel) => slowFirst && server.id === 's0';
  /**
   * A slow server (bad disk, noisy neighbour) takes twice as long per request,
   * so each worker is busy twice as long and it absorbs half the traffic.
   */
  const durationOf = (server: ServerModel) => (isSlow(server) ? duration * 2 : duration);
  /**
   * A weighted pool sends more traffic to bigger servers, so under that
   * algorithm a server with weight N is modelled as N times the machine -
   * "proportionally more requests" only holds if the weight matches the size.
   * The tick, the node cards and the pool-capacity meter all read this one
   * function so they cannot disagree about whether a server is coping.
   */
  const capacityOf = (server: ServerModel) =>
    (algorithm === 'weighted' ? capacity * server.weight : capacity) / (isSlow(server) ? 2 : 1);

  /** Picks a backend from the pool according to the selected algorithm. */
  const pickServer = (state: SimState, pool: ServerModel[]): ServerModel => {
    switch (algorithm) {
      case 'random':
        return pool[Math.floor(Math.random() * pool.length)];
      case 'least-connections':
        // A crashed server holds zero connections, so while it is still in the
        // pool this picks it almost every time - the black-hole effect.
        return pool.reduce((best, server) => (server.active < best.active ? server : best), pool[0]);
      case 'weighted': {
        const total = pool.reduce((sum, server) => sum + server.weight, 0);
        state.weightCursor = (state.weightCursor + 1) % total;
        let cursor = state.weightCursor;
        for (const server of pool) {
          if (cursor < server.weight) return server;
          cursor -= server.weight;
        }
        return pool[0];
      }
      default: {
        state.cursor = (state.cursor + 1) % pool.length;
        return pool[state.cursor];
      }
    }
  };

  useTicker(running, (dt) => {
    const state = sim.current!;
    const now = performance.now();

    for (const server of state.servers) {
      if (server.status === 'starting' && server.restartAt !== null && now >= server.restartAt) {
        server.status = 'healthy';
        server.restartAt = null;
        server.crashedAt = null;
        log(
          server.inPool
            ? `${server.name}: process is up and serving again`
            : `${server.name}: process is up, waiting for ${RISE_THRESHOLD} passing probes`,
          'info',
        );
      }
    }

    // Health probes. Simplified: a probe fails only when the process is down or
    // still booting; a real probe can also time out on an overloaded server.
    if (healthChecks) {
      const interval = intervalSec * 1000;
      for (const server of state.servers) {
        if (server.nextProbeAt === null) {
          // Staggered, so the servers are not all probed in the same instant.
          server.nextProbeAt = now + Math.random() * interval;
          continue;
        }
        if (now < server.nextProbeAt) continue;
        server.nextProbeAt = now + interval;
        const passed = server.status === 'healthy';
        const probeId = nextParticleId();
        state.probes.add(probeId);
        state.particles.push({
          id: probeId,
          route: ['lb', server.id],
          leg: 0,
          t: 0,
          speed: 2.2,
          outcome: passed ? 'success' : 'failure',
        });

        if (passed) {
          server.failStreak = 0;
          server.passStreak += 1;
          if (!server.inPool && server.passStreak >= RISE_THRESHOLD) {
            server.inPool = true;
            log(`${server.name}: ${RISE_THRESHOLD} probes passed in a row, back in the pool`, 'ok');
          }
        } else {
          server.passStreak = 0;
          server.failStreak += 1;
          if (server.inPool) {
            if (server.failStreak >= failThreshold) {
              server.inPool = false;
              const after = server.crashedAt !== null ? ` ${((now - server.crashedAt) / 1000).toFixed(1)} s after the crash` : '';
              log(
                `${server.name}: ${failThreshold} probes failed in a row, ejected${after}. ${formatNumber(server.failedSinceCrash)} requests failed meanwhile`,
                'warn',
              );
            } else {
              log(`${server.name}: probe failed (${server.failStreak} of ${failThreshold})`, 'danger');
            }
          }
        }
      }
    }

    const pool = state.servers.filter((server) => server.inPool);

    // Per-server load model, from the rate measured over the last window. It
    // runs before the arrivals so each request can be settled against the load
    // it actually meets on the way in.
    for (const server of state.servers) {
      if (server.status !== 'healthy') {
        server.cpu = 0;
        server.active = 0;
        server.latency = 0;
        server.errorRate = 0;
        continue;
      }
      const incoming = server.rate.rate(now);
      const load = computeLoad(incoming, capacityOf(server), { baseLatencyMs: durationOf(server), kneeAt: 0.65 });
      server.cpu = load.cpu;
      server.latency = load.latencyMs;
      server.errorRate = load.errorRate;
      // Little's law: in-flight requests = arrival rate x time in system. Only
      // the requests the server accepts stay in flight; rejected ones fail fast.
      server.active = Math.round(incoming * (1 - load.errorRate) * (load.latencyMs / 1000));
    }

    // Arrivals. Every request is counted here; only a sample of them is
    // animated, so the particle budget can never throttle the metrics.
    const arrivals = sampleArrivals(traffic, dt);
    const share = visualShare(traffic, ANIMATED_PER_SECOND);

    for (let index = 0; index < arrivals; index += 1) {
      const id = nextParticleId();
      const animate = Math.random() < share;

      if (pool.length === 0) {
        state.failed += 1;
        state.rejected.add(1, now);
        if (animate) {
          state.particles.push({ id, route: ['users', 'lb'], leg: 0, t: 0, speed: 1.6, outcome: 'failure' });
        }
        continue;
      }

      const server = pickServer(state, pool);
      const alive = server.status === 'healthy';
      if (alive) {
        server.rate.add(1, now);
        // A real balancer counts the connection the moment it opens one, so
        // Least Connections spreads the requests of one tick instead of
        // sending them all to the same server.
        server.active += 1;
      }

      // A crashed or booting server refuses the connection, so every request
      // the balancer still sends it fails.
      const failedRequest = !alive || Math.random() < server.errorRate;
      const latency = alive ? server.latency * (0.75 + Math.random() * 0.7) : 0;

      if (failedRequest) {
        server.failed += 1;
        if (!alive) server.failedSinceCrash += 1;
        state.failed += 1;
        state.rejected.add(1, now);
      } else {
        server.handled += 1;
        state.handled += 1;
        state.accepted.add(1, now);
        state.latency.push(latency, now);
      }

      if (!animate) continue;

      const outcome = failedRequest ? 'failure' : server.cpu > 0.85 ? 'warning' : 'success';
      state.particles.push({
        id,
        route: ['users', 'lb', server.id],
        leg: 0,
        t: 0,
        speed: 1.5 + Math.random() * 0.4,
        outcome,
        meta: { serverId: server.id },
      });

      // Keep a rolling set of inspectable requests - one per animated particle,
      // and deeper than the particle budget so every dot on the canvas still
      // has its record when it is clicked near the end of its route.
      if (state.requests.size > INSPECTABLE_REQUESTS) {
        const oldest = state.requests.keys().next().value;
        if (oldest !== undefined) state.requests.delete(oldest);
      }
      state.requests.set(id, {
        id,
        createdAt: now,
        currentNode: server.id,
        status: failedRequest ? 'failed' : 'completed',
        outcome,
        latency,
        path: ['Client', 'Load Balancer', server.name],
        method: 'GET',
        endpoint: ENDPOINTS[id % ENDPOINTS.length],
        notes: [
          `Algorithm: ${algorithmLabel(algorithm)}`,
          alive ? `Server CPU at arrival: ${Math.round(server.cpu * 100)}%` : `${server.name} is down but still in the pool`,
          !alive
            ? healthChecks
              ? 'Failed: connection refused. The health check has not ejected it yet'
              : 'Failed: connection refused. With no health checks it is never ejected'
            : failedRequest
              ? 'Rejected: server over capacity'
              : 'Completed successfully',
        ],
      });
    }

    // Particles are decoration from here on: they carry no accounting, so
    // dropping one at the end of its route costs nothing.
    const { alive, finished } = advanceParticles(state.particles, dt);
    for (const particle of finished) state.probes.delete(particle.id);
    if (alive.length > PARTICLE_BUDGET) {
      for (const particle of alive.slice(0, alive.length - PARTICLE_BUDGET)) state.probes.delete(particle.id);
      state.particles = alive.slice(-PARTICLE_BUDGET);
    } else {
      state.particles = alive;
    }

    const snapshot = state.latency.snapshot(now);
    push(
      {
        rps: state.accepted.rate(now),
        // No request served in the MetricWindow horizon (every server down): NaN breaks the
        // line instead of drawing a stale or zero latency.
        p95: snapshot.p95 ?? NaN,
        avg: snapshot.avg ?? NaN,
        errors: state.rejected.rate(now),
      },
      now,
    );

    rerender();
  });

  const state = sim.current;
  const servers = state.servers;
  // `servers` is mutated in place (stepper, kill, restart, probes), so its
  // reference never changes. Memoize on what the diagram actually depends on
  // instead, or added servers get no layout and an ejected server keeps a live edge.
  const poolKey = servers.map((server) => `${server.id}:${server.status}:${server.inPool}`).join(',');

  const layout = useMemo<Layout>(() => {
    const count = servers.length;
    const width = clamp((940 - (count - 1) * 12) / count, 106, 168);
    const xs = spread(count, 480, width, 12);
    // Tallest card: a subtitle, meter, stat rows and button (Weighted adds the Weight row).
    const height = algorithm === 'weighted' ? 224 : 201;
    const result: Layout = {
      users: { x: 385, y: 16, w: 190, h: 73 },
      lb: { x: 355, y: 130, w: 250, h: 128 },
    };
    servers.forEach((server, index) => {
      result[server.id] = { x: xs[index], y: 290, w: width, h: height };
    });
    return result;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- poolKey tracks the in-place mutations of servers
  }, [servers, poolKey, algorithm]);

  const edges = useMemo<DiagramEdge[]>(
    () => [
      { from: 'users', to: 'lb', tone: 'brand', width: 2 },
      ...servers.map<DiagramEdge>((server) =>
        server.inPool
          ? // In the pool: traffic flows. Red when the server behind it is dead.
            { from: 'lb', to: server.id, tone: server.status === 'healthy' ? 'ok' : 'danger' }
          : { from: 'lb', to: server.id, tone: 'muted', dashed: true },
      ),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps -- poolKey tracks the in-place mutations of servers
    [servers, poolKey],
  );

  const particleViews = useMemo<ParticleView[]>(
    () =>
      state.particles.map((particle) => {
        const probe = state.probes.has(particle.id);
        return {
          id: particle.id,
          from: particle.route[particle.leg],
          to: particle.route[particle.leg + 1],
          t: particle.t,
          outcome: particle.outcome ?? 'success',
          // Probes are drawn ringed so they read as checks, not as user requests.
          highlighted: probe,
          onClick: probe
            ? undefined
            : () => {
                const request = state.requests.get(particle.id);
                if (request) setInspected(request);
              },
        };
      }),
    [state.particles, state.probes, state.requests],
  );

  const now = performance.now();
  const snapshot = state.latency.snapshot(now);
  const acceptedRate = state.accepted.rate(now);
  const rejectedRate = state.rejected.rate(now);
  const totalRate = acceptedRate + rejectedRate;
  const errorRatio = totalRate > 0 ? rejectedRate / totalRate : 0;
  const aliveCount = servers.filter((server) => server.status === 'healthy').length;
  const inPoolCount = servers.filter((server) => server.inPool).length;
  const avgCpu = aliveCount ? servers.reduce((sum, server) => sum + server.cpu, 0) / aliveCount : 0;
  const totalActive = servers.reduce((sum, server) => sum + server.active, 0);
  const poolCapacity = servers
    .filter((server) => server.inPool && server.status === 'healthy')
    .reduce((sum, server) => sum + capacityOf(server), 0);
  /** Dead servers the balancer still sends traffic to. */
  const deadInPool = servers.filter((server) => server.inPool && server.status !== 'healthy');
  const slowServer = servers.find((server) => isSlow(server) && server.inPool && server.status === 'healthy');
  const detectionSec = intervalSec * failThreshold;

  const poolState = (server: ServerModel): string | undefined => {
    if (!server.inPool) {
      if (server.status === 'starting') return 'booting, out of pool';
      if (server.status === 'healthy') return `passes ${server.passStreak} of ${RISE_THRESHOLD}`;
      return 'ejected from pool';
    }
    if (server.status !== 'healthy') {
      return healthChecks ? `probes failed ${server.failStreak} of ${failThreshold}` : 'dead, still in pool';
    }
    return undefined;
  };

  const blackHole =
    algorithm === 'least-connections'
      ? ' Least Connections makes it worse: a dead server holds zero connections, so it wins almost every pick.'
      : '';

  return (
    <LabShell
      title="Load Balancer Lab"
      description="Change traffic, pool size and algorithm - then kill a server and watch the health checks take it out of rotation."
      running={running}
      onRunningChange={setRunning}
      onReset={reset}
      legend={
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
          <ParticleLegend outcomes={['success', 'warning', 'failure']} />
          {healthChecks ? <span className="text-[11px] text-muted">Ringed dot: health probe</span> : null}
        </div>
      }
      events={events}
      insight={
        <Insight>
          {inPoolCount === 0 ? (
            <>
              Every server has left the pool, so the balancer has nowhere to send traffic and fails every request.
              Restart one: it rejoins after {RISE_THRESHOLD} passing probes.
            </>
          ) : deadInPool.length > 0 ? (
            healthChecks ? (
              <>
                {deadInPool.map((server) => server.name).join(' and ')} is down but still in the pool, so every request
                sent there fails until {failThreshold} probes in a row fail - up to about {detectionSec} s at one probe
                every {intervalSec} s.{blackHole}
              </>
            ) : (
              <>
                No health checks: {deadInPool.map((server) => server.name).join(' and ')} stays in the pool for good
                and every request sent there fails.{blackHole} Turn health checks on and watch it leave.
              </>
            )
          ) : traffic > poolCapacity ? (
            <>
              Incoming traffic ({formatNumber(traffic)} req/sec) exceeds pool capacity (
              {formatNumber(poolCapacity)} req/sec). Latency climbs first, then requests start failing. Add a server
              or raise per-server capacity and watch both recover.
            </>
          ) : slowServer && slowServer.errorRate > 0.01 && algorithm !== 'least-connections' ? (
            <>
              {slowServer.name} is slow, but {algorithmLabel(algorithm)} does not look at how busy a server is and
              keeps sending it its share, so it saturates and fails requests while the pool as a whole has room
              ({formatNumber(traffic)} of {formatNumber(poolCapacity)} req/sec). Switch to Least Connections.
            </>
          ) : focus === 'health-checks' && healthChecks ? (
            <>
              The balancer probes every server every {intervalSec} s (the ringed dots). Press Kill on a server: it
              keeps receiving requests until {failThreshold} probes in a row fail, then it leaves the pool.
            </>
          ) : (
            <>{ALGORITHM_NOTE[algorithm]}</>
          )}
        </Insight>
      }
      metrics={
        <>
          <MetricsPanel
            items={[
              { key: 'rps', label: 'Requests/sec', value: formatNumber(acceptedRate), tone: 'brand' },
              { key: 'latency', label: 'Avg latency', value: formatLatency(snapshot.avg), hint: 'Time to serve one request.', simulated: true },
              { key: 'p95', label: 'P95 latency', value: formatLatency(snapshot.p95), tone: snapshot.p95 !== null && snapshot.p95 > 500 ? 'warn' : 'neutral', hint: '95% of requests finish faster than this.', simulated: true },
              { key: 'p99', label: 'P99 latency', value: formatLatency(snapshot.p99), tone: snapshot.p99 !== null && snapshot.p99 > 1000 ? 'danger' : 'neutral', simulated: true },
              {
                key: 'cpu',
                label: 'Avg utilization',
                value: formatPercent(avgCpu),
                tone: avgCpu > 0.85 ? 'danger' : avgCpu > 0.7 ? 'warn' : 'ok',
                simulated: true,
              },
              {
                key: 'errorRate',
                label: 'Failed requests',
                value: formatPercent(errorRatio, 1),
                tone: errorRatio > 0.01 ? 'danger' : 'ok',
                sub: `${formatNumber(state.failed)} total`,
                simulated: true,
              },
              { key: 'activeConnections', label: 'Active conns', value: formatNumber(totalActive) },
              {
                key: 'instances',
                label: 'Servers in pool',
                value: `${inPoolCount}/${servers.length}`,
                tone: deadInPool.length > 0 ? 'danger' : inPoolCount < servers.length ? 'warn' : 'ok',
                sub: `${aliveCount} alive`,
              },
            ]}
          />
          <div className="card p-4">
            <p className="label mb-3">Throughput and latency over time</p>
            <LiveChart
              data={points}
              series={[
                { key: 'rps', label: 'Requests/sec', color: 'brand' },
                { key: 'errors', label: 'Failed/sec', color: 'danger' },
              ]}
              height={150}
            />
            <LiveChart
              data={points}
              series={[
                { key: 'avg', label: 'Avg latency (ms)', color: 'brand' },
                { key: 'p95', label: 'P95 latency (ms)', color: 'violet' },
              ]}
              variant="line"
              height={150}
            />
          </div>
        </>
      }
      footer={<RequestInspector request={inspected} onClose={() => setInspected(null)} />}
      controls={
        <>
          <Slider
            label="Traffic"
            value={traffic}
            min={50}
            max={5000}
            step={50}
            onChange={change('traffic')}
            format={(value) => `${formatNumber(value)} req/sec`}
            scale={['50', '5000']}
            hint="Requests per second arriving at the load balancer."
            tone={traffic > poolCapacity ? 'danger' : 'brand'}
          />
          <Stepper
            label="Servers"
            value={serverCount}
            min={1}
            max={8}
            onChange={applyServerCount}
            hint="Instances registered in the load balancer pool."
          />
          <Select
            label="Algorithm"
            value={algorithm}
            options={ALGORITHMS}
            onChange={change('algorithm')}
            hint="How the load balancer chooses which server in the pool receives the next request."
          />
          <Slider
            label="Server capacity"
            value={capacity}
            min={100}
            max={1500}
            step={50}
            onChange={change('capacity')}
            format={(value) => `${formatNumber(value)} req/sec`}
            hint="How much traffic one server absorbs before it saturates (simplified queueing model)."
          />
          <Slider
            label="Request duration"
            value={duration}
            min={10}
            max={400}
            step={10}
            onChange={change('duration')}
            format={(value) => `${value} ms`}
            hint="Base processing time per request with no queueing."
          />
          <Toggle
            label="Server 1 is slow"
            checked={slowFirst}
            onChange={(next) => {
              change('slowFirst')(next);
              log(next ? 'Server 1 now takes 2x as long per request' : 'Server 1 back to normal speed', next ? 'warn' : 'ok');
            }}
            description="Each request takes 2x as long there. Compare Round Robin and Least Connections."
          />
          <div className="border-y border-line py-4">
            <p className="label mb-2">Pool capacity</p>
            <Meter
              value={poolCapacity ? traffic / poolCapacity : 1}
              label={`${formatNumber(traffic)} / ${formatNumber(poolCapacity)} req/sec`}
            />
          </div>
          <Toggle
            label="Health checks"
            checked={healthChecks}
            onChange={setHealthChecks}
            description={`Probe every server; eject after failed probes, readmit after ${RISE_THRESHOLD} passes.`}
            hint="Simplified: a probe here fails only when the process is down or booting. A real probe can also time out on an overloaded server."
          />
          {healthChecks ? (
            <>
              <Slider
                label="Probe interval"
                value={intervalSec}
                min={1}
                max={10}
                step={1}
                onChange={change('intervalSec')}
                format={(value) => `every ${value} s`}
                hint="How often the balancer probes each server. Shorter finds a dead server sooner, at the cost of more probe traffic."
              />
              <Stepper
                label="Failures to eject"
                value={failThreshold}
                min={1}
                max={5}
                onChange={change('failThreshold')}
                hint="Consecutive failed probes before a server leaves the pool. One is fast but ejects a healthy server on a single slow reply (flapping)."
              />
            </>
          ) : null}
          <p className="text-xs text-muted">
            {healthChecks ? (
              <>
                A dead server keeps receiving requests for up to about{' '}
                <span className="font-semibold text-ink">{detectionSec} s</span> ({failThreshold} x {intervalSec} s).
              </>
            ) : (
              <>With no health checks a dead server is never taken out of the pool.</>
            )}
          </p>
        </>
      }
    >
      <DiagramCanvas
        layout={layout}
        edges={edges}
        particles={particleViews}
        height={580}
        className="bg-canvas"
      >
        <ArchNode
          kind="client"
          title="Users"
          subtitle={`${formatNumber(traffic)} req/sec generated`}
          placed={layout.users}
          compact
        />
        <ArchNode
          kind="load-balancer"
          title="Load Balancer"
          subtitle={`${algorithmLabel(algorithm)}, ${healthChecks ? `probe ${intervalSec} s` : 'no checks'}`}
          placed={layout.lb}
          status={inPoolCount === 0 ? 'down' : 'healthy'}
        >
          <NodeStatRow label="Incoming" value={`${formatNumber(traffic)}/s`} />
          <NodeStatRow
            label="In pool"
            value={`${inPoolCount}/${servers.length}`}
            tone={deadInPool.length > 0 ? 'text-danger' : inPoolCount < servers.length ? 'text-warn' : 'text-ok'}
          />
        </ArchNode>

        {servers.map((server) => (
          <ArchNode
            key={server.id}
            kind="server"
            title={server.name}
            // The weight is a stat row: "weight 3, 2x slower" does not fit the ~107px box of 8 servers.
            subtitle={poolState(server) ?? (isSlow(server) ? '2x slower' : undefined)}
            placed={layout[server.id]}
            status={server.status}
            alert={server.status === 'healthy' && server.cpu > 0.9}
            // At 8 servers a box is ~107px wide; the regular padding would
            // truncate "Server 8" to "Serve...".
            compact={servers.length > 6}
          >
            <Meter label="CPU" value={server.cpu} size="xs" />
            {algorithm === 'weighted' ? <NodeStatRow label="Weight" value={server.weight} /> : null}
            <NodeStatRow label="Conns" value={server.active} />
            <NodeStatRow
              label="Latency"
              value={server.status === 'healthy' ? formatLatency(server.latency) : '-'}
            />
            <Button
              size="sm"
              variant={server.status === 'down' ? 'success' : 'danger'}
              className="mt-1 w-full justify-center"
              onClick={() => (server.status === 'down' ? restartServer(server.id) : killServer(server.id))}
              disabled={server.status === 'starting'}
            >
              {server.status === 'down' ? (
                <>
                  <RotateCw className="h-3 w-3" /> Restart
                </>
              ) : (
                <>
                  <Power className="h-3 w-3" /> Kill
                </>
              )}
            </Button>
          </ArchNode>
        ))}
      </DiagramCanvas>
    </LabShell>
  );
}

export default LoadBalancerLab;
