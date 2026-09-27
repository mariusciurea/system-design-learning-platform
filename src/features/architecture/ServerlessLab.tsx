import { useCallback, useRef, useState, type ReactNode } from 'react';
import { Info } from 'lucide-react';
import {
  ArchNode,
  DiagramCanvas,
  NodeStatRow,
  ParticleLegend,
  type DiagramEdge,
  type Layout,
  type ParticleView,
} from '@/components/architecture';
import { LiveChart } from '@/components/charts';
import { Insight, LabShell, MetricsPanel } from '@/components/learning';
import { Meter, SegmentedControl, Slider } from '@/components/ui';
import {
  advanceParticles,
  nextParticleId,
  useEventLog,
  useSeries,
  useTicker,
  type Particle,
} from '@/simulations/engine';
import { useRerender } from '@/hooks/useRerender';
import { percentile, sampleArrivals } from '@/utils/math';
import { formatLatency, formatPercent } from '@/utils/format';
import type { NodeStatus } from '@/types';
import { useLabRunning } from '@/hooks/useLabRunning';

/*
 * A simplified model of a function platform (shaped on AWS Lambda) next to one
 * always-on server that receives the very same events.
 *
 * - One function instance serves one request at a time, as on Lambda. An event
 *   that finds no idle instance gets a new one, which cold starts first.
 * - An idle instance is reclaimed after IDLE_RECLAIM_S. Real platforms keep an
 *   idle instance for minutes and do not publish the exact time; 6 s keeps the
 *   scale-to-zero moment inside what a learner will wait for.
 * - Every event is EXEC_S of work. Latency here is start-up + work + queueing,
 *   with no network time.
 * - Prices are made-up units with roughly real proportions: a busy function
 *   second costs about three times a fully used server second, and the start-up
 *   (init) time is billed too, as Lambda does. They are not a bill.
 */
const EXEC_S = 0.5;
const IDLE_RECLAIM_S = 6;
const MAX_LIMIT = 12;
const MAX_PROVISIONED = 4;
const DB_MAX_CONNECTIONS = 8;
const TRICKLE_EVERY_S = 8;
const BURST_CYCLE_S = 20;
const BURST_LENGTH_S = 4;
/** Threads on the always-on server: sized for the top of the rate slider (20/s x 0.5 s = 10, plus headroom). */
const SERVER_THREADS = 12;
/** The server shares a small pool of database connections between its threads. */
const SERVER_POOL = 4;

// Prices, in cost units.
const FN_PER_SECOND = 1;
const FN_PER_REQUEST = 0.02;
const PROVISIONED_PER_SECOND = 0.25;
const PROVISIONED_BUSY_PER_SECOND = 0.6;
const SERVER_PER_SECOND = 3;

const WINDOW = 60;

type Shape = 'steady' | 'bursts' | 'trickle';
type View = 'functions' | 'server';

interface Setup {
  shape: Shape;
  peak: number;
  coldStart: number;
  limit: number;
  provisioned: number;
  view: View;
}

const DEFAULT_SETUP: Setup = {
  shape: 'bursts',
  peak: 5,
  coldStart: 0.8,
  limit: MAX_LIMIT,
  provisioned: 0,
  view: 'functions',
};

interface Instance {
  id: number;
  slot: number;
  phase: 'starting' | 'busy' | 'idle';
  readyAt: number;
  /** When the current request finishes; null while it has none. */
  busyUntil: number | null;
  idleSince: number;
  provisioned: boolean;
  connected: boolean;
}

type Outcome = 'warm' | 'cold' | 'throttled' | 'refused';

interface Served {
  outcome: Outcome;
  latency: number;
}

interface SimState {
  elapsed: number;
  nextTrickleAt: number;
  instances: Instance[];
  nextId: number;
  particles: Particle[];
  fnRecent: Served[];
  serverRecent: number[];
  serverThreads: number[];
  events: number;
  fnCost: number;
  serverCost: number;
  coldStarts: number;
  throttled: number;
  refused: number;
  lastWarnAt: number;
}

const createState = (): SimState => ({
  elapsed: 0,
  nextTrickleAt: 1,
  instances: [],
  nextId: 1,
  particles: [],
  fnRecent: [],
  serverRecent: [],
  serverThreads: Array.from({ length: SERVER_THREADS }, () => 0),
  events: 0,
  fnCost: 0,
  serverCost: 0,
  coldStarts: 0,
  throttled: 0,
  refused: 0,
  lastWarnAt: -10,
});

function rateAt(setup: Setup, seconds: number) {
  if (setup.shape === 'steady') return setup.peak;
  if (setup.shape === 'bursts') return seconds % BURST_CYCLE_S < BURST_LENGTH_S ? setup.peak : 0;
  return 1 / TRICKLE_EVERY_S;
}

const fnKey = (instance: Instance) => `fn${instance.id}`;

function slotPlace(slot: number) {
  return { x: 384 + (slot % 3) * 128, y: 12 + Math.floor(slot / 3) * 92, w: 118, h: 90 };
}

const pushWindow = <T,>(list: T[], item: T) => {
  list.push(item);
  if (list.length > WINDOW) list.shift();
};

const costPer1000 = (cost: number, events: number) => (events > 0 ? (cost / events) * 1000 : null);
const formatCost = (value: number | null) => (value === null ? '-' : value >= 100 ? value.toFixed(0) : value.toFixed(1));

/**
 * Serverless: events -> function platform -> function instances -> database,
 * with the same events also priced on one always-on server.
 */
export function ServerlessLab() {
  const [running, setRunning] = useLabRunning();
  const [setup, setSetup] = useState<Setup>(DEFAULT_SETUP);
  const state = useRef<SimState>(createState());
  const rerender = useRerender(30);
  const { events, log, clear } = useEventLog(60);
  const { points, push, reset: resetSeries } = useSeries(80, 400);

  const update = <K extends keyof Setup>(key: K, value: Setup[K]) =>
    setSetup((previous) => {
      const next = { ...previous, [key]: value };
      return { ...next, provisioned: Math.min(next.provisioned, next.limit) };
    });

  const reset = useCallback(() => {
    state.current = createState();
    setSetup(DEFAULT_SETUP);
    clear();
    resetSeries();
  }, [clear, resetSeries]);

  const connect = (sim: SimState, instance: Instance) => {
    if (instance.connected) return true;
    const open = sim.instances.filter((other) => other.connected).length;
    if (open >= DB_MAX_CONNECTIONS) return false;
    instance.connected = true;
    return true;
  };

  const warnOnce = (sim: SimState, message: string) => {
    if (sim.elapsed - sim.lastWarnAt < 2) return;
    sim.lastWarnAt = sim.elapsed;
    log(message, 'danger');
  };

  const freeSlot = (sim: SimState) => {
    const used = new Set(sim.instances.map((instance) => instance.slot));
    for (let slot = 0; slot < MAX_LIMIT; slot += 1) if (!used.has(slot)) return slot;
    return -1;
  };

  /** One event reaches the platform: reuse an idle instance, start a new one, or throttle. */
  const arriveAtFunctions = (sim: SimState) => {
    const now = sim.elapsed;
    const showParticle = setup.view === 'functions';
    const idle = sim.instances
      .filter((instance) => instance.phase === 'idle')
      .sort((a, b) => Number(b.provisioned) - Number(a.provisioned) || a.slot - b.slot)[0];

    let instance = idle;
    let cold = false;
    if (instance) {
      instance.phase = 'busy';
      instance.busyUntil = now + EXEC_S;
    } else if (sim.instances.length < setup.limit) {
      instance = {
        id: sim.nextId,
        slot: freeSlot(sim),
        phase: 'starting',
        readyAt: now + setup.coldStart,
        busyUntil: now + setup.coldStart + EXEC_S,
        idleSince: now,
        provisioned: false,
        connected: false,
      };
      sim.nextId += 1;
      sim.instances.push(instance);
      sim.coldStarts += 1;
      cold = true;
      log(`fn ${instance.slot + 1}: cold start (${setup.coldStart.toFixed(1)} s) - no idle instance`, 'warn');
    } else {
      sim.throttled += 1;
      pushWindow(sim.fnRecent, { outcome: 'throttled', latency: 0 });
      warnOnce(sim, `Throttled (HTTP 429): all ${setup.limit} instances are busy - the concurrency limit`);
      if (showParticle) {
        sim.particles.push({
          id: nextParticleId(),
          route: ['events', 'platform'],
          leg: 0,
          t: 0,
          speed: 2.4,
          outcome: 'failure',
        });
      }
      return;
    }

    sim.fnCost += FN_PER_REQUEST;
    const ok = connect(sim, instance);
    if (!ok) {
      sim.refused += 1;
      pushWindow(sim.fnRecent, { outcome: 'refused', latency: 0 });
      warnOnce(sim, `fn ${instance.slot + 1}: database refused the connection - ${DB_MAX_CONNECTIONS} already open`);
    } else {
      pushWindow(sim.fnRecent, { outcome: cold ? 'cold' : 'warm', latency: (cold ? setup.coldStart : 0) + EXEC_S });
    }

    if (showParticle) {
      sim.particles.push({
        id: nextParticleId(),
        route: ok ? ['events', 'platform', fnKey(instance), 'db'] : ['events', 'platform', fnKey(instance)],
        leg: 0,
        t: 0,
        // A cold request walks slower: it waits for its instance to start.
        speed: cold ? 3 / (setup.coldStart + 1.2) : 2.4,
        outcome: ok ? (cold ? 'warning' : 'success') : 'failure',
      });
    }
  };

  /** The same event on the always-on server: the free thread, or wait for the first one to free up. */
  const arriveAtServer = (sim: SimState) => {
    const now = sim.elapsed;
    let best = 0;
    sim.serverThreads.forEach((freeAt, index) => {
      if (freeAt < sim.serverThreads[best]) best = index;
    });
    const start = Math.max(now, sim.serverThreads[best]);
    sim.serverThreads[best] = start + EXEC_S;
    const latency = start - now + EXEC_S;
    pushWindow(sim.serverRecent, latency);
    if (setup.view === 'server') {
      sim.particles.push({
        id: nextParticleId(),
        route: ['events', 'server', 'db'],
        leg: 0,
        t: 0,
        speed: 2.4,
        outcome: latency > EXEC_S + 0.05 ? 'warning' : 'success',
      });
    }
  };

  useTicker(running, (dt) => {
    const sim = state.current;
    sim.elapsed += dt;
    const now = sim.elapsed;

    // Instance lifecycle: start-up finishes, requests finish, idle instances are reclaimed.
    for (const instance of sim.instances) {
      if (instance.phase === 'starting' && now >= instance.readyAt) {
        instance.phase = instance.busyUntil === null ? 'idle' : 'busy';
        instance.idleSince = now;
        if (instance.provisioned) connect(sim, instance);
      }
      if (instance.phase === 'busy' && instance.busyUntil !== null && now >= instance.busyUntil) {
        instance.phase = 'idle';
        instance.idleSince = instance.busyUntil;
        instance.busyUntil = null;
      }
    }
    const before = sim.instances.length;
    sim.instances = sim.instances.filter((instance) => {
      const reclaim = instance.phase === 'idle' && !instance.provisioned && now - instance.idleSince >= IDLE_RECLAIM_S;
      if (reclaim) log(`fn ${instance.slot + 1}: idle ${IDLE_RECLAIM_S} s - reclaimed, its connection closed`, 'info');
      return !reclaim;
    });
    // A lowered concurrency limit drains: idle instances above it go now, busy ones when they finish.
    while (sim.instances.length > setup.limit) {
      const index = sim.instances.findIndex((instance) => instance.phase === 'idle' && !instance.provisioned);
      if (index < 0) break;
      sim.instances.splice(index, 1);
    }
    if (before > 0 && sim.instances.length === 0) log('Scaled to zero - nothing runs and nothing is billed', 'ok');

    // Provisioned concurrency: keep exactly that many instances warm, whatever the traffic.
    const want = Math.min(setup.provisioned, setup.limit);
    let have = sim.instances.filter((instance) => instance.provisioned).length;
    for (const instance of sim.instances) {
      if (have >= want) break;
      if (!instance.provisioned) {
        instance.provisioned = true;
        have += 1;
      }
    }
    while (have < want && sim.instances.length < setup.limit) {
      const slot = freeSlot(sim);
      sim.instances.push({
        id: sim.nextId,
        slot,
        phase: 'starting',
        readyAt: now + setup.coldStart,
        busyUntil: null,
        idleSince: now,
        provisioned: true,
        connected: false,
      });
      sim.nextId += 1;
      have += 1;
      log(`fn ${slot + 1}: provisioned - started ahead of traffic`, 'info');
    }
    for (const instance of [...sim.instances].reverse()) {
      if (have <= want) break;
      if (instance.provisioned) {
        instance.provisioned = false;
        have -= 1;
      }
    }

    // Arrivals: every event goes to both options, so their costs compare like for like.
    let arrivals = 0;
    if (setup.shape === 'trickle') {
      while (now >= sim.nextTrickleAt) {
        arrivals += 1;
        sim.nextTrickleAt += TRICKLE_EVERY_S;
      }
    } else {
      arrivals = sampleArrivals(rateAt(setup, now), dt);
      sim.nextTrickleAt = now + 1;
    }
    for (let index = 0; index < arrivals; index += 1) {
      sim.events += 1;
      arriveAtFunctions(sim);
      arriveAtServer(sim);
    }

    // Billing.
    for (const instance of sim.instances) {
      const working = instance.phase !== 'idle';
      if (instance.provisioned) {
        sim.fnCost += (PROVISIONED_PER_SECOND + (working ? PROVISIONED_BUSY_PER_SECOND : 0)) * dt;
      } else if (working) {
        sim.fnCost += FN_PER_SECOND * dt;
      }
    }
    sim.serverCost += SERVER_PER_SECOND * dt;

    const { alive } = advanceParticles(sim.particles, dt);
    sim.particles = alive.slice(-140);

    push({
      rate: rateAt(setup, now),
      instances: sim.instances.length,
      fnCost: sim.fnCost,
      serverCost: sim.serverCost,
    });
    rerender();
  });

  // ---- Derived view ------------------------------------------------------
  const sim = state.current;
  const now = sim.elapsed;
  const rate = rateAt(setup, now);
  const busy = sim.instances.filter((instance) => instance.phase !== 'idle').length;
  const connections = sim.instances.filter((instance) => instance.connected).length;
  const invoked = sim.fnRecent.filter((item) => item.outcome !== 'throttled');
  const served = sim.fnRecent.filter((item) => item.outcome === 'warm' || item.outcome === 'cold');
  const coldShare = invoked.length ? sim.fnRecent.filter((item) => item.outcome === 'cold').length / invoked.length : 0;
  const throttledShare = sim.fnRecent.length
    ? sim.fnRecent.filter((item) => item.outcome === 'throttled').length / sim.fnRecent.length
    : 0;
  const refusedShare = sim.fnRecent.length
    ? sim.fnRecent.filter((item) => item.outcome === 'refused').length / sim.fnRecent.length
    : 0;
  const fnP95 = served.length ? percentile(served.map((item) => item.latency).sort((a, b) => a - b), 95) : null;
  const serverP95 = sim.serverRecent.length ? percentile([...sim.serverRecent].sort((a, b) => a - b), 95) : null;
  const serverBusy = sim.serverThreads.filter((freeAt) => freeAt > now).length;
  const serverQueued = sim.serverThreads.reduce((sum, freeAt) => sum + Math.max(0, Math.floor((freeAt - now) / EXEC_S)), 0);
  const fnPer1000 = costPer1000(sim.fnCost, sim.events);
  const serverPer1000 = costPer1000(sim.serverCost, sim.events);

  const view = setup.view;
  const layout: Layout = {
    events: { x: 16, y: 146, w: 136, h: 84 },
    db: { x: 780, y: 126, w: 166, h: 124 },
  };
  if (view === 'functions') {
    layout.platform = { x: 172, y: 124, w: 190, h: 128 };
    for (const instance of sim.instances) layout[fnKey(instance)] = slotPlace(instance.slot);
  } else {
    layout.server = { x: 400, y: 108, w: 280, h: 160 };
  }

  const edges: DiagramEdge[] =
    view === 'functions'
      ? [
          { from: 'events', to: 'platform', tone: 'brand', width: 2 },
          ...sim.instances.flatMap<DiagramEdge>((instance) => [
            {
              from: 'platform',
              to: fnKey(instance),
              tone: instance.phase === 'starting' ? 'warn' : 'ok',
              dashed: instance.phase === 'starting',
            },
            {
              from: fnKey(instance),
              to: 'db',
              tone: instance.connected ? 'info' : 'muted',
              dashed: !instance.connected,
            },
          ]),
        ]
      : [
          { from: 'events', to: 'server', tone: 'brand', width: 2 },
          { from: 'server', to: 'db', tone: 'info' },
        ];

  const particleViews: ParticleView[] = sim.particles
    .filter((particle) => particle.route.every((node) => layout[node]))
    .map((particle) => ({
      id: particle.id,
      from: particle.route[particle.leg],
      to: particle.route[particle.leg + 1],
      t: particle.t,
      outcome: particle.outcome ?? 'success',
    }));

  const instanceState = (instance: Instance): { label: string; status: NodeStatus } => {
    if (instance.phase === 'starting') return { label: 'cold start', status: 'starting' };
    if (!instance.connected) return { label: 'no DB conn', status: 'degraded' };
    if (instance.phase === 'busy') return { label: 'busy', status: 'healthy' };
    if (instance.provisioned) return { label: 'idle, kept', status: 'healthy' };
    const left = Math.max(0, IDLE_RECLAIM_S - (now - instance.idleSince));
    return { label: `idle, ${Math.ceil(left)} s left`, status: 'healthy' };
  };

  const shapeHint =
    setup.shape === 'steady'
      ? `A steady ${setup.peak} events per second.`
      : setup.shape === 'bursts'
        ? `${setup.peak} events per second for ${BURST_LENGTH_S} s, then ${BURST_CYCLE_S - BURST_LENGTH_S} s of nothing.`
        : `One event every ${TRICKLE_EVERY_S} s - longer than the ${IDLE_RECLAIM_S} s an idle instance is kept.`;

  const cheaper =
    fnPer1000 !== null && serverPer1000 !== null ? (fnPer1000 < serverPer1000 ? 'functions' : 'server') : null;

  let insight: ReactNode;
  if (view === 'server') {
    insight = (
      <>
        The always-on server has {SERVER_THREADS} threads sized for the top of the rate slider. It never cold starts
        and never scales to zero: it costs {SERVER_PER_SECOND} units every second, whether events arrive or not. Its
        cost per 1,000 events falls as traffic rises; the cost of the functions per 1,000 events stays about the same.
      </>
    );
  } else if (refusedShare > 0) {
    insight = (
      <>
        Every instance opens its own database connection, and the database allows {DB_MAX_CONNECTIONS}. The platform
        scaled past that, so the extra instances fail. Lower the concurrency limit to {DB_MAX_CONNECTIONS} or less: the
        platform then throttles instead of hurting the database. In production a pooler or proxy sits in between.
      </>
    );
  } else if (throttledShare > 0) {
    insight = (
      <>
        All {setup.limit} instances were busy, so the platform throttled {formatPercent(throttledShare)} of recent
        events (HTTP 429 on a synchronous call). The concurrency limit caps your bill and protects the database; the
        cost is rejected work at the peak.
      </>
    );
  } else if (sim.instances.length === 0 && sim.events > 0) {
    insight = (
      <>
        Scaled to zero: no instance is running, so nothing is billed. The next event pays a cold start of{' '}
        {setup.coldStart.toFixed(1)} s before its {EXEC_S} s of work.
      </>
    );
  } else if (coldShare >= 0.2) {
    insight = (
      <>
        {formatPercent(coldShare)} of recent requests waited for a cold start. That is noise for a background job and a
        visible delay for a user. Provisioned concurrency keeps instances warm, and it brings back a fixed bill.
      </>
    );
  } else {
    insight = (
      <>
        Same events, two bills: functions {formatCost(fnPer1000)} and always-on {formatCost(serverPer1000)} units per
        1,000 events so far.{' '}
        {cheaper === 'functions'
          ? 'Idle time is free for functions, so spiky and low traffic favours them.'
          : cheaper === 'server'
            ? 'Under steady high load the server is busy most of the time, so its fixed price spreads over many events.'
            : 'Let some events arrive to compare.'}
      </>
    );
  }

  return (
    <LabShell
      title="Serverless Lab"
      description="Events reach a function platform that starts an instance per concurrent request and reclaims idle ones. Change the traffic shape and watch scale to zero, cold starts, the concurrency limit and the cost against an always-on server."
      running={running}
      onRunningChange={setRunning}
      onReset={reset}
      legend={
        <ParticleLegend
          outcomes={[
            { outcome: 'success', label: 'Warm request' },
            { outcome: 'warning', label: 'Cold start or queued' },
            { outcome: 'failure', label: 'Throttled or refused' },
          ]}
        />
      }
      events={events}
      insight={<Insight>{insight}</Insight>}
      metrics={
        <>
          <MetricsPanel
            items={[
              {
                key: 'rps',
                label: 'Events',
                value: rate < 1 && rate > 0 ? `1 per ${TRICKLE_EVERY_S} s` : rate,
                unit: rate >= 1 ? 'per s' : undefined,
                tone: 'brand',
              },
              {
                key: 'instances',
                label: 'Instances',
                value: sim.instances.length,
                sub: `${busy} working`,
                hint: 'Function instances alive right now. Zero means scaled to zero.',
              },
              {
                key: 'cold',
                label: 'Cold starts',
                value: formatPercent(coldShare),
                tone: coldShare >= 0.2 ? 'warn' : 'ok',
                hint: `Share of the last ${WINDOW} invocations that waited for a new instance.`,
                simulated: true,
              },
              {
                key: 'latency',
                label: 'p95 functions',
                value: formatLatency(fnP95 === null ? null : fnP95 * 1000),
                hint: 'Start-up plus work for the last invocations that succeeded, no network time.',
                simulated: true,
              },
              {
                key: 'errorRate',
                label: 'Throttled / refused',
                value: `${formatPercent(throttledShare)} / ${formatPercent(refusedShare)}`,
                tone: throttledShare + refusedShare > 0 ? 'danger' : 'ok',
                hint: 'Throttled: over the concurrency limit. Refused: the database had no connection left.',
                simulated: true,
              },
              {
                key: 'connections',
                label: 'DB connections',
                value: `${connections}/${DB_MAX_CONNECTIONS}`,
                tone: connections >= DB_MAX_CONNECTIONS ? 'danger' : 'ok',
                hint: 'One per function instance. The always-on server uses a fixed pool instead.',
              },
            ]}
          />

          <div className="card p-4">
            <p className="label mb-3">Same events, two options</p>
            <div className="grid gap-4 sm:grid-cols-2 sm:gap-6">
              {[
                {
                  name: 'Functions',
                  per1000: fnPer1000,
                  total: sim.fnCost,
                  p95: fnP95,
                  extra: `${sim.coldStarts} cold starts, ${sim.throttled + sim.refused} failed`,
                  lower: cheaper === 'functions',
                },
                {
                  name: 'Always-on server',
                  per1000: serverPer1000,
                  total: sim.serverCost,
                  p95: serverP95,
                  extra: `0 cold starts, pays ${SERVER_PER_SECOND} units every second`,
                  lower: cheaper === 'server',
                },
              ].map((option) => (
                <div key={option.name}>
                  <p className="text-sm font-semibold text-ink">{option.name}</p>
                  <dl className="mt-2 space-y-1 font-mono text-xs">
                    <div className="flex justify-between gap-2">
                      <dt className="text-faint">Cost / 1,000 events</dt>
                      <dd className={option.lower ? 'text-ok' : 'text-ink'}>
                        {formatCost(option.per1000)}
                        {option.lower ? ' (lower)' : ''}
                      </dd>
                    </div>
                    <div className="flex justify-between gap-2">
                      <dt className="text-faint">Cost so far</dt>
                      <dd className="text-ink">{option.total.toFixed(1)}</dd>
                    </div>
                    <div className="flex justify-between gap-2">
                      <dt className="text-faint">p95 latency</dt>
                      <dd className="text-ink">{formatLatency(option.p95 === null ? null : option.p95 * 1000)}</dd>
                    </div>
                  </dl>
                  <p className="mt-2 text-[11px] text-muted">{option.extra}</p>
                </div>
              ))}
            </div>
            <p className="mt-3 text-[11px] text-faint">
              Simplified prices in made-up units: {FN_PER_SECOND} per busy function second (start-up included) +{' '}
              {FN_PER_REQUEST} per request, {PROVISIONED_PER_SECOND} per provisioned instance second,{' '}
              {SERVER_PER_SECOND} per server second. Not a real bill.
            </p>
          </div>

          <div className="card p-4">
            <p className="label mb-3">Events and instances</p>
            <LiveChart
              data={points}
              series={[
                { key: 'rate', label: 'Events per s', color: 'brand' },
                { key: 'instances', label: 'Instances', color: 'violet' },
              ]}
              variant="line"
              height={140}
              formatValue={(value) => value.toFixed(1)}
            />
            <p className="label mb-2 mt-4">Cost so far</p>
            <LiveChart
              data={points}
              series={[
                { key: 'fnCost', label: 'Functions', color: 'brand' },
                { key: 'serverCost', label: 'Always-on', color: 'violet', dashed: true },
              ]}
              variant="line"
              height={140}
              formatValue={(value) => value.toFixed(0)}
            />
          </div>
        </>
      }
      controls={
        <>
          <div>
            <p className="label mb-2">Traffic shape</p>
            <SegmentedControl<Shape>
              size="sm"
              value={setup.shape}
              onChange={(value) => update('shape', value)}
              options={[
                { value: 'steady', label: 'Steady' },
                { value: 'bursts', label: 'Bursts' },
                { value: 'trickle', label: 'Trickle' },
              ]}
            />
            <p className="mt-2 text-[11px] text-faint">{shapeHint}</p>
          </div>
          <Slider
            label="Peak rate"
            value={setup.peak}
            min={1}
            max={20}
            onChange={(value) => update('peak', value)}
            format={(value) => `${value} events/s`}
            disabled={setup.shape === 'trickle'}
            hint="Each event is 0.5 s of work, so 10 events/s keep about 5 instances busy."
          />
          <Slider
            label="Cold start"
            value={setup.coldStart}
            min={0.1}
            max={3}
            step={0.1}
            onChange={(value) => update('coldStart', value)}
            format={(value) => `${value.toFixed(1)} s`}
            tone="warn"
            hint="Under 0.1 s for a small Go function, a few hundred ms for Node or Python, seconds for a large JVM app."
          />
          <Slider
            label="Concurrency limit"
            value={setup.limit}
            min={1}
            max={MAX_LIMIT}
            onChange={(value) => update('limit', value)}
            format={(value) => `${value} instances`}
            tone="danger"
            hint="Above it the platform throttles. Protects the database and the bill."
          />
          <Slider
            label="Provisioned concurrency"
            value={setup.provisioned}
            min={0}
            max={Math.min(MAX_PROVISIONED, setup.limit)}
            onChange={(value) => update('provisioned', value)}
            format={(value) => `${value} warm`}
            tone="ok"
            hint="Instances kept warm all the time: no cold start for them, and a bill even when idle."
          />
          <div>
            <p className="label mb-2">Diagram shows</p>
            <SegmentedControl<View>
              size="sm"
              value={setup.view}
              onChange={(value) => update('view', value)}
              options={[
                { value: 'functions', label: 'Functions' },
                { value: 'server', label: 'Always-on server' },
              ]}
            />
            <p className="mt-2 text-[11px] text-faint">Both options get the same events and are priced side by side.</p>
          </div>
          <div className="border-t border-line pt-4">
            <p className="label mb-2 flex items-center gap-1.5">
              <Info className="h-3.5 w-3.5" />
              Simplified
            </p>
            <ul className="space-y-1 text-[11px] text-muted">
              <li>
                An idle instance is reclaimed after {IDLE_RECLAIM_S} s here. Real platforms keep it for minutes and do
                not publish the exact time.
              </li>
              <li>The database allows {DB_MAX_CONNECTIONS} connections here; real ones allow hundreds.</li>
              <li>One instance serves one request at a time, as on AWS Lambda.</li>
            </ul>
          </div>
        </>
      }
    >
      <DiagramCanvas layout={layout} edges={edges} particles={particleViews} height={380} className="bg-canvas">
        <ArchNode
          kind="client"
          title="Events"
          subtitle={rate > 0 && rate < 1 ? `1 per ${TRICKLE_EVERY_S} s` : `${rate} per s`}
          placed={layout.events}
          compact
        />
        {view === 'functions' ? (
          <>
            <ArchNode kind="api-gateway" title="Function platform" subtitle="routes, starts, reclaims" placed={layout.platform}>
              <NodeStatRow label="Instances" value={`${sim.instances.length}/${setup.limit}`} />
              <NodeStatRow label="Throttled" value={sim.throttled} tone={sim.throttled ? 'text-danger' : undefined} />
            </ArchNode>
            {sim.instances.map((instance) => {
              const shown = instanceState(instance);
              return (
                <ArchNode
                  key={instance.id}
                  kind="service"
                  title={`fn ${instance.slot + 1}`}
                  placed={layout[fnKey(instance)]}
                  status={shown.status}
                  statusLabel={shown.label}
                  compact
                >
                  <NodeStatRow
                    label="Type"
                    value={instance.provisioned ? 'provisioned' : 'on demand'}
                    tone={instance.provisioned ? 'text-brand' : 'text-muted'}
                  />
                </ArchNode>
              );
            })}
            {sim.instances.length === 0 ? (
              <div className="absolute left-[384px] top-[150px] w-[374px] rounded-xl border border-dashed border-line p-4 text-center text-xs text-faint">
                No instances: scaled to zero
              </div>
            ) : null}
          </>
        ) : (
          <ArchNode kind="server" title="Always-on server" subtitle={`${SERVER_THREADS} threads, runs all day`} placed={layout.server}>
            <Meter label="Threads busy" value={serverBusy / SERVER_THREADS} size="xs" />
            <NodeStatRow label="Busy" value={`${serverBusy}/${SERVER_THREADS}`} />
            <NodeStatRow label="Queued" value={serverQueued} tone={serverQueued ? 'text-warn' : undefined} />
          </ArchNode>
        )}
        <ArchNode kind="sql" title="Database" subtitle={`max ${DB_MAX_CONNECTIONS} connections`} placed={layout.db}>
          <NodeStatRow
            label="Open"
            value={view === 'functions' ? `${connections}/${DB_MAX_CONNECTIONS}` : `${SERVER_POOL} pooled`}
            tone={view === 'functions' && connections >= DB_MAX_CONNECTIONS ? 'text-danger' : undefined}
          />
        </ArchNode>
      </DiagramCanvas>
      <p className="px-4 pb-3 pt-1 text-[11px] text-faint">
        Circle: warm request. Triangle: waited for a cold start, or queued on the server. Cross: throttled, or no
        database connection.
      </p>
    </LabShell>
  );
}

export default ServerlessLab;
