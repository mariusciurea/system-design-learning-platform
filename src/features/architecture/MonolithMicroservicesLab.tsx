import { Fragment, useCallback, useRef } from 'react';
import { Rocket, Zap } from 'lucide-react';
import { ArchNode, DiagramCanvas, NodeStatRow, ParticleLegend, type DiagramEdge, type Layout, type ParticleView } from '@/components/architecture';
import { Insight, LabShell, MetricsPanel, type MetricItem } from '@/components/learning';
import { Button, Meter, SegmentedControl, Slider, Toggle } from '@/components/ui';
import {
  advanceParticles,
  MetricWindow,
  nextParticleId,
  RateCounter,
  useEventLog,
  useTicker,
  visualShare,
  type Particle,
} from '@/simulations/engine';
import { computeLoad } from '@/simulations/models/load';
import { useLabSetup } from '@/hooks/useLabSetup';
import { useRerender } from '@/hooks/useRerender';
import { sampleArrivals } from '@/utils/math';
import { formatLatency, formatNumber, formatPercent } from '@/utils/format';
import type { LabFocus, LabProps } from '@/types';
import { useLabRunning } from '@/hooks/useLabRunning';

/** The four architectures, from one process to one service per capability. */
type Mode = 'monolith' | 'modular' | 'soa' | 'microservices';

const MODE_OPTIONS: { value: Mode; label: string }[] = [
  { value: 'monolith', label: 'Monolith' },
  { value: 'modular', label: 'Modular' },
  { value: 'soa', label: 'SOA' },
  { value: 'microservices', label: 'Microservices' },
];

const MODE_NAME: Record<Mode, string> = {
  monolith: 'Monolith',
  modular: 'Modular monolith',
  soa: 'SOA with a service bus',
  microservices: 'Microservices',
};

/** How much work the enterprise service bus does per message. */
type BusLogic = 'routing' | 'transform' | 'orchestrate';

const BUS_LOGIC_OPTIONS: { value: BusLogic; label: string }[] = [
  { value: 'routing', label: 'Routing' },
  { value: 'transform', label: '+ Transform' },
  { value: 'orchestrate', label: '+ Orchestrate' },
];

const BUS_LOGIC_NAME: Record<BusLogic, string> = {
  routing: 'routing only',
  transform: 'routing and transformation',
  orchestrate: 'routing, transformation and orchestration',
};

/** Requests animated per second, independent of how much traffic is counted. */
const ANIMATED_PER_SECOND = 45;
const PARTICLE_BUDGET = 110;

const FEATURES = ['Users', 'Orders', 'Payments', 'Notifications'] as const;
type Feature = (typeof FEATURES)[number];

/** Share of traffic each capability receives. Orders is the hot path. */
const TRAFFIC_SHARE: Record<Feature, number> = {
  Users: 0.2,
  Orders: 0.5,
  Payments: 0.2,
  Notifications: 0.1,
};

/**
 * Synchronous service-to-service calls, caller -> callee. Every site that depends on the
 * dependency (demand, failures, routes, the diagram edge, the copy) is derived from this map.
 */
const CALLS: Partial<Record<Feature, Feature>> = { Orders: 'Payments' };

/** Share of a caller's requests that make its synchronous call (one extra hop). */
const SYNC_CALL_SHARE = 0.5;

/** Services that call `feature` synchronously - they fail with it. */
const callersOf = (feature: Feature) => FEATURES.filter((caller) => CALLS[caller] === feature);

/** The dependency map as [caller, callee] pairs, for the diagram and the copy. */
const CALL_PAIRS = FEATURES.flatMap((caller) => {
  const callee = CALLS[caller];
  return callee ? [[caller, callee] as const] : [];
});

/**
 * Traffic ceiling. Every failure the controls can cause has a control that fixes it:
 * Instances for the scaled services, Logic in the bus for the bus. The fixed
 * services are sized to stay under capacity at this maximum (the busiest,
 * Payments at 90% and Users at about 89%).
 */
const MAX_TRAFFIC = 2000;

/**
 * Fixed capacity of the microservices that do not scale (and of Payments once it
 * is extracted from the modular monolith). Payments is larger because it also
 * serves the synchronous calls Orders makes to it: at MAX_TRAFFIC it sees
 * 20% + 50% x 50% = 45% of traffic (900 req/s), Users 400 and Notifications 200 req/s.
 */
const FIXED_CAPACITY: Record<Exclude<Feature, 'Orders'>, number> = {
  Users: 450,
  Payments: 1000,
  Notifications: 450,
};

/** Requests per second each service receives: its own share plus calls from other services. */
const serviceDemand = (feature: Feature, traffic: number) =>
  callersOf(feature).reduce(
    (demand, caller) => demand + traffic * TRAFFIC_SHARE[caller] * SYNC_CALL_SHARE,
    traffic * TRAFFIC_SHARE[feature],
  );

// ---- SOA model (simplified, illustrative numbers) ---------------------------

/** SOA groups capabilities into a few coarse services. */
type Coarse = 'customer' | 'order';
const COARSE_OF: Record<Feature, Coarse> = {
  Users: 'customer',
  Notifications: 'customer',
  Orders: 'order',
  Payments: 'order',
};
const COARSE_NAME: Record<Coarse, string> = { customer: 'Customer Service', order: 'Order Service' };
const COARSE_KEYS: Coarse[] = ['customer', 'order'];
/** Capacity per instance of each coarse service. */
const COARSE_CAPACITY: Record<Coarse, number> = { customer: 350, order: 500 };
const featuresOf = (coarse: Coarse) => FEATURES.filter((feature) => COARSE_OF[feature] === coarse);

/**
 * Bus work per message, relative to plain routing. Transformation and
 * orchestration are business logic running inside the shared bus, so every
 * message costs the bus more. Illustrative, not measured.
 */
const BUS_COST: Record<BusLogic, number> = { routing: 1, transform: 1.5, orchestrate: 2.2 };
/** Messages per second the bus handles at routing-only cost. The Instances slider does not change it. */
const BUS_CAPACITY = 2200;
/** Share of Orders requests the orchestrating bus also sends to Customer Service (notify the buyer). */
const ORCHESTRATED_SHARE = 0.5;

// ---- Setup and Lab focus ----------------------------------------------------

interface Setup {
  mode: Mode;
  traffic: number;
  instances: number;
  broken: Feature | null;
  /** Modular monolith: modules reach each other only through their interfaces. */
  enforced: boolean;
  /** Modular monolith: Payments runs as its own service with its own database. */
  extracted: boolean;
  /** SOA: how much logic lives in the bus. */
  busLogic: BusLogic;
  /** SOA: a bad deploy of the shared bus. */
  busDown: boolean;
}

/** What the lab opens on at /labs/monolith-microservices, with no Lab focus. */
const DEFAULT_SETUP: Setup = {
  mode: 'monolith',
  traffic: 900,
  instances: 2,
  broken: null,
  enforced: true,
  extracted: false,
  busLogic: 'orchestrate',
  busDown: false,
};

/**
 * The Lab focus of each Concept that hosts this lab: each opens on its own
 * architecture. SOA opens with logic in the bus, so the bus is already the
 * hottest part and a few steps up in traffic saturate it.
 */
const FOCUS_SETUPS: Record<LabFocus<'monolith-microservices'>, Setup> = {
  // The same as the default today, on purpose: spelled out so it stays the monolith if the default moves.
  monolith: { ...DEFAULT_SETUP, mode: 'monolith' },
  'modular-monolith': { ...DEFAULT_SETUP, mode: 'modular', enforced: true, extracted: false },
  microservices: { ...DEFAULT_SETUP, mode: 'microservices' },
  'service-oriented-architecture': { ...DEFAULT_SETUP, mode: 'soa', busLogic: 'orchestrate' },
};

interface State {
  particles: Particle[];
  /**
   * Rolling rather than cumulative. Breaking a capability has to show up in the
   * error rate within a second or two; a lifetime average of a simulation that
   * has been healthy for a minute barely moves when something starts failing.
   */
  handled: RateCounter;
  failed: RateCounter;
  latency: MetricWindow;
}

const createState = (): State => ({
  particles: [],
  handled: new RateCounter(3000),
  failed: new RateCounter(3000),
  latency: new MetricWindow(400),
});

/** Picks a capability for one request, weighted by TRAFFIC_SHARE. */
const pickFeature = (): Feature => {
  const roll = Math.random();
  let cumulative = 0;
  for (const item of FEATURES) {
    cumulative += TRAFFIC_SHARE[item];
    if (roll <= cumulative) return item;
  }
  return 'Orders';
};

// ---- Layouts (960px design space) -------------------------------------------

const MONO_LAYOUT: Layout = {
  client: { x: 390, y: 20, w: 180, h: 74 },
  lb: { x: 390, y: 130, w: 180, h: 74 },
  app: { x: 300, y: 231, w: 360, h: 169 },
  db: { x: 390, y: 420, w: 180, h: 74 },
};

const MICRO_LAYOUT: Layout = {
  client: { x: 390, y: 14, w: 180, h: 74 },
  gateway: { x: 370, y: 110, w: 220, h: 74 },
  'svc-Users': { x: 40, y: 212, w: 190, h: 136 },
  'svc-Orders': { x: 260, y: 212, w: 190, h: 136 },
  'svc-Payments': { x: 480, y: 212, w: 190, h: 136 },
  'svc-Notifications': { x: 700, y: 212, w: 190, h: 136 },
  'db-Users': { x: 58, y: 390, w: 154, h: 76 },
  'db-Orders': { x: 278, y: 390, w: 154, h: 76 },
  'db-Payments': { x: 498, y: 390, w: 154, h: 76 },
  'db-Notifications': { x: 718, y: 390, w: 154, h: 76 },
};

/**
 * Module order in the modular monolith: Orders sits next to Payments, so the
 * Orders -> Payments call (and the leaky read of the payments tables) is a
 * short wire that crosses no other module, before and after extraction.
 */
const MODULE_ORDER: Feature[] = ['Users', 'Notifications', 'Orders', 'Payments'];
const MODULE_X = [30, 260, 490, 720];
const MODULE_W = 200;
const APP_ZONE = { y: 176, h: 160 };
const DATA_ZONE = { y: 352, h: 146 };
/** Where Payments goes once it is extracted: its own deploy, beside the monolith. */
const EXTRACTED_X = 742;
const EXTRACTED_W = 198;

const modularLayout = (extracted: boolean): Layout => {
  const layout: Layout = {
    client: { x: 390, y: 10, w: 180, h: 74 },
    lb: { x: 390, y: 92, w: 180, h: 70 },
  };
  MODULE_ORDER.forEach((feature, index) => {
    const out = extracted && feature === 'Payments';
    const x = out ? EXTRACTED_X : MODULE_X[index];
    const w = out ? EXTRACTED_W : MODULE_W;
    layout[`mod-${feature}`] = { x, y: APP_ZONE.y + 36, w, h: 106 };
    layout[`data-${feature}`] = { x, y: DATA_ZONE.y + 38, w, h: 80 };
  });
  return layout;
};

const SOA_LAYOUT: Layout = {
  client: { x: 390, y: 14, w: 180, h: 74 },
  bus: { x: 250, y: 100, w: 460, h: 136 },
  'svc-customer': { x: 80, y: 277, w: 280, h: 114 },
  'svc-order': { x: 600, y: 277, w: 280, h: 114 },
  db: { x: 380, y: 420, w: 200, h: 76 },
};

/** A dashed rectangle drawn under the nodes: a process or a database that holds several parts. */
function Zone({ x, y, w, h, label, tone = 'line' }: { x: number; y: number; w: number; h: number; label: string; tone?: 'line' | 'danger' }) {
  return (
    <g>
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        rx={14}
        className={
          tone === 'danger'
            ? 'fill-elevated stroke-danger'
            : 'fill-elevated stroke-line'
        }
        fillOpacity={0.55}
        strokeDasharray="6 5"
        strokeWidth={1.5}
      />
      <text x={x + 14} y={y + 22} className="fill-muted font-mono" style={{ fontSize: 11 }}>
        {label}
      </text>
    </g>
  );
}

// ---- Gains and costs, per architecture --------------------------------------

const COMPARISON: { dimension: string; text: Record<Mode, string> }[] = [
  {
    dimension: 'Deployment',
    text: {
      monolith: 'One pipeline, one artefact. Every team ships together.',
      modular: 'Still one artefact and one release train - but a module with clean boundaries can be extracted and shipped alone later.',
      soa: 'Services deploy separately, but a change to bus rules or shared schemas is a deploy every team depends on.',
      microservices: 'Each service deploys independently, on its own schedule.',
    },
  },
  {
    dimension: 'Scaling',
    text: {
      monolith: 'Scale the whole application, even if only one endpoint is hot.',
      modular: 'Same as a monolith: copies of the whole process. Only an extracted module scales on its own.',
      soa: 'Scale each coarse service - and the one central bus has to keep up with all of them.',
      microservices: 'Scale only the hot service - here, Orders.',
    },
  },
  {
    dimension: 'Fault isolation',
    text: {
      monolith: 'A crash or memory leak in one feature takes down everything.',
      modular: 'None at runtime: all modules share one process. The boundary is in the code, not the process.',
      soa: 'A crash takes its whole coarse service down; a bad bus deploy takes everything down.',
      microservices: 'A failed service degrades one capability, if callers handle it.',
    },
  },
  {
    dimension: 'Data',
    text: {
      monolith: 'One database, real transactions across features.',
      modular: 'One database, but each module owns its tables. Transactions across modules still work.',
      soa: 'Often one shared enterprise database and shared schemas.',
      microservices: 'A database per service - cross-service workflows need sagas.',
    },
  },
  {
    dimension: 'Latency',
    text: {
      monolith: 'In-process calls. No serialization, no network failures.',
      modular: 'In-process calls between modules, until one is extracted.',
      soa: 'Every request takes a hop through the bus, plus whatever work the bus does on it.',
      microservices: 'Every hop adds latency and a new way to fail.',
    },
  },
  {
    dimension: 'Operational cost',
    text: {
      monolith: 'One service to monitor, log and deploy.',
      modular: 'One service to run, plus the build rules that enforce the boundaries.',
      soa: 'A bus product with its own specialists, and central governance of every contract.',
      microservices: 'Service discovery, tracing, CI/CD and on-call per service.',
    },
  },
  {
    dimension: 'Development velocity',
    text: {
      monolith: 'Fast while the team is small; slows as the release train fills.',
      modular: 'Teams work in separate modules without stepping on each other, but still release together.',
      soa: 'A change that touches bus logic waits for the team that owns the bus.',
      microservices: 'Slower per change, but teams stop blocking each other.',
    },
  },
];

export function MonolithMicroservicesLab({ focus }: LabProps<'monolith-microservices'>) {
  // The page keys this lab by Concept, so the focus never changes under a mounted lab.
  const start = focus ? FOCUS_SETUPS[focus] : DEFAULT_SETUP;
  // Every control lives in one object, so Reset cannot miss one.
  const { setup, setSetup, change } = useLabSetup(start);
  const { mode, traffic, instances, broken, enforced, extracted, busLogic, busDown } = setup;
  const [running, setRunning] = useLabRunning();

  const state = useRef<State>(createState());
  const rerender = useRerender(30);
  const { events, log, clear } = useEventLog();

  const reset = useCallback(() => {
    // Back to this Concept's starting setup, not the lab's global default.
    setSetup(start);
    state.current = createState();
    clear();
  }, [clear, start, setSetup]);

  const modularExtracted = mode === 'modular' && extracted;

  // Monolith and modular monolith: all features share one process pool. An
  // extracted Payments no longer runs in it.
  const monolithCapacity = instances * 700;
  const monolithDemand = modularExtracted ? traffic * (1 - TRAFFIC_SHARE.Payments) : traffic;
  const monolithLoad = computeLoad(monolithDemand, monolithCapacity, { baseLatencyMs: 35, kneeAt: 0.65 });

  // Microservices: capacity per service. Only Orders scales with Instances.
  const serviceCapacity = (feature: Feature) => (feature === 'Orders' ? instances * 500 : FIXED_CAPACITY[feature]);
  const serviceLoads = Object.fromEntries(
    FEATURES.map((feature) => [
      feature,
      computeLoad(serviceDemand(feature, traffic), serviceCapacity(feature), { baseLatencyMs: 30, kneeAt: 0.65 }),
    ]),
  ) as Record<Feature, ReturnType<typeof computeLoad>>;
  // The extracted Payments service is sized like the Payments microservice.
  const paymentsLoad = serviceLoads.Payments;

  // SOA: every message passes through the bus; Instances scales the coarse services, never the bus.
  const busLoad = computeLoad(traffic * BUS_COST[busLogic], BUS_CAPACITY, {
    baseLatencyMs: 6 * BUS_COST[busLogic],
    kneeAt: 0.65,
  });
  const coarseDemand: Record<Coarse, number> = {
    customer:
      traffic * (TRAFFIC_SHARE.Users + TRAFFIC_SHARE.Notifications) +
      (busLogic === 'orchestrate' ? traffic * TRAFFIC_SHARE.Orders * ORCHESTRATED_SHARE : 0),
    order: traffic * (TRAFFIC_SHARE.Orders + TRAFFIC_SHARE.Payments),
  };
  const coarseLoads: Record<Coarse, ReturnType<typeof computeLoad>> = {
    customer: computeLoad(coarseDemand.customer, instances * COARSE_CAPACITY.customer, { baseLatencyMs: 30, kneeAt: 0.65 }),
    order: computeLoad(coarseDemand.order, instances * COARSE_CAPACITY.order, { baseLatencyMs: 30, kneeAt: 0.65 }),
  };
  const coarseDown = (coarse: Coarse) => broken !== null && COARSE_OF[broken] === coarse;

  /** Modular monolith: is the one process down? An extracted Payments crashing does not take it down. */
  const processDown = broken !== null && !(modularExtracted && broken === 'Payments');

  useTicker(running, (dt) => {
    const current = state.current;
    const now = performance.now();
    // Every request is counted; only a sample of them is animated.
    const arrivals = sampleArrivals(traffic, dt);
    const share = visualShare(traffic, ANIMATED_PER_SECOND);
    const animate = () => Math.random() < share;

    const record = (failed: boolean, latencyMs: number) => {
      if (failed) current.failed.add(1, now);
      else {
        current.handled.add(1, now);
        current.latency.push(latencyMs, now);
      }
    };
    const emit = (route: string[], outcome: Particle['outcome']) => {
      if (!animate()) return;
      current.particles.push({ id: nextParticleId(), route, leg: 0, t: 0, speed: 1.3, outcome });
    };

    for (let index = 0; index < arrivals; index += 1) {
      const feature = pickFeature();

      if (mode === 'monolith') {
        // A crash in any feature takes down the whole process.
        const failed = broken !== null || Math.random() < monolithLoad.errorRate;
        record(failed, monolithLoad.latencyMs);
        emit(
          failed ? ['client', 'lb', 'app'] : ['client', 'lb', 'app', 'db'],
          failed ? 'failure' : monolithLoad.cpu > 0.85 ? 'warning' : 'success',
        );
      } else if (mode === 'modular') {
        if (extracted && feature === 'Payments') {
          // The extracted service takes its own traffic straight from the load balancer.
          const failed = broken === 'Payments' || Math.random() < paymentsLoad.errorRate;
          record(failed, paymentsLoad.latencyMs);
          emit(
            failed ? ['client', 'lb', 'mod-Payments'] : ['client', 'lb', 'mod-Payments', 'data-Payments'],
            failed ? 'failure' : paymentsLoad.cpu > 0.85 ? 'warning' : 'success',
          );
          continue;
        }
        const ownFailure = processDown || Math.random() < monolithLoad.errorRate;
        const callsPayments = feature === 'Orders' && !ownFailure && Math.random() < SYNC_CALL_SHARE;
        // In process the call cannot fail on its own; once extracted it is a network call.
        const dependencyFailure =
          callsPayments && extracted && (broken === 'Payments' || Math.random() < paymentsLoad.errorRate);
        const failed = ownFailure || dependencyFailure;
        record(failed, monolithLoad.latencyMs + (callsPayments && extracted ? 12 + paymentsLoad.latencyMs : 0));
        let route: string[];
        if (ownFailure) route = ['client', 'lb', `mod-${feature}`];
        else if (!callsPayments) route = ['client', 'lb', `mod-${feature}`, `data-${feature}`];
        else if (!enforced) route = ['client', 'lb', 'mod-Orders', 'data-Payments']; // reads the payments tables directly
        else if (dependencyFailure) route = ['client', 'lb', 'mod-Orders', 'mod-Payments'];
        else route = ['client', 'lb', 'mod-Orders', 'mod-Payments', 'data-Payments'];
        const hot = monolithLoad.cpu > 0.85 || (callsPayments && extracted && paymentsLoad.cpu > 0.85);
        emit(route, failed ? 'failure' : hot ? 'warning' : 'success');
      } else if (mode === 'soa') {
        const coarse = COARSE_OF[feature];
        const busFailure = busDown || Math.random() < busLoad.errorRate;
        const ownFailure = !busFailure && (coarseDown(coarse) || Math.random() < coarseLoads[coarse].errorRate);
        // The orchestrating bus drives a second step itself: notify the buyer through Customer Service.
        const orchestrated =
          busLogic === 'orchestrate' && feature === 'Orders' && !busFailure && !ownFailure && Math.random() < ORCHESTRATED_SHARE;
        const stepFailure =
          orchestrated && (coarseDown('customer') || Math.random() < coarseLoads.customer.errorRate);
        const failed = busFailure || ownFailure || stepFailure;
        record(
          failed,
          busLoad.latencyMs +
            12 +
            coarseLoads[coarse].latencyMs +
            (orchestrated ? busLoad.latencyMs + 12 + coarseLoads.customer.latencyMs : 0),
        );
        const service = `svc-${coarse}`;
        let route: string[];
        if (busFailure) route = ['client', 'bus'];
        else if (ownFailure) route = ['client', 'bus', service];
        else if (orchestrated) route = ['client', 'bus', service, 'bus', 'svc-customer'];
        else route = ['client', 'bus', service, 'db'];
        const hot = busLoad.utilization > 0.85 || coarseLoads[coarse].cpu > 0.85;
        emit(route, failed ? 'failure' : hot ? 'warning' : 'success');
      } else {
        const load = serviceLoads[feature];
        const ownFailure = broken === feature || Math.random() < load.errorRate;
        // A synchronous call (Orders -> Payments) is one extra network hop, and the
        // caller is only as available as the callee: if the call fails, the request fails.
        const dependency = CALLS[feature];
        const callee = dependency && !ownFailure && Math.random() < SYNC_CALL_SHARE ? dependency : undefined;
        const dependencyFailure =
          callee !== undefined && (broken === callee || Math.random() < serviceLoads[callee].errorRate);
        const failed = ownFailure || dependencyFailure;
        record(failed, load.latencyMs + 12 + (callee ? serviceLoads[callee].latencyMs : 0));
        // A failed service is where the particle stops; a failed call stops at the callee.
        const route = ['client', 'gateway', `svc-${feature}`];
        if (callee) {
          route.push(`svc-${callee}`);
          if (!dependencyFailure) route.push(`db-${callee}`);
        } else if (!ownFailure) {
          route.push(`db-${feature}`);
        }
        emit(route, failed ? 'failure' : load.cpu > 0.85 ? 'warning' : 'success');
      }
    }

    const { alive } = advanceParticles(current.particles, dt);
    current.particles = alive.length > PARTICLE_BUDGET ? alive.slice(-PARTICLE_BUDGET) : alive;
    rerender();
  });

  const current = state.current;
  const now = performance.now();
  const failedQps = current.failed.rate(now);
  const servedQps = current.handled.rate(now) + failedQps;
  const errorRate = servedQps ? failedQps / servedQps : 0;
  // With every request failing (or none sent within the MetricWindow horizon) there is no
  // latency to average - the window reports null and it renders as a dash,
  // instead of a 0 ms that reads as "very fast" or a stale last value.
  const latencyText = formatLatency(current.latency.snapshot(now).avg);

  const layout =
    mode === 'monolith' ? MONO_LAYOUT : mode === 'modular' ? modularLayout(extracted) : mode === 'soa' ? SOA_LAYOUT : MICRO_LAYOUT;
  const brokenCallers = broken ? callersOf(broken) : [];

  let edges: DiagramEdge[];
  if (mode === 'monolith') {
    edges = [
      { from: 'client', to: 'lb', tone: 'brand', width: 2 },
      { from: 'lb', to: 'app', tone: 'ok', width: 2 },
      { from: 'app', to: 'db', tone: 'info' },
    ];
  } else if (mode === 'modular') {
    edges = [
      { from: 'client', to: 'lb', tone: 'brand', width: 2 },
      ...MODULE_ORDER.map<DiagramEdge>((feature) => {
        const down = extracted && feature === 'Payments' ? broken === 'Payments' : processDown;
        return { from: 'lb', to: `mod-${feature}`, tone: down ? 'muted' : 'ok', dashed: down };
      }),
      ...MODULE_ORDER.map<DiagramEdge>((feature) => ({ from: `mod-${feature}`, to: `data-${feature}`, tone: 'info' })),
      enforced
        ? extracted
          ? // Now a network call: it can time out and fail on its own.
            { from: 'mod-Orders', to: 'mod-Payments', tone: broken === 'Payments' ? 'danger' : 'warn', dashed: true }
          : { from: 'mod-Orders', to: 'mod-Payments', tone: 'ok' }
        : // The shortcut that blocks extraction: Orders queries the payments tables itself.
          { from: 'mod-Orders', to: 'data-Payments', tone: 'danger', dashed: true },
    ];
  } else if (mode === 'soa') {
    edges = [
      { from: 'client', to: 'bus', tone: 'brand', width: 2 },
      ...COARSE_KEYS.map<DiagramEdge>((coarse) => ({
        from: 'bus',
        to: `svc-${coarse}`,
        tone: busDown || coarseDown(coarse) ? 'muted' : busLogic === 'routing' ? 'ok' : 'warn',
        dashed: busDown || coarseDown(coarse),
        width: 2,
      })),
      ...COARSE_KEYS.map<DiagramEdge>((coarse) => ({ from: `svc-${coarse}`, to: 'db', tone: 'info' })),
    ];
  } else {
    edges = [
      { from: 'client', to: 'gateway', tone: 'brand', width: 2 },
      ...FEATURES.map<DiagramEdge>((feature) => ({
        from: 'gateway',
        to: `svc-${feature}`,
        tone: broken === feature ? 'muted' : 'ok',
        dashed: broken === feature,
      })),
      ...FEATURES.map<DiagramEdge>((feature) => ({
        from: `svc-${feature}`,
        to: `db-${feature}`,
        tone: 'info',
      })),
      // No edge label: the two cards are 30px apart, so any label lands behind a
      // node. The caller card subtitle says "calls Payments" instead.
      ...CALL_PAIRS.map<DiagramEdge>(([caller, callee]) => ({
        from: `svc-${caller}`,
        to: `svc-${callee}`,
        tone: broken === callee ? 'danger' : 'warn',
        dashed: true,
      })),
    ];
  }

  const particleViews: ParticleView[] = current.particles
    .filter((particle) => layout[particle.route[particle.leg]] && layout[particle.route[particle.leg + 1]])
    .map((particle) => ({
      id: particle.id,
      from: particle.route[particle.leg],
      to: particle.route[particle.leg + 1],
      t: particle.t,
      outcome: particle.outcome ?? 'success',
    }));

  const deployUnits = mode === 'monolith' ? 1 : mode === 'modular' ? (extracted ? 2 : 1) : mode === 'soa' ? 3 : FEATURES.length;
  const databases = mode === 'monolith' ? 1 : mode === 'modular' ? (extracted ? 2 : 1) : mode === 'soa' ? 1 : FEATURES.length;
  const hops =
    mode === 'monolith' ? '2' : mode === 'modular' ? (extracted ? '2-3' : '2') : mode === 'soa' ? (busLogic === 'orchestrate' ? '2-4' : '2') : '2-3';

  // What stops working when one part fails.
  let blast = 'None';
  let blastTone: MetricItem['tone'] = 'ok';
  if (mode === 'soa' && busDown) {
    blast = 'All features';
    blastTone = 'danger';
  } else if (broken) {
    if (mode === 'monolith' || (mode === 'modular' && !extracted)) {
      blast = 'All features';
      blastTone = 'danger';
    } else if (mode === 'modular') {
      blast = broken === 'Payments' ? 'Payments + some Orders' : 'All but Payments';
      blastTone = broken === 'Payments' ? 'warn' : 'danger';
    } else if (mode === 'soa') {
      const coarse = COARSE_OF[broken];
      blast = featuresOf(coarse).join(' + ') + (coarse === 'customer' && busLogic === 'orchestrate' ? ' + some Orders' : '');
      blastTone = 'warn';
    } else {
      blast = brokenCallers.length > 0 ? `${broken} + some ${brokenCallers.join(' + ')}` : `${broken} only`;
      blastTone = 'warn';
    }
  }

  const breakMessage = (feature: Feature) => {
    if (mode === 'monolith') return `${feature} crashed - the whole monolith process is down`;
    if (mode === 'modular') {
      if (extracted && feature === 'Payments') return 'Payments service down - Orders requests that call it fail too';
      if (extracted) return `${feature} module crashed the monolith process - the extracted Payments service keeps serving`;
      return `${feature} module crashed the process - every module is down with it`;
    }
    if (mode === 'soa') {
      const coarse = COARSE_OF[feature];
      const others = featuresOf(coarse).filter((item) => item !== feature);
      return `${feature} crashed the ${COARSE_NAME[coarse]} - ${others.join(' and ')} is down with it`;
    }
    return callersOf(feature).length > 0
      ? `${feature} service down - ${callersOf(feature).join(' and ')} requests that call it fail too`
      : `${feature} service down - other services unaffected`;
  };

  const modeMetrics: MetricItem[] =
    mode === 'modular'
      ? [
          {
            key: 'crossReads',
            label: 'Cross-module reads',
            value: enforced ? 'None' : 'Orders -> payments',
            tone: enforced ? 'ok' : 'danger',
            hint: 'Queries one module makes into the tables another module owns. Each one must be rewritten before that module can be extracted.',
          },
        ]
      : mode === 'soa'
        ? [
            {
              key: 'busCpu',
              label: 'Bus CPU',
              value: busDown ? 'Down' : formatPercent(busLoad.cpu),
              tone: busDown || busLoad.saturated ? 'danger' : busLoad.utilization > 0.85 ? 'warn' : 'ok',
              hint: 'Every request passes through the one shared bus. The Instances slider does not add bus capacity.',
              simulated: true,
            },
          ]
        : [];

  const instancesHint: Record<Mode, string> = {
    monolith: 'Copies of the whole application - every feature scales together.',
    modular: extracted
      ? 'Copies of the monolith process. The extracted Payments service is sized on its own.'
      : 'Copies of the whole process - every module scales together.',
    soa: 'Copies of each coarse service. The bus is one shared layer and does not scale with this slider.',
    microservices: 'Copies of the Orders service, the hot path. Others stay fixed.',
  };

  const insight = (() => {
    if (mode === 'soa') {
      if (busDown)
        return (
          <>
            A bad deploy of the shared bus took <strong className="text-ink">every</strong> capability down. Both services
            are healthy, but nothing can reach them. The bus is one layer every team depends on, so a release of the bus
            is a release for everyone.
          </>
        );
      if (broken) {
        const coarse = COARSE_OF[broken];
        return (
          <>
            {broken} lives inside the coarse {COARSE_NAME[coarse]}, so {featuresOf(coarse).filter((item) => item !== broken).join(' and ')}{' '}
            went down with it
            {coarse === 'customer' && busLogic === 'orchestrate'
              ? ', and so did the Orders requests the bus orchestrates through Customer Service'
              : ''}
            . Coarse services mean a wider blast radius than one service per capability.
          </>
        );
      }
      return (
        <>
          Every request passes through the enterprise service bus, which here does {BUS_LOGIC_NAME[busLogic]}. Bus CPU is{' '}
          {formatPercent(busLoad.cpu)} and latency is {latencyText}. Raise Traffic and the bus saturates first; more
          Instances do not help, because they scale the services, not the bus. Move the logic back into the services
          (Routing only) and the bus has room again - smart endpoints, dumb pipes.
        </>
      );
    }
    if (mode === 'modular') {
      if (broken && !(extracted && broken === 'Payments'))
        return (
          <>
            The {broken} module crashed the process. Modules are a code boundary, not a process boundary, so{' '}
            {extracted ? 'every module still inside the monolith is down - only the extracted Payments service keeps serving.' : 'every module is down with it.'}
          </>
        );
      if (broken)
        return (
          <>
            The extracted Payments service is down. The monolith keeps serving Users, Notifications and most Orders, but
            every Orders request that calls Payments now fails with it - a network call is a new way to fail.
          </>
        );
      if (!enforced)
        return (
          <>
            Orders now reads the payments tables directly (the red wire). Nothing looks different at runtime - the cost
            shows when you try to extract Payments: every such query must be rewritten first, so Extract is blocked.
            Turn the boundaries back on.
          </>
        );
      if (extracted)
        return (
          <>
            Payments now runs as its own service with its own database. The Orders call to it is a network hop (latency
            is {latencyText}), and a Payments crash no longer takes the monolith down. It took one switch because the
            interface and the table ownership already existed.
          </>
        );
      return (
        <>
          One process and one database, like the monolith - but each module owns its tables and the others reach it only
          through its interface. At runtime it behaves exactly like the monolith (latency {latencyText}); the gain is in
          the code. Try Extract Payments, then try it with the boundaries off.
        </>
      );
    }
    if (broken) {
      if (mode === 'monolith')
        return (
          <>
            The {broken} feature crashed the process. In a monolith there is one process, so{' '}
            <strong className="text-ink">every</strong> capability is down - including checkout, which has nothing to
            do with the bug.
          </>
        );
      return brokenCallers.length > 0 ? (
        <>
          {broken} is down, and so is every {brokenCallers.join(' and ')} request that calls it synchronously -{' '}
          {FEATURES.filter((feature) => feature !== broken && !brokenCallers.includes(feature)).join(' and ')} keep
          serving, but {brokenCallers.join(' and ')} fails whenever it needs {broken}. Fault isolation only holds where
          there is no synchronous dependency, or where the caller degrades gracefully instead of failing with it.
        </>
      ) : (
        <>
          The {broken} service is down, but the other three keep serving. Fault isolation is real - as long as callers
          degrade gracefully instead of blocking on a dead dependency.
        </>
      );
    }
    if (mode === 'monolith')
      return (
        <>
          One deployment, one database, in-process calls. Average latency is {latencyText} with no network hops between
          features. The costs are coarse scaling and a shared release train - not performance.
        </>
      );
    return (
      <>
        Each service scales and fails on its own, at the price of network hops: latency is {latencyText}
        {CALL_PAIRS.map(([caller, callee]) => (
          <Fragment key={caller}>
            , and the synchronous {caller} {'->'} {callee} call means {caller} is only as available as {callee}
          </Fragment>
        ))}
        . Microservices are an organisational tool before they are a technical one.
      </>
    );
  })();

  const underlay =
    mode === 'modular' ? (
      <>
        <Zone
          x={15}
          y={APP_ZONE.y}
          w={extracted ? 695 : 920}
          h={APP_ZONE.h}
          label={`Application x${instances} - one deployable unit, one process`}
          tone={processDown ? 'danger' : 'line'}
        />
        <Zone
          x={15}
          y={DATA_ZONE.y}
          w={extracted ? 695 : 920}
          h={DATA_ZONE.h}
          label={enforced ? 'One database - each module owns its tables' : 'One database - Orders reads payments tables'}
          tone={enforced ? 'line' : 'danger'}
        />
        {extracted ? (
          <>
            <Zone x={730} y={APP_ZONE.y} w={222} h={APP_ZONE.h} label="Own deployable unit" tone={broken === 'Payments' ? 'danger' : 'line'} />
            <Zone x={730} y={DATA_ZONE.y} w={222} h={DATA_ZONE.h} label="Own database" />
          </>
        ) : null}
      </>
    ) : undefined;

  return (
    <LabShell
      title="Monolith to Microservices Lab"
      description="One product, four architectures: a monolith, a modular monolith, SOA with a service bus, and microservices. Send traffic, break a part, and compare what actually changes."
      running={running}
      onRunningChange={setRunning}
      onReset={reset}
      legend={
        <ParticleLegend
          outcomes={['success', { outcome: 'warning', label: 'Served, near capacity' }, 'failure']}
        />
      }
      events={events}
      actions={
        <SegmentedControl
          size="sm"
          className="flex-wrap"
          value={mode}
          options={MODE_OPTIONS}
          onChange={(value) => {
            change('mode')(value);
            state.current = createState();
            log(`Switched to ${MODE_NAME[value]}`, 'info');
          }}
        />
      }
      insight={<Insight>{insight}</Insight>}
      metrics={
        <>
          <MetricsPanel
            items={[
              { key: 'rps', label: 'Traffic', value: formatNumber(traffic), unit: 'req/s', tone: 'brand' },
              {
                key: 'latency',
                label: 'Avg latency',
                value: latencyText,
                hint: 'Average over successful requests. Shows a dash when no request succeeded in the last few seconds.',
                simulated: true,
              },
              {
                key: 'errorRate',
                label: 'Error rate',
                value: formatPercent(errorRate, 1),
                tone: errorRate > 0.05 ? 'danger' : 'ok',
                simulated: true,
              },
              { key: 'blast', label: 'Blast radius', value: blast, tone: blastTone, hint: 'What stops working when one part fails.' },
              {
                key: 'deployUnits',
                label: 'Deployable units',
                value: deployUnits,
                hint:
                  mode === 'soa'
                    ? 'The bus and two coarse services. The bus is shared: a rule change there is a deploy every service depends on.'
                    : 'How many things can ship independently.',
              },
              {
                key: 'databases',
                label: 'Databases',
                value: databases,
                hint:
                  mode === 'soa'
                    ? 'SOA services commonly share one enterprise database and its schema.'
                    : mode === 'microservices'
                      ? 'Microservices own their data - no shared schema.'
                      : 'One database, shared by every feature or module in the process.',
              },
              ...modeMetrics,
            ]}
          />

          <div className="card overflow-hidden">
            <p className="label border-b border-line px-4 py-3">{MODE_NAME[mode]}: what it gains and what it costs</p>
            <div className="divide-y divide-line">
              {COMPARISON.map((row) => (
                <div key={row.dimension} className="grid gap-1 px-4 py-3 sm:grid-cols-[150px_1fr] sm:gap-3">
                  <p className="text-xs font-semibold text-ink">{row.dimension}</p>
                  <p className="text-xs text-muted">{row.text[mode]}</p>
                </div>
              ))}
            </div>
            <p className="border-t border-line px-4 py-3 text-xs text-faint">
              No architecture is the winner. Switch between the four above: the question is which costs you can afford
              and which benefits you actually need right now.
            </p>
          </div>
        </>
      }
      controls={
        <>
          <Slider
            label="Traffic"
            value={traffic}
            min={100}
            max={MAX_TRAFFIC}
            step={100}
            onChange={change('traffic')}
            format={(value) => `${formatNumber(value)} req/s`}
            hint="Capped so every overload has a control that fixes it."
          />
          <Slider
            label="Instances"
            value={instances}
            min={1}
            max={8}
            onChange={change('instances')}
            format={(value) => `${value}`}
            hint={instancesHint[mode]}
          />

          {mode === 'modular' ? (
            <div className="space-y-3 border-y border-line py-4">
              <Toggle
                label="Enforce module boundaries"
                checked={enforced}
                disabled={extracted}
                onChange={(value) => {
                  change('enforced')(value);
                  log(
                    value
                      ? 'Boundaries enforced - Orders reaches payments data only through the Payments interface'
                      : 'Boundaries off - Orders now queries the payments tables directly',
                    value ? 'ok' : 'warn',
                  );
                }}
                description={extracted ? 'Undo the extraction first.' : 'Off: Orders queries the payments tables itself.'}
              />
              <Toggle
                label="Extract Payments into a service"
                checked={extracted}
                disabled={!enforced}
                onChange={(value) => {
                  change('extracted')(value);
                  state.current = createState();
                  log(
                    value
                      ? 'Payments extracted - its interface is now a network call, its tables moved to its own database'
                      : 'Payments folded back into the monolith',
                    'info',
                  );
                }}
                description={
                  enforced
                    ? 'Its interface becomes a network call; its tables move out.'
                    : 'Blocked: Orders reads the payments tables directly.'
                }
              />
            </div>
          ) : null}

          {mode === 'soa' ? (
            <div className="space-y-3 border-y border-line py-4">
              <div className="space-y-2">
                <p className="text-xs font-medium text-muted">Logic in the bus</p>
                <SegmentedControl
                  size="sm"
                  className="flex-wrap"
                  value={busLogic}
                  options={BUS_LOGIC_OPTIONS}
                  onChange={(value) => {
                    change('busLogic')(value);
                    log(`Bus now does ${BUS_LOGIC_NAME[value]}`, value === 'routing' ? 'ok' : 'warn');
                  }}
                />
              </div>
              <Button
                size="sm"
                variant={busDown ? 'success' : 'secondary'}
                className="w-full justify-center"
                onClick={() => {
                  change('busDown')(!busDown);
                  state.current = createState();
                  log(busDown ? 'Bus rolled back - traffic flows again' : 'Bad bus deploy - every service is unreachable', busDown ? 'ok' : 'danger');
                }}
              >
                {busDown ? 'Roll back the bus' : 'Bad bus deploy'}
              </Button>
            </div>
          ) : null}

          <div className="space-y-2">
            <p className="text-xs font-medium text-muted">Break a capability</p>
            {FEATURES.map((feature) => (
              <Button
                key={feature}
                size="sm"
                variant={broken === feature ? 'success' : 'secondary'}
                className="w-full justify-center"
                onClick={() => {
                  const next = broken === feature ? null : feature;
                  change('broken')(next);
                  state.current = createState();
                  log(next ? breakMessage(feature) : `${feature} recovered`, next ? 'danger' : 'ok');
                }}
              >
                {broken === feature ? `Recover ${feature}` : `Break ${feature}`}
              </Button>
            ))}
          </div>
          <div className="border-t border-line pt-4">
            <p className="label mb-2">Utilization</p>
            {mode === 'monolith' ? (
              <Meter label="Application" value={broken ? 0 : monolithLoad.cpu} />
            ) : mode === 'modular' ? (
              <>
                <Meter label="Application" value={processDown ? 0 : monolithLoad.cpu} size="xs" className="mb-1.5" />
                {extracted ? <Meter label="Payments service" value={broken === 'Payments' ? 0 : paymentsLoad.cpu} size="xs" /> : null}
              </>
            ) : mode === 'soa' ? (
              <>
                <Meter label="Enterprise bus" value={busDown ? 0 : busLoad.cpu} size="xs" className="mb-1.5" />
                {COARSE_KEYS.map((coarse) => (
                  <Meter
                    key={coarse}
                    label={COARSE_NAME[coarse]}
                    value={coarseDown(coarse) ? 0 : coarseLoads[coarse].cpu}
                    size="xs"
                    className="mb-1.5"
                  />
                ))}
              </>
            ) : (
              FEATURES.map((feature) => (
                <Meter
                  key={feature}
                  label={feature}
                  value={broken === feature ? 0 : serviceLoads[feature].cpu}
                  size="xs"
                  className="mb-1.5"
                />
              ))
            )}
          </div>
        </>
      }
    >
      <DiagramCanvas layout={layout} edges={edges} particles={particleViews} underlay={underlay} height={505} className="bg-canvas">
        {mode === 'monolith' ? (
          <>
            <ArchNode kind="client" title="Clients" subtitle={`${formatNumber(traffic)} req/s`} placed={layout.client} compact />
            <ArchNode kind="load-balancer" title="Load Balancer" placed={layout.lb} compact />
            <ArchNode
              kind="server"
              title={`Application x${instances}`}
              subtitle="one deployable unit"
              placed={layout.app}
              status={broken ? 'down' : monolithLoad.errorRate > 0.2 ? 'degraded' : 'healthy'}
              alert={monolithLoad.saturated}
            >
              <div className="flex flex-wrap gap-1.5 pb-1">
                {FEATURES.map((feature) => (
                  <span
                    key={feature}
                    className={
                      broken === feature
                        ? 'rounded-md border border-danger bg-danger/10 px-2 py-0.5 text-[11px] text-danger line-through'
                        : 'rounded-md border border-line px-2 py-0.5 text-[11px] text-muted'
                    }
                  >
                    {feature}
                  </span>
                ))}
              </div>
              <Meter label="CPU" value={broken ? 0 : monolithLoad.cpu} size="xs" />
              <NodeStatRow label="Latency" value={formatLatency(monolithLoad.latencyMs)} />
            </ArchNode>
            <ArchNode kind="sql" title="Database" subtitle="shared by all features" placed={layout.db} compact />
          </>
        ) : mode === 'modular' ? (
          <>
            <ArchNode kind="client" title="Clients" subtitle={`${formatNumber(traffic)} req/s`} placed={layout.client} compact />
            <ArchNode kind="load-balancer" title="Load Balancer" placed={layout.lb} compact />
            {MODULE_ORDER.map((feature) => {
              const out = extracted && feature === 'Payments';
              const down = out ? broken === 'Payments' : processDown;
              const load = out ? paymentsLoad : monolithLoad;
              return (
                <ArchNode
                  key={`mod-${feature}`}
                  kind="service"
                  title={out ? 'Payments Service' : `${feature} module`}
                  subtitle={
                    out
                      ? 'own deploy, x1'
                      : feature === 'Orders' && !enforced
                        ? 'reads payments tables'
                        : feature === 'Payments'
                          ? enforced
                            ? 'called via interface'
                            : 'bypassed by Orders'
                          : 'public interface only'
                  }
                  placed={layout[`mod-${feature}`]}
                  status={down ? 'down' : load.errorRate > 0.2 ? 'degraded' : 'healthy'}
                  alert={!down && load.saturated}
                >
                  <NodeStatRow label="Share" value={formatPercent(TRAFFIC_SHARE[feature])} />
                </ArchNode>
              );
            })}
            {MODULE_ORDER.map((feature) => {
              const out = extracted && feature === 'Payments';
              return (
                <ArchNode
                  key={`data-${feature}`}
                  kind="sql"
                  title={out ? 'Payments DB' : `${feature} tables`}
                  subtitle={out ? 'own database' : feature === 'Payments' && !enforced ? 'read by Orders too' : 'owned by its module'}
                  placed={layout[`data-${feature}`]}
                  alert={feature === 'Payments' && !enforced}
                  compact
                />
              );
            })}
          </>
        ) : mode === 'soa' ? (
          <>
            <ArchNode kind="client" title="Clients" subtitle={`${formatNumber(traffic)} req/s`} placed={layout.client} compact />
            <ArchNode
              kind="api-gateway"
              title="Enterprise Service Bus"
              subtitle={BUS_LOGIC_NAME[busLogic]}
              placed={layout.bus}
              status={busDown ? 'down' : busLoad.errorRate > 0.2 ? 'degraded' : 'healthy'}
              alert={!busDown && busLoad.utilization > 0.85}
            >
              <Meter label="CPU" value={busDown ? 0 : busLoad.cpu} size="xs" />
              <NodeStatRow label="Work per message" value={`x${BUS_COST[busLogic]}`} />
            </ArchNode>
            {COARSE_KEYS.map((coarse) => (
              <ArchNode
                key={coarse}
                kind="service"
                title={COARSE_NAME[coarse]}
                subtitle={`${featuresOf(coarse).join(' + ')}, x${instances}`}
                placed={layout[`svc-${coarse}`]}
                status={coarseDown(coarse) ? 'down' : coarseLoads[coarse].errorRate > 0.2 ? 'degraded' : 'healthy'}
                alert={!coarseDown(coarse) && coarseLoads[coarse].saturated}
              >
                <Meter label="CPU" value={coarseDown(coarse) ? 0 : coarseLoads[coarse].cpu} size="xs" />
              </ArchNode>
            ))}
            <ArchNode kind="sql" title="Enterprise DB" subtitle="shared schema" placed={layout.db} compact />
          </>
        ) : (
          <>
            <ArchNode kind="client" title="Clients" subtitle={`${formatNumber(traffic)} req/s`} placed={layout.client} compact />
            <ArchNode kind="api-gateway" title="API Gateway" subtitle="routing + auth" placed={layout.gateway} compact />
            {FEATURES.map((feature) => (
              <ArchNode
                key={feature}
                kind="service"
                title={`${feature} Service`}
                subtitle={[feature === 'Orders' ? `x${instances}` : 'x1', CALLS[feature] && `calls ${CALLS[feature]}`]
                  .filter(Boolean)
                  .join(', ')}
                placed={layout[`svc-${feature}`]}
                status={broken === feature ? 'down' : serviceLoads[feature].errorRate > 0.2 ? 'degraded' : 'healthy'}
                alert={serviceLoads[feature].saturated}
              >
                <Meter label="CPU" value={broken === feature ? 0 : serviceLoads[feature].cpu} size="xs" />
                <NodeStatRow label="Share" value={formatPercent(TRAFFIC_SHARE[feature])} />
              </ArchNode>
            ))}
            {FEATURES.map((feature) => (
              <ArchNode
                key={`db-${feature}`}
                kind="sql"
                title={`${feature} DB`}
                placed={layout[`db-${feature}`]}
                status={broken === feature ? 'degraded' : 'healthy'}
                compact
              />
            ))}
          </>
        )}
      </DiagramCanvas>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 pb-3 pt-1 text-[11px] text-faint">
        <span className="flex items-center gap-1.5">
          <Rocket className="h-3.5 w-3.5" /> Deployable units: {deployUnits}
        </span>
        <span className="flex items-center gap-1.5">
          <Zap className="h-3.5 w-3.5" /> Network hops per request: {hops}
        </span>
        <span className="ml-auto">Simplified load model - latency, errors and bus cost are illustrative, not measured.</span>
      </div>
    </LabShell>
  );
}

export default MonolithMicroservicesLab;
