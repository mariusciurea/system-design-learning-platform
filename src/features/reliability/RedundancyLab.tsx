import { useCallback, useRef, type ReactNode } from 'react';
import { ArrowUpFromLine, Dices, Target, Wrench, Zap } from 'lucide-react';
import {
  ArchNode,
  DiagramCanvas,
  NodeStatRow,
  ParticleLegend,
  type DiagramEdge,
  type EdgeTone,
  type Layout,
  type ParticleView,
} from '@/components/architecture';
import { LiveChart } from '@/components/charts';
import { Insight, LabShell, MetricsPanel, SIMULATED_HINT } from '@/components/learning';
import { Button, SegmentedControl, Slider, Stepper, Toggle } from '@/components/ui';
import { advanceParticles, nextParticleId, useEventLog, useSeries, useTicker, type Particle } from '@/simulations/engine';
import { useLabSetup } from '@/hooks/useLabSetup';
import { useRerender } from '@/hooks/useRerender';
import { sampleArrivals } from '@/utils/math';
import { formatNumber, formatPercent, formatSeconds } from '@/utils/format';
import { cn } from '@/utils/cn';
import type { LabFocus, LabProps, NodeKind, NodeStatus, RequestOutcome } from '@/types';
import {
  APP_CAPACITY,
  MANUAL_FAILOVER_SEC,
  MAX_COPIES,
  PROMOTE_SEC,
  REPAIR_HOURS,
  TIER_LABEL,
  WRITE_SHARE,
  ZONE_AVAILABILITY,
  designAvailability,
  downtimeFor,
  formatAvailability,
  zoneOf,
  type FailoverMode,
  type Replication,
  type Tier,
  type Zone,
} from './redundancyModel';
import { useLabRunning } from '@/hooks/useLabRunning';

interface Setup {
  lbCopies: number;
  appCopies: number;
  configCopies: number;
  standby: boolean;
  zones: 1 | 2;
  failover: FailoverMode;
  replication: Replication;
  /** Seconds the standby is behind the primary with async replication. */
  lagSec: number;
  partAvailability: number;
  traffic: number;
  detectSec: number;
}

/** What the Lab opens on at /labs/redundancy, with no Lab focus: one copy of everything. */
const DEFAULT_SETUP: Setup = {
  lbCopies: 1,
  appCopies: 1,
  configCopies: 1,
  standby: false,
  zones: 1,
  failover: 'automatic',
  replication: 'async',
  lagSec: 1,
  partAvailability: 0.999,
  traffic: 80,
  detectSec: 10,
};

/** Every tier doubled, across two zones, with an automatic database failover. */
const SPARES_EVERYWHERE: Setup = {
  ...DEFAULT_SETUP,
  lbCopies: 2,
  appCopies: 3,
  configCopies: 2,
  standby: true,
  zones: 2,
  traffic: 150,
};

/**
 * The Lab focus of each Concept that hosts this Lab.
 * - Availability opens on parts that are each up 99%, so the nines and the downtime a year
 *   they allow are the first numbers on screen, and moving one control moves them tenfold.
 * - Redundancy opens with one copy of each part, so the learner adds the spares.
 * - Fault tolerance opens with spares everywhere, so the learner kills parts and it keeps serving.
 * - High availability opens at 99.80% against a 99.99% target: reaching it takes a second
 *   config copy, automatic failover and a second zone - no one change is enough.
 * - Single point of failure opens looking redundant, with one config service nobody doubled.
 * - Failover opens on a primary and a standby, async with 1 s of lag, so killing the primary
 *   shows the failover gap and the writes lost at the switch.
 */
const FOCUS_SETUPS: Record<LabFocus<'redundancy'>, Setup> = {
  availability: { ...DEFAULT_SETUP, partAvailability: 0.99 },
  // The same as the default today, on purpose: spelled out so it stays one copy each if the default moves.
  redundancy: { ...DEFAULT_SETUP },
  'fault-tolerance': { ...SPARES_EVERYWHERE },
  'high-availability': {
    ...DEFAULT_SETUP,
    lbCopies: 2,
    appCopies: 2,
    configCopies: 1,
    standby: true,
    failover: 'manual',
  },
  'single-point-of-failure': { ...SPARES_EVERYWHERE, configCopies: 1 },
  failover: { ...SPARES_EVERYWHERE, appCopies: 2, traffic: 100 },
};

/** The availability the High availability focus asks the learner to reach. */
const HA_TARGET = 0.9999;

const AVAILABILITY_OPTIONS = [
  { value: '0.99', label: '99%' },
  { value: '0.995', label: '99.5%' },
  { value: '0.999', label: '99.9%' },
  { value: '0.9999', label: '99.99%' },
];

const LADDER = [0.99, 0.999, 0.9995, 0.9999, 0.99999];

type PartId = 'lb1' | 'lb2' | 'app1' | 'app2' | 'app3' | 'cfg1' | 'cfg2' | 'db1' | 'db2';
type DbId = 'db1' | 'db2';

interface Part {
  id: PartId;
  tier: Tier;
  title: string;
  zone: Zone;
}

interface PartState {
  up: boolean;
  /** Simulation time the part died, while it is down. */
  downSince: number;
}

interface Failover {
  seconds: number;
  lost: number;
  how: FailoverMode;
}

interface State {
  now: number;
  parts: Record<PartId, PartState>;
  primary: DbId;
  particles: Particle[];
  /** Per-tick served and offered request counts over the last few seconds. */
  recent: { t: number; ok: number; total: number }[];
  okTotal: number;
  total: number;
  lastFailover: Failover | null;
  /** The part whose loss stopped all traffic, once the learner finds one. */
  spofFound: PartId | null;
  /** Primary down with a manual failover: logged once, not every frame. */
  waitingLogged: boolean;
  lastConfigRefresh: number;
  lastReplication: number;
}

const ALL_PARTS: PartId[] = ['lb1', 'lb2', 'app1', 'app2', 'app3', 'cfg1', 'cfg2', 'db1', 'db2'];

const createState = (): State => ({
  now: 0,
  parts: Object.fromEntries(ALL_PARTS.map((id) => [id, { up: true, downSince: 0 }])) as Record<PartId, PartState>,
  primary: 'db1',
  particles: [],
  recent: [],
  okTotal: 0,
  total: 0,
  lastFailover: null,
  spofFound: null,
  waitingLogged: false,
  lastConfigRefresh: 0,
  lastReplication: 0,
});

const otherDb = (id: DbId): DbId => (id === 'db1' ? 'db2' : 'db1');

const TIER_PREFIX: Record<Exclude<Tier, 'db'>, { prefix: string; title: string }> = {
  lb: { prefix: 'lb', title: 'LB' },
  app: { prefix: 'app', title: 'App' },
  config: { prefix: 'cfg', title: 'Config' },
};

const TIER_KIND: Record<Tier, NodeKind> = { lb: 'load-balancer', app: 'server', config: 'service', db: 'sql' };

/** The parts the current setup runs, in tier order. */
function presentParts(setup: Setup, primary: DbId): Part[] {
  const parts: Part[] = [];
  const copies: Record<Exclude<Tier, 'db'>, number> = {
    lb: setup.lbCopies,
    app: setup.appCopies,
    config: setup.configCopies,
  };
  for (const tier of ['lb', 'app', 'config'] as const) {
    for (let index = 0; index < copies[tier]; index += 1) {
      parts.push({
        id: `${TIER_PREFIX[tier].prefix}${index + 1}` as PartId,
        tier,
        title: `${TIER_PREFIX[tier].title} ${index + 1}`,
        zone: zoneOf(index, setup.zones),
      });
    }
  }
  const dbs: DbId[] = setup.standby ? ['db1', 'db2'] : [primary];
  for (const id of dbs) {
    parts.push({ id, tier: 'db', title: id === 'db1' ? 'DB 1' : 'DB 2', zone: id === 'db2' && setup.zones === 2 ? 'B' : 'A' });
  }
  return parts;
}

const CANVAS_HEIGHT = 450;

/**
 * Node boxes for the parts on screen, one column per tier, inside 960 x 450. The columns
 * are far enough apart that every wire is wider than it is tall, so it leaves and enters
 * through the side of a box and never cuts through a neighbour in the same column.
 */
function layoutFor(setup: Setup): Layout {
  const column = (count: number, height: number, gap: number) => {
    const top = CANVAS_HEIGHT / 2 - (count * height + (count - 1) * gap) / 2;
    return Array.from({ length: count }, (_, index) => top + index * (height + gap));
  };
  const layout: Layout = { users: { x: 10, y: CANVAS_HEIGHT / 2 - 47, w: 130, h: 94 } };
  column(setup.lbCopies, 92, 56).forEach((y, index) => (layout[`lb${index + 1}`] = { x: 165, y, w: 140, h: 92 }));
  column(setup.appCopies, 108, 42).forEach((y, index) => (layout[`app${index + 1}`] = { x: 380, y, w: 170, h: 108 }));
  layout.cfg1 = { x: 740, y: 4, w: 200, h: 88 };
  layout.cfg2 = { x: 740, y: 100, w: 200, h: 88 };
  layout.db1 = { x: 740, y: 210, w: 200, h: 94 };
  layout.db2 = { x: 740, y: 350, w: 200, h: 94 };
  return layout;
}

const pick = <T,>(items: T[]) => items[Math.floor(Math.random() * items.length)];

export function RedundancyLab({ focus }: LabProps<'redundancy'>) {
  // The page keys this Lab by Concept, so the focus never changes under a mounted Lab.
  const start = focus ? FOCUS_SETUPS[focus] : DEFAULT_SETUP;
  const challenge = focus === 'single-point-of-failure' ? 'find-spof' : focus === 'high-availability' ? 'target' : null;
  // Every control lives in one object, so Reset cannot miss one.
  const { setup, setSetup, change } = useLabSetup(start);
  const [running, setRunning] = useLabRunning();
  const state = useRef<State>(createState());
  const rerender = useRerender(30);
  const { events, log, clear } = useEventLog();
  const { points, push, reset: resetSeries } = useSeries(60, 400);

  const s = state.current;
  const parts = presentParts(setup, s.primary);
  const byTier = (tier: Tier) => parts.filter((part) => part.tier === tier);
  const isUp = (id: PartId) => s.parts[id].up;
  /** A dead part keeps receiving its share of traffic until a health check notices. */
  const inRotation = (id: PartId) => s.parts[id].up || s.now - s.parts[id].downSince < setup.detectSec;
  const standbyId = otherDb(s.primary);

  /** What share of requests the system serves right now, and how overloaded the app servers are. */
  const live = (() => {
    const lbs = byTier('lb').filter((part) => inRotation(part.id));
    const lbOk = lbs.length ? lbs.filter((part) => isUp(part.id)).length / lbs.length : 0;
    const apps = byTier('app').filter((part) => inRotation(part.id));
    const upApps = apps.filter((part) => isUp(part.id)).length;
    const toUpApps = apps.length ? setup.traffic * lbOk * (upApps / apps.length) : 0;
    const capacity = upApps * APP_CAPACITY;
    const served = Math.min(toUpApps, capacity);
    const configOk = byTier('config').some((part) => isUp(part.id));
    const dbOk = isUp(s.primary);
    return {
      served: setup.traffic > 0 && configOk && dbOk ? served / setup.traffic : 0,
      overloadShare: toUpApps > 0 ? 1 - served / toUpApps : 0,
      appLoad: upApps ? toUpApps / upApps / APP_CAPACITY : 0,
      configOk,
      dbOk,
    };
  })();

  const model = designAvailability(setup);
  const lostPerFailover = setup.replication === 'async' ? Math.round(setup.traffic * WRITE_SHARE * setup.lagSec) : 0;

  /** Tiers whose loss of one part, or of zone A, stops every request. */
  const singlePoints = [
    ...(setup.lbCopies === 1 ? ['the load balancer'] : []),
    ...(setup.appCopies === 1 ? ['the app server'] : []),
    ...(setup.configCopies === 1 ? ['the config service'] : []),
    ...(!setup.standby ? ['the database'] : []),
    ...(setup.zones === 1 ? ['zone A'] : []),
  ];

  const promote = useCallback(
    (how: FailoverMode) => {
      const current = state.current;
      const from = current.primary;
      const to = otherDb(from);
      const seconds = current.now - current.parts[from].downSince;
      current.primary = to;
      current.waitingLogged = false;
      current.lastFailover = { seconds, lost: lostPerFailover, how };
      const name = to === 'db1' ? 'DB 1' : 'DB 2';
      log(`${name} promoted to primary (${how}) after ${seconds.toFixed(1)} s of failed writes and reads`, 'ok');
      if (lostPerFailover > 0) {
        log(`${lostPerFailover} acknowledged writes lost: they were on the old primary but not yet shipped`, 'warn');
      }
      rerender();
    },
    [lostPerFailover, log, rerender],
  );

  const titleOf = (id: PartId) => parts.find((part) => part.id === id)?.title ?? id;

  /** Takes parts down, logs what that means, and spots a single point of failure. */
  const kill = (ids: PartId[], cause: string) => {
    const current = state.current;
    const alive = ids.filter((id) => current.parts[id].up);
    if (!alive.length) return;
    for (const id of alive) current.parts[id] = { up: false, downSince: current.now };
    const lost = parts.filter((part) => alive.includes(part.id));
    const stopped = lost.filter((part) => {
      if (part.tier === 'db') {
        if (part.id !== current.primary) return false;
        return !setup.standby || !current.parts[otherDb(current.primary)].up;
      }
      return byTier(part.tier).every((other) => !current.parts[other.id].up);
    });
    log(`${cause}: ${lost.map((part) => part.title).join(', ')} down`, 'danger');
    if (stopped.length) {
      const names = stopped.map((part) => TIER_LABEL[part.tier].toLowerCase()).join(' and ');
      log(`No working ${names} left - every request now fails until a repair`, 'danger');
      // A single point of failure is a part with no spare at all, not the last of several killed one by one.
      const single = stopped.find((part) => (part.tier === 'db' ? !setup.standby : byTier(part.tier).length === 1));
      if (single && !current.spofFound) {
        current.spofFound = single.id;
        log(`${single.title} has no spare: it is a single point of failure`, 'danger');
      }
    } else if (lost.every((part) => part.tier === 'db' && part.id !== current.primary)) {
      log('Standby down: the primary keeps serving, but a primary failure now has nowhere to fail over to', 'warn');
    } else if (lost.some((part) => part.id === current.primary)) {
      log(
        setup.failover === 'automatic'
          ? `Primary lost: failover in about ${setup.detectSec + PROMOTE_SEC} s (${setup.detectSec} s to detect + ${PROMOTE_SEC} s to promote)`
          : 'Primary lost: failover is manual - nothing happens until someone promotes the standby',
        'warn',
      );
    } else {
      log(`A spare takes over once health checks notice (${setup.detectSec} s) - traffic keeps flowing`, 'warn');
    }
    rerender();
  };

  const repair = (id: PartId) => {
    const current = state.current;
    if (current.parts[id].up) return;
    current.parts[id] = { up: true, downSince: 0 };
    if (id === current.primary) current.waitingLogged = false;
    const title = titleOf(id);
    if ((id === 'db1' || id === 'db2') && id !== current.primary) {
      log(`${title} repaired and rebuilt as a standby of the new primary (failback is a later, planned step)`, 'ok');
    } else {
      log(`${title} repaired and back in rotation`, 'ok');
    }
    rerender();
  };

  const toggle = (id: PartId) => (state.current.parts[id].up ? kill([id], 'Killed') : repair(id));

  const killRandom = () => {
    const alive = parts.filter((part) => isUp(part.id));
    if (alive.length) kill([pick(alive).id], 'Random failure');
  };

  const killZoneA = () =>
    kill(
      parts.filter((part) => part.zone === 'A').map((part) => part.id),
      setup.zones === 1 ? 'Zone A outage (the only zone)' : 'Zone A outage',
    );

  const repairAll = () => {
    for (const part of parts) repair(part.id);
  };

  /** Changing the number of copies: parts that leave are reset, so they come back healthy. */
  const setCopies = (key: 'lbCopies' | 'appCopies' | 'configCopies', prefix: string, value: number) => {
    for (let index = value + 1; index <= 3; index += 1) {
      const id = `${prefix}${index}` as PartId;
      if (id in state.current.parts) state.current.parts[id] = { up: true, downSince: 0 };
    }
    if (value > setup[key]) log(`Added a spare: ${value} copies now`, 'info');
    change(key)(value);
  };

  const setStandby = (on: boolean) => {
    const current = state.current;
    if (!on && current.primary === 'db2') {
      // One database left: keep the working copy, call it DB 1 again.
      current.parts.db1 = current.parts.db2;
      current.primary = 'db1';
    }
    current.parts.db2 = { up: true, downSince: 0 };
    log(on ? 'Standby database added: DB 2 replicates from DB 1' : 'Standby removed: one database left', 'info');
    change('standby')(on);
  };

  const reset = () => {
    // Back to this Concept's starting setup, not the Lab's global default.
    setSetup(start);
    state.current = createState();
    clear();
    resetSeries();
    rerender();
  };

  useTicker(running, (dt) => {
    const current = state.current;
    current.now += dt;

    // Database failover.
    const primary = current.parts[current.primary];
    const standby = current.parts[otherDb(current.primary)];
    if (!primary.up && setup.standby && standby.up) {
      if (setup.failover === 'automatic') {
        if (current.now - primary.downSince >= setup.detectSec + PROMOTE_SEC) promote('automatic');
      } else if (!current.waitingLogged) {
        current.waitingLogged = true;
        log('Waiting for a human: press "Promote standby" to fail over by hand', 'warn');
      }
    }

    // Count every request analytically; particles are only a sample of them.
    const offered = setup.traffic * dt;
    current.recent.push({ t: current.now, ok: offered * live.served, total: offered });
    while (current.recent.length && current.recent[0].t < current.now - 5) current.recent.shift();
    current.okTotal += offered * live.served;
    current.total += offered;

    const rate = Math.min(setup.traffic, 14);
    for (let index = sampleArrivals(rate, dt); index > 0; index -= 1) {
      const { route, outcome } = routeFor();
      current.particles.push({ id: nextParticleId(), route, leg: 0, t: 0, speed: 1.3 + Math.random() * 0.4, outcome });
    }
    // Apps re-read their config every so often; the dots show which copy answers.
    if (current.now - current.lastConfigRefresh > 0.7) {
      current.lastConfigRefresh = current.now;
      const apps = byTier('app').filter((part) => isUp(part.id));
      const configs = byTier('config').filter((part) => inRotation(part.id));
      if (apps.length && configs.length) {
        const config = pick(configs);
        current.particles.push({
          id: nextParticleId(),
          route: [pick(apps).id, config.id],
          leg: 0,
          t: 0,
          speed: 1.4,
          outcome: isUp(config.id) ? 'cache-hit' : 'failure',
        });
      }
    }
    // Writes shipped from the primary to the standby.
    if (setup.standby && current.now - current.lastReplication > 0.5 && live.dbOk && standby.up) {
      current.lastReplication = current.now;
      current.particles.push({
        id: nextParticleId(),
        route: [current.primary, otherDb(current.primary)],
        leg: 0,
        t: 0,
        speed: setup.replication === 'sync' ? 2 : 0.9,
        outcome: 'warning',
      });
    }

    const { alive } = advanceParticles(current.particles, dt);
    current.particles = alive.slice(-90);
    push({ served: live.served * 100 });
    rerender();
  });

  /** The path one sampled request takes, and where it breaks if it does. */
  function routeFor(): { route: string[]; outcome: RequestOutcome } {
    const primary = state.current.primary;
    const lbs = byTier('lb').filter((part) => inRotation(part.id));
    if (!lbs.length) return { route: ['users', byTier('lb')[0].id], outcome: 'failure' };
    const lb = pick(lbs).id;
    if (!isUp(lb)) return { route: ['users', lb], outcome: 'failure' };
    const apps = byTier('app').filter((part) => inRotation(part.id));
    if (!apps.length) return { route: ['users', lb, byTier('app')[0].id], outcome: 'failure' };
    const app = pick(apps).id;
    if (!isUp(app) || Math.random() < live.overloadShare) return { route: ['users', lb, app], outcome: 'failure' };
    if (!live.configOk) return { route: ['users', lb, app, byTier('config')[0].id], outcome: 'failure' };
    return { route: ['users', lb, app, primary], outcome: isUp(primary) ? 'success' : 'failure' };
  }

  // ---- Diagram -------------------------------------------------------------
  const layout = layoutFor(setup);
  const toneFor = (a: PartId | 'users', b: PartId, base: EdgeTone): Pick<DiagramEdge, 'tone' | 'dashed'> => {
    const dead = (id: PartId | 'users') => id !== 'users' && !isUp(id);
    const ejected = (id: PartId | 'users') => id !== 'users' && !inRotation(id);
    if (ejected(a) || ejected(b)) return { tone: 'muted', dashed: true };
    if (dead(a) || dead(b)) return { tone: 'danger' };
    return { tone: base };
  };
  const edges: DiagramEdge[] = [];
  for (const lb of byTier('lb')) edges.push({ from: 'users', to: lb.id, ...toneFor('users', lb.id, 'brand') });
  for (const lb of byTier('lb'))
    for (const app of byTier('app')) edges.push({ from: lb.id, to: app.id, ...toneFor(lb.id, app.id, 'brand') });
  for (const app of byTier('app')) {
    for (const config of byTier('config')) edges.push({ from: app.id, to: config.id, ...toneFor(app.id, config.id, 'info') });
    edges.push({ from: app.id, to: s.primary, ...toneFor(app.id, s.primary, 'ok') });
  }
  if (setup.standby) {
    const broken = !isUp(s.primary) || !isUp(standbyId);
    edges.push({ from: s.primary, to: standbyId, tone: broken ? 'muted' : 'violet', dashed: broken || setup.replication === 'async' });
  }

  // A part removed with the copy stepper keeps its layout slot, so filter on the parts on screen.
  const onScreen = new Set<string>(['users', ...parts.map((part) => part.id)]);
  const particleViews: ParticleView[] = s.particles
    .filter((particle) => onScreen.has(particle.route[particle.leg]) && onScreen.has(particle.route[particle.leg + 1]))
    .map((particle) => ({
      id: particle.id,
      from: particle.route[particle.leg],
      to: particle.route[particle.leg + 1],
      t: particle.t,
      outcome: particle.outcome ?? 'success',
    }));

  const failoverLeft = !isUp(s.primary) && setup.standby && isUp(standbyId)
    ? setup.failover === 'automatic'
      ? Math.max(0, setup.detectSec + PROMOTE_SEC - (s.now - s.parts[s.primary].downSince))
      : null
    : undefined;
  const waitingForHuman = failoverLeft === null;

  const statusOf = (part: Part): { status: NodeStatus; label?: string } => {
    const partState = s.parts[part.id];
    if (partState.up) return { status: 'healthy' };
    if (part.tier === 'db' && part.id === s.primary && setup.standby && isUp(standbyId)) {
      return {
        status: 'down',
        label: waitingForHuman ? 'Down - waiting for a human' : `Down - failover in ${Math.ceil(failoverLeft ?? 0)} s`,
      };
    }
    if (part.tier === 'db') return { status: 'down', label: 'Down - click to repair' };
    return {
      status: 'down',
      label: inRotation(part.id) ? 'Down - still routed' : 'Down - ejected',
    };
  };

  const spofHidden = challenge === 'find-spof' && !s.spofFound;

  const renderPart = (part: Part) => {
    const { status, label } = statusOf(part);
    const role = part.tier === 'db' ? (part.id === s.primary ? 'primary' : 'standby') : null;
    return (
      <ArchNode
        key={part.id}
        kind={TIER_KIND[part.tier]}
        title={part.title}
        subtitle={role ? `${role} - zone ${part.zone}` : `zone ${part.zone}`}
        placed={layout[part.id]}
        status={status}
        statusLabel={label}
        onClick={() => toggle(part.id)}
        alert={s.spofFound === part.id || (part.tier === 'app' && isUp(part.id) && live.appLoad > 1)}
        compact
      >
        {part.tier === 'app' ? (
          <NodeStatRow
            label="Load"
            value={isUp(part.id) ? formatPercent(live.appLoad) : '-'}
            tone={live.appLoad > 1 ? 'text-danger' : live.appLoad > 0.8 ? 'text-warn' : 'text-ink'}
          />
        ) : null}
        {role === 'standby' ? (
          <NodeStatRow label="Behind" value={setup.replication === 'sync' ? 'in sync' : `${setup.lagSec.toFixed(1)} s`} />
        ) : null}
        {role === 'primary' ? (
          <NodeStatRow label="Writes" value={`${formatNumber(setup.traffic * WRITE_SHARE)}/s`} />
        ) : null}
      </ArchNode>
    );
  };

  // ---- Numbers -------------------------------------------------------------
  const recentTotal = s.recent.reduce((sum, item) => sum + item.total, 0);
  const servedRecent = recentTotal ? s.recent.reduce((sum, item) => sum + item.ok, 0) / recentTotal : 1;
  const servedRun = s.total ? s.okTotal / s.total : 1;
  const reached = model.total >= HA_TARGET;

  return (
    <LabShell
      title="Redundancy Lab"
      description="A request needs a load balancer, an app server, the config service and the database. Add spare copies, then kill parts - click any box - and watch what keeps serving, how long a failover takes, and the availability the design reaches."
      running={running}
      onRunningChange={setRunning}
      onReset={reset}
      legend={
        <ParticleLegend
          outcomes={[
            { outcome: 'success', label: 'Request served' },
            { outcome: 'cache-hit', label: 'App server reads its config' },
            { outcome: 'warning', label: 'Write shipped to the standby' },
            { outcome: 'failure', label: 'Failed request or read' },
          ]}
        />
      }
      events={events}
      actions={
        <>
          {waitingForHuman ? (
            <Button variant="success" onClick={() => promote('manual')}>
              <ArrowUpFromLine className="h-4 w-4" />
              Promote standby
            </Button>
          ) : null}
          <Button variant="danger" onClick={killRandom}>
            <Dices className="h-4 w-4" />
            Kill a random part
          </Button>
          <Button variant="secondary" onClick={killZoneA}>
            <Zap className="h-4 w-4" />
            Kill zone A
          </Button>
        </>
      }
      insight={<Insight>{insightFor()}</Insight>}
      metrics={
        <>
          {challenge ? <ChallengeCard>{challengeText()}</ChallengeCard> : null}
          <MetricsPanel
            items={[
              {
                key: 'design',
                label: 'Design availability',
                value: formatAvailability(model.total),
                tone: model.total >= 0.9999 ? 'ok' : model.total >= 0.999 ? 'warn' : 'danger',
                hint: 'Share of the year this design serves requests, from the tier-by-tier arithmetic below.',
                simulated: true,
              },
              {
                key: 'downtime',
                label: 'Downtime a year',
                value: formatSeconds(model.downtimeSecPerYear),
                tone: model.total >= 0.9999 ? 'ok' : model.total >= 0.999 ? 'warn' : 'danger',
                hint: 'What the design availability allows: (1 - availability) x one year.',
                simulated: true,
              },
              {
                key: 'now',
                label: 'Served now',
                value: formatPercent(servedRecent, 1),
                tone: servedRecent > 0.99 ? 'ok' : servedRecent > 0.5 ? 'warn' : 'danger',
                hint: 'Share of requests answered over the last 5 seconds of this run.',
              },
              {
                key: 'run',
                label: 'Served this run',
                value: formatPercent(servedRun, 2),
                hint: 'Share of every request since the run started. Kill parts and watch it fall below the design number.',
              },
              {
                key: 'failover',
                label: 'Last failover',
                value: s.lastFailover ? `${s.lastFailover.seconds.toFixed(1)} s` : '-',
                tone: s.lastFailover ? 'warn' : 'neutral',
                hint: 'From the primary dying to the standby taking writes: detect + promote, or your own reaction time when failover is manual.',
              },
              {
                key: 'lost',
                label: 'Writes lost at switch',
                value: s.lastFailover ? formatNumber(s.lastFailover.lost) : '-',
                tone: s.lastFailover && s.lastFailover.lost > 0 ? 'danger' : 'neutral',
                hint: `Writes the primary had acknowledged but not yet shipped: ${WRITE_SHARE * 100}% of traffic are writes, times the replication lag.`,
                simulated: true,
              },
              {
                key: 'parts',
                label: 'Parts running',
                value: parts.length,
                unit: 'boxes',
                hint: 'Every copy is billed, patched and monitored. Four is the minimum here: one of each.',
              },
            ]}
          />

          <div className="grid gap-4 lg:grid-cols-2">
            <div className="card p-4">
              <p className="label mb-3">Availability, tier by tier</p>
              {spofHidden ? (
                <p className="text-xs text-muted">
                  Hidden until you find the single point of failure - the numbers would give it away. Kill parts one at a
                  time.
                </p>
              ) : (
                <ul className="space-y-2">
                  {model.rows.map((row) => (
                    <li key={row.tier} className="text-xs">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="min-w-0 truncate font-medium text-ink">
                          {row.label} <span className="font-normal text-faint">- {row.copies}</span>
                        </span>
                        <span
                          className={cn(
                            'shrink-0 font-mono tabular-nums',
                            row.availability >= 0.9999 ? 'text-ok' : row.availability >= 0.999 ? 'text-warn' : 'text-danger',
                          )}
                        >
                          {formatAvailability(row.availability)}
                        </span>
                      </div>
                      <p className="text-[11px] text-faint">
                        {row.note} - {formatSeconds(downtimeFor(row.availability))} a year
                      </p>
                    </li>
                  ))}
                  <li className="flex items-baseline justify-between gap-2 border-t border-line pt-2 text-xs">
                    <span className="font-semibold text-ink">All of them multiplied (in series)</span>
                    <span className="font-mono font-semibold tabular-nums text-ink">{formatAvailability(model.total)}</span>
                  </li>
                </ul>
              )}
              <p className="mt-3 text-[11px] text-faint">
                {SIMULATED_HINT} Parts fail independently, each is repaired in {REPAIR_HOURS} h, a
                whole zone is up {formatAvailability(ZONE_AVAILABILITY)}, one app server serves {APP_CAPACITY} req/s, a
                promotion takes {PROMOTE_SEC} s and a manual failover {formatSeconds(MANUAL_FAILOVER_SEC)}.
              </p>
            </div>

            <div className="card p-4">
              <p className="label mb-3">The nines and the downtime they allow</p>
              <ul className="space-y-1.5">
                {LADDER.map((level, index) => {
                  const next = LADDER[index + 1] ?? 1;
                  const here = model.total >= level && model.total < next;
                  return (
                    <li
                      key={level}
                      className={cn(
                        'flex items-center justify-between gap-2 rounded-lg border px-3 py-1.5 font-mono text-xs',
                        here ? 'border-brand bg-brand/10 text-ink' : 'border-line text-muted',
                        challenge === 'target' && level === HA_TARGET && 'ring-2 ring-violet/40',
                      )}
                    >
                      <span>
                        {formatAvailability(level)}
                        {challenge === 'target' && level === HA_TARGET ? ' (target)' : ''}
                      </span>
                      <span>{formatSeconds(downtimeFor(level))} a year</span>
                    </li>
                  );
                })}
              </ul>
              <p className="mt-2 text-[11px] text-faint">
                {model.total < LADDER[0]
                  ? `This design is below 99%: ${formatSeconds(model.downtimeSecPerYear)} of downtime a year.`
                  : 'The highlighted row is the band this design reaches.'}{' '}
                Each extra nine allows ten times less downtime.
              </p>
            </div>
          </div>

          <div className="card p-4">
            <p className="label mb-3">Requests served (live)</p>
            <LiveChart data={points} series={[{ key: 'served', label: 'Served %', color: 'ok' }]} height={140} yDomain={[0, 100]} />
            <p className="mt-2 text-[11px] text-faint">
              The dip after a kill is the failover delay: health checks need {setup.detectSec} s to eject a dead copy, and a
              database promotion needs {PROMOTE_SEC} s more.
            </p>
          </div>
        </>
      }
      controls={
        <>
          {spofHidden ? (
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted">Copies of each part</p>
              <p className="text-[11px] text-faint">
                Hidden until you find the single point of failure - the copy counts would give it away. Kill parts one
                at a time, then add the missing spare here.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-xs font-medium text-muted">Copies of each part</p>
              <Stepper
                label="Load balancers"
                value={setup.lbCopies}
                min={1}
                max={MAX_COPIES.lb}
                onChange={(value) => setCopies('lbCopies', 'lb', value)}
              />
              <Stepper
                label="App servers"
                value={setup.appCopies}
                min={1}
                max={MAX_COPIES.app}
                onChange={(value) => setCopies('appCopies', 'app', value)}
                hint={`Each serves up to ${APP_CAPACITY} req/s (simplified). N+1 means one can die and the rest still carry the traffic.`}
              />
              <Stepper
                label="Config service"
                value={setup.configCopies}
                min={1}
                max={MAX_COPIES.config}
                onChange={(value) => setCopies('configCopies', 'cfg', value)}
                hint="Feature flags and settings every app server reads. Easy to forget, and every request needs it."
              />
              <Toggle
                label="Standby database"
                checked={setup.standby}
                onChange={setStandby}
                description="A second copy that takes over when the primary dies"
              />
            </div>
          )}
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted">Failure domains</p>
            <SegmentedControl
              size="sm"
              className="w-full"
              value={String(setup.zones) as '1' | '2'}
              options={[
                { value: '1', label: 'One zone' },
                { value: '2', label: 'Two zones' },
              ]}
              onChange={(value) => change('zones')(value === '2' ? 2 : 1)}
            />
            <p className="text-[11px] text-faint">With two zones, copies alternate A, B, A. A single copy always sits in A.</p>
          </div>
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted">Database failover</p>
            <SegmentedControl
              size="sm"
              className="w-full"
              value={setup.failover}
              options={[
                { value: 'automatic', label: 'Automatic' },
                { value: 'manual', label: 'Manual' },
              ]}
              onChange={change('failover')}
            />
            <SegmentedControl
              size="sm"
              className="w-full"
              value={setup.replication}
              options={[
                { value: 'async', label: 'Async replication' },
                { value: 'sync', label: 'Sync replication' },
              ]}
              onChange={change('replication')}
            />
            {setup.replication === 'async' ? (
              <Slider
                label="Replication lag"
                value={setup.lagSec}
                min={0.1}
                max={5}
                step={0.1}
                onChange={change('lagSec')}
                format={(value) => `${value.toFixed(1)} s`}
                hint="How far the standby is behind. Writes inside this window are lost if the primary dies."
              />
            ) : (
              <p className="text-[11px] text-faint">
                Sync: every write waits for the standby to confirm, so a failover loses nothing - and each write pays one
                more round trip.
              </p>
            )}
          </div>
          <Slider
            label="Health-check detection"
            value={setup.detectSec}
            min={2}
            max={30}
            onChange={change('detectSec')}
            format={(value) => `${value} s`}
            hint="Time to notice a dead part, for example 3 failed checks 3 s apart. Shorter recovers faster, and fails over on blips that were not failures."
          />
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted">Each part is up</p>
            <SegmentedControl
              size="sm"
              className="w-full"
              value={String(setup.partAvailability)}
              options={AVAILABILITY_OPTIONS}
              onChange={(value) => change('partAvailability')(Number(value))}
            />
          </div>
          <Slider
            label="Traffic"
            value={setup.traffic}
            min={20}
            max={300}
            step={10}
            onChange={change('traffic')}
            format={(value) => `${value} req/s`}
            tone={setup.traffic > setup.appCopies * APP_CAPACITY ? 'danger' : 'brand'}
          />
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted">Failure injection</p>
            <p className="text-[11px] text-faint">Click a box in the diagram to kill it; click it again to repair it.</p>
            <Button size="sm" variant="success" className="w-full justify-center" onClick={repairAll}>
              <Wrench className="h-3 w-3" />
              Repair everything
            </Button>
          </div>
        </>
      }
    >
      <DiagramCanvas layout={layout} edges={edges} particles={particleViews} height={CANVAS_HEIGHT} className="bg-canvas">
        <ArchNode
          kind="client"
          title="Users"
          subtitle={`${setup.traffic} req/s`}
          placed={layout.users}
          compact
        >
          <NodeStatRow
            label="Served"
            value={formatPercent(servedRecent)}
            tone={servedRecent > 0.99 ? 'text-ok' : servedRecent > 0.5 ? 'text-warn' : 'text-danger'}
          />
        </ArchNode>
        {parts.map(renderPart)}
      </DiagramCanvas>
    </LabShell>
  );

  function challengeText(): ReactNode {
    if (challenge === 'target') {
      return reached ? (
        <>
          Target reached: {formatAvailability(model.total)} against {formatAvailability(HA_TARGET)}, at most{' '}
          {formatSeconds(model.downtimeSecPerYear)} of downtime a year. Now prove it: kill zone A and a random part and
          check that traffic keeps flowing.
        </>
      ) : (
        <>
          Reach {formatAvailability(HA_TARGET)} ({formatSeconds(downtimeFor(HA_TARGET))} of downtime a year). This design
          is at {formatAvailability(model.total)} ({formatSeconds(model.downtimeSecPerYear)}). Look at the tier-by-tier
          list: the biggest downtime is where to spend next.
        </>
      );
    }
    if (!s.spofFound) {
      return (
        <>
          This design looks redundant: spares, a standby, two zones. Yet one part that every request depends on has no
          spare. Kill parts one at a time (click a box, then repair it) and watch Served now: find the single kill that
          drops it to zero.
        </>
      );
    }
    return singlePoints.length ? (
      <>
        Found it: {titleOf(s.spofFound)} has no spare, and with it down every request failed. Every request path goes
        through it, so the whole design can be no more available than it is. Single points left: {singlePoints.join(', ')}. Add a copy and kill it again.
      </>
    ) : (
      <>
        No single part is left whose loss stops the service. Kill any one box, or zone A, and traffic keeps flowing after
        the detection gap.
      </>
    );
  }

  function insightFor(): ReactNode {
    if (waitingForHuman) {
      return (
        <>
          The primary is down and failover is manual, so every request that needs the database fails until someone
          presses Promote standby. The clock is running: in a real incident a page, a login and a diagnosis take tens of
          minutes, which is why the model charges {formatSeconds(MANUAL_FAILOVER_SEC)} for every manual failover.
        </>
      );
    }
    if (failoverLeft !== undefined) {
      return (
        <>
          The primary is down. Every request fails until the standby is promoted: {setup.detectSec} s for health checks to
          be sure, then {PROMOTE_SEC} s to promote. That gap is the failover delay, and it is paid on every failure - which
          is why redundancy without fast, automatic failover buys less than the copy count suggests.
          {setup.replication === 'async'
            ? ` With async replication the last ${setup.lagSec.toFixed(1)} s of writes (about ${lostPerFailover}) never reached the standby and are lost at the switch.`
            : ' With sync replication the standby already has every acknowledged write, so nothing is lost.'}
        </>
      );
    }
    if (!live.dbOk || !live.configOk || live.served === 0) {
      return (
        <>
          Nothing is being served: a part with no working copy left sits on every request path. That is a single point of
          failure - click the dead box to repair it, then add a copy to that tier.
        </>
      );
    }
    if (live.appLoad > 1) {
      return (
        <>
          The app servers still up need {formatPercent(live.appLoad)} of their capacity, so{' '}
          {formatPercent(live.overloadShare)} of their requests are rejected. Spares only tolerate a failure if the
          survivors can carry the load: that is what N+1 means.
        </>
      );
    }
    if (focus === 'single-point-of-failure' && !s.spofFound) {
      return (
        <>
          A spare only protects the part it copies: the design is no more available than its least redundant part, and
          a box drawn in a row of copies is not the only kind a request needs. Ask of every box: if this one disappears
          right now, does any request still get through?
        </>
      );
    }
    switch (focus) {
      case 'availability':
        return (
          <>
            Each part is up {formatAvailability(setup.partAvailability)}, and a request needs all of them, so their
            availabilities multiply: this design reaches {formatAvailability(model.total)}, which allows{' '}
            {formatSeconds(model.downtimeSecPerYear)} of downtime a year. Switch Each part is up between 99% and 99.9%:
            every extra nine is ten times less downtime. Then add spares and see which moves the number more.
          </>
        );
      case 'fault-tolerance':
        return (
          <>
            Every tier has a spare. Kill any single box - an LB, an app server, a config copy, even the primary database -
            and requests keep succeeding after a short gap while health checks eject the dead copy. Kill two app servers
            and the last one cannot carry {setup.traffic} req/s: tolerance has limits you choose in advance.
          </>
        );
      case 'failover':
        return (
          <>
            DB 1 is the primary and DB 2 its standby, {setup.replication === 'async' ? `${setup.lagSec.toFixed(1)} s behind` : 'in sync'}.
            Click DB 1 to kill it and watch the chart: requests fail for about {setup.detectSec + PROMOTE_SEC} s (detect +
            promote){setup.replication === 'async' ? `, and about ${lostPerFailover} acknowledged writes are lost at the switch` : ''}.
            Then try Sync replication, a shorter detection time, or Manual failover.
          </>
        );
      default:
        return singlePoints.length ? (
          <>
            This design reaches {formatAvailability(model.total)} ({formatSeconds(model.downtimeSecPerYear)} down a
            year). Single points of failure: {singlePoints.join(', ')}. Add a copy to a tier and its chance of being down
            squares - 0.1% becomes 0.0001% - as long as the copies do not fail together. Then kill a part and watch the
            spare take over.
          </>
        ) : (
          <>
            No single part stops the service: {formatAvailability(model.total)}, {formatSeconds(model.downtimeSecPerYear)}{' '}
            down a year. What is left is mostly detection and failover time - each failure still costs {setup.detectSec} s
            before the spare takes over.
          </>
        );
    }
  }
}

/** The task a Lab focus sets. Violet, not warn: a challenge is not a warning, and warn means status. */
function ChallengeCard({ children }: { children: ReactNode }) {
  return (
    <div className="flex gap-3 rounded-xl border border-violet/40 bg-violet/5 p-4">
      <Target className="mt-0.5 h-4 w-4 shrink-0 text-violet" aria-hidden />
      <div className="min-w-0">
        <p className="text-xs font-semibold uppercase tracking-wide text-violet">Challenge</p>
        <div className="mt-1 text-sm leading-relaxed text-muted">{children}</div>
      </div>
    </div>
  );
}

export default RedundancyLab;
