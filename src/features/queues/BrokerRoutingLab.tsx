import { useCallback, useRef } from 'react';
import { Send } from 'lucide-react';
import {
  ArchNode,
  DiagramCanvas,
  NodeStatRow,
  ParticleLegend,
  type DiagramEdge,
  type Layout,
  type ParticleView,
} from '@/components/architecture';
import { Insight, LabShell, MetricsPanel, SIMULATED_HINT } from '@/components/learning';
import { Button, SegmentedControl, Select, Slider, Toggle } from '@/components/ui';
import { advanceParticles, nextParticleId, useEventLog, useTicker, type Particle } from '@/simulations/engine';
import { useLabSetup } from '@/hooks/useLabSetup';
import { useRerender } from '@/hooks/useRerender';
import { cn } from '@/utils/cn';
import { formatNumber } from '@/utils/format';
import type { LabFocus, LabProps, RequestOutcome } from '@/types';
import { useLabRunning } from '@/hooks/useLabRunning';

// ---- The routing model ------------------------------------------------------

type ExchangeType = 'direct' | 'fanout' | 'topic';
/** How the publisher reaches the services: through the broker, or by calling each one itself. */
type Wiring = 'broker' | 'calls';

const ROUTING_KEYS = ['order.placed', 'order.cancelled', 'user.signed_up', 'user.deleted'] as const;
type RoutingKey = (typeof ROUTING_KEYS)[number];
type PublishChoice = RoutingKey | 'mixed';

const BINDING_KEYS = [...ROUTING_KEYS, 'order.*', 'user.*', '*.placed', '#'] as const;
type BindingKey = (typeof BINDING_KEYS)[number];

/** The order "Mixed keys" publishes in: order.placed and user.signed_up twice as often as the others. */
const MIXED_CYCLE: RoutingKey[] = [
  'order.placed',
  'user.signed_up',
  'order.placed',
  'order.cancelled',
  'user.signed_up',
  'user.deleted',
];

type SubId = 'payments' | 'inventory' | 'email' | 'crm' | 'analytics';

interface Service {
  id: SubId;
  name: string;
  /**
   * Events per second this service can handle. Simplified: a fixed number per
   * service, not a measurement - real throughput depends on the work, the
   * prefetch setting and the broker.
   */
  rate: number;
}

const SERVICES: Service[] = [
  { id: 'payments', name: 'Payments', rate: 10 },
  { id: 'inventory', name: 'Inventory', rate: 10 },
  { id: 'email', name: 'Email', rate: 10 },
  { id: 'crm', name: 'CRM sync', rate: 10 },
  // Slow on purpose (warehouse writes), so a fast publisher shows one subscriber falling behind alone.
  { id: 'analytics', name: 'Analytics', rate: 4 },
];

const SERVICE_BY_ID = Object.fromEntries(SERVICES.map((service) => [service.id, service])) as Record<SubId, Service>;

/**
 * RabbitMQ topic matching: the key and the pattern are dot-separated words,
 * `*` matches exactly one word and `#` matches zero or more.
 */
function topicMatches(pattern: string, key: string): boolean {
  const words = pattern.split('.');
  const parts = key.split('.');
  const match = (i: number, j: number): boolean => {
    if (i === words.length) return j === parts.length;
    if (words[i] === '#') {
      for (let next = j; next <= parts.length; next += 1) if (match(i + 1, next)) return true;
      return false;
    }
    if (j === parts.length) return false;
    return (words[i] === '*' || words[i] === parts[j]) && match(i + 1, j + 1);
  };
  return match(0, 0);
}

/** Whether a binding routes a key, the way each exchange type decides it. */
function bindingMatches(type: ExchangeType, binding: BindingKey, key: RoutingKey) {
  if (type === 'fanout') return true; // fanout ignores the key
  if (type === 'direct') return binding === key; // exact string match: order.* is just text here
  return topicMatches(binding, key);
}

// ---- Setup and Lab focus ----------------------------------------------------

interface Subscriber {
  on: boolean;
  down: boolean;
  binding: BindingKey;
}

interface Setup {
  wiring: Wiring;
  exchange: ExchangeType;
  /** One queue shared by every subscriber (competing consumers) instead of one queue each. */
  shared: boolean;
  /**
   * Whether a queue outlives its subscriber. On: a named queue that keeps collecting while the
   * subscriber is away. Off: an exclusive queue, deleted when the subscriber connection closes.
   * (Durable is a different setting in RabbitMQ: whether a queue survives a broker restart.)
   */
  keepQueues: boolean;
  rate: number;
  publish: PublishChoice;
  subs: Record<SubId, Subscriber>;
}

/** What the lab opens on at /labs/broker-routing, with no Lab focus. */
const DEFAULT_SETUP: Setup = {
  wiring: 'broker',
  exchange: 'topic',
  shared: false,
  keepQueues: true,
  rate: 3,
  publish: 'mixed',
  subs: {
    payments: { on: true, down: false, binding: 'order.placed' },
    inventory: { on: true, down: false, binding: 'order.*' },
    email: { on: true, down: false, binding: 'user.*' },
    crm: { on: false, down: false, binding: 'user.signed_up' },
    analytics: { on: true, down: false, binding: '#' },
  },
};

/**
 * The Lab focus of each Concept that hosts this lab.
 * - RabbitMQ Concepts opens on a topic exchange with exact and pattern
 *   bindings, publishing several routing keys, so the routing table is the lesson.
 * - Event-Driven Architecture opens on one event, order.placed, and four
 *   services that each react to it and never call each other.
 * - Pub/Sub opens on a fanout exchange: one user.signed_up, three copies.
 */
const FOCUS_SETUPS: Record<LabFocus<'broker-routing'>, Setup> = {
  // The same as the default today, spelled out so it stays on bindings if the default moves.
  'rabbitmq-concepts': { ...DEFAULT_SETUP, exchange: 'topic', publish: 'mixed' },
  'event-driven-architecture': {
    ...DEFAULT_SETUP,
    exchange: 'topic',
    publish: 'order.placed',
    subs: {
      payments: { on: true, down: false, binding: 'order.placed' },
      inventory: { on: true, down: false, binding: 'order.*' },
      email: { on: true, down: false, binding: '*.placed' },
      crm: { on: false, down: false, binding: 'order.placed' },
      analytics: { on: true, down: false, binding: '#' },
    },
  },
  'pub-sub': {
    ...DEFAULT_SETUP,
    exchange: 'fanout',
    publish: 'user.signed_up',
    subs: {
      payments: { on: false, down: false, binding: 'order.placed' },
      inventory: { on: false, down: false, binding: 'order.*' },
      email: { on: true, down: false, binding: 'user.signed_up' },
      crm: { on: true, down: false, binding: 'user.signed_up' },
      analytics: { on: true, down: false, binding: '#' },
    },
  },
};

/** Whether a service wants a key. With direct calls the publisher code decides, by the same pattern. */
function wants(setup: Setup, id: SubId, key: RoutingKey) {
  const { binding } = setup.subs[id];
  return setup.wiring === 'calls' ? topicMatches(binding, key) : bindingMatches(setup.exchange, binding, key);
}

/** A subscriber has its own queue while it is subscribed, and - if the queue is exclusive - connected. */
const ownQueueExists = (setup: Setup, id: SubId) =>
  setup.wiring === 'broker' && !setup.shared && setup.subs[id].on && (setup.keepQueues || !setup.subs[id].down);

const publishedKeys = (setup: Setup): RoutingKey[] =>
  setup.publish === 'mixed' ? [...ROUTING_KEYS] : [setup.publish];

/** Share of published events carrying this key. */
const keyShare = (setup: Setup, key: RoutingKey) =>
  setup.publish === 'mixed'
    ? MIXED_CYCLE.filter((item) => item === key).length / MIXED_CYCLE.length
    : setup.publish === key
      ? 1
      : 0;

// ---- Simulation state -------------------------------------------------------

type Kind = 'publish' | 'enqueue' | 'enqueue-shared' | 'deliver' | 'call';

interface Meta {
  kind: Kind;
  key: RoutingKey;
  target?: SubId;
}

const emptyQueues = (): Record<SubId, RoutingKey[]> => ({ payments: [], inventory: [], email: [], crm: [], analytics: [] });
const zeroes = (): Record<SubId, number> => ({ payments: 0, inventory: 0, email: 0, crm: 0, analytics: 0 });
const flags = (): Record<SubId, boolean> => ({ payments: false, inventory: false, email: false, crm: false, analytics: false });

interface State {
  particles: Particle[];
  carry: number;
  cycle: number;
  queues: Record<SubId, RoutingKey[]>;
  shared: RoutingKey[];
  sharedTurn: number;
  consumeCarry: Record<SubId, number>;
  handled: Record<SubId, number>;
  published: number;
  delivered: number;
  dropped: number;
  missed: number;
  failedPublishes: number;
  /** Wiring and queue shape last tick, so a change re-declares the queues once. */
  topology: string;
  queueExisted: Record<SubId, boolean>;
  wasDown: Record<SubId, boolean>;
  droppedKeysLogged: Set<RoutingKey>;
}

const topologyOf = (setup: Setup) => `${setup.wiring}|${setup.shared}`;

const createState = (setup: Setup): State => {
  const queueExisted = flags();
  const wasDown = flags();
  for (const { id } of SERVICES) {
    queueExisted[id] = ownQueueExists(setup, id);
    wasDown[id] = setup.subs[id].on && setup.subs[id].down;
  }
  return {
    particles: [],
    carry: 0,
    cycle: 0,
    queues: emptyQueues(),
    shared: [],
    sharedTurn: 0,
    consumeCarry: zeroes(),
    handled: zeroes(),
    published: 0,
    delivered: 0,
    dropped: 0,
    missed: 0,
    failedPublishes: 0,
    topology: topologyOf(setup),
    queueExisted,
    wasDown,
    droppedKeysLogged: new Set(),
  };
};

const SPEED = 1.3;

function spawn(state: State, route: string[], meta: Meta, outcome: RequestOutcome = 'success') {
  state.particles.push({ id: nextParticleId(), route, leg: 0, t: 0, speed: SPEED, outcome, meta: { ...meta } });
}

// ---- Layout -----------------------------------------------------------------

const HEIGHT = 530;
const ROW_H = 94;
const ROW_GAP = 12;
const COL = {
  pub: { x: 12, w: 150 },
  ex: { x: 222, w: 172 },
  // 184 wide: "5 competing consumers" under Shared queue needs about 182.
  q: { x: 514, w: 184 },
  svc: { x: 736, w: 212 },
};

function buildLayout(setup: Setup, rows: SubId[]): Layout {
  const total = rows.length * ROW_H + Math.max(0, rows.length - 1) * ROW_GAP;
  const top = (HEIGHT - total) / 2;
  const middle = (HEIGHT - ROW_H) / 2;
  const layout: Layout = { pub: { ...COL.pub, y: middle, h: ROW_H } };
  if (setup.wiring === 'broker') {
    layout.ex = { ...COL.ex, y: middle, h: ROW_H };
    if (setup.shared) layout.shared = { ...COL.q, y: middle, h: ROW_H };
  }
  rows.forEach((id, index) => {
    const y = top + index * (ROW_H + ROW_GAP);
    layout[`s-${id}`] = { ...COL.svc, y, h: ROW_H };
    if (ownQueueExists(setup, id)) layout[`q-${id}`] = { ...COL.q, y, h: ROW_H };
  });
  return layout;
}

const EXCHANGE_TYPES: { value: ExchangeType; label: string }[] = [
  { value: 'direct', label: 'Direct' },
  { value: 'fanout', label: 'Fanout' },
  { value: 'topic', label: 'Topic' },
];

const EXCHANGE_BLURB: Record<ExchangeType, string> = {
  direct: 'exact key match',
  fanout: 'ignores the key',
  topic: 'pattern match',
};

// ---- The Lab ----------------------------------------------------------------

export function BrokerRoutingLab({ focus }: LabProps<'broker-routing'>) {
  // The page keys this lab by Concept, so the focus never changes under a mounted lab.
  const start = focus ? FOCUS_SETUPS[focus] : DEFAULT_SETUP;
  // Every control lives in one object, so Reset cannot miss one.
  const { setup, setSetup, change } = useLabSetup(start);
  const changeSub = (id: SubId, patch: Partial<Subscriber>) =>
    setSetup((current) => ({ ...current, subs: { ...current.subs, [id]: { ...current.subs[id], ...patch } } }));

  const [running, setRunning] = useLabRunning();
  const state = useRef<State>(createState(start));
  const rerender = useRerender(30);
  const { events, log, clear } = useEventLog();

  const reset = useCallback(() => {
    // Back to this Concept's starting setup, not the lab's global default.
    setSetup(start);
    state.current = createState(start);
    clear();
  }, [start, clear, setSetup]);

  /** Publishes one event with the current setup. */
  const publishOne = (current: State) => {
    const key = setup.publish === 'mixed' ? MIXED_CYCLE[current.cycle++ % MIXED_CYCLE.length] : setup.publish;
    current.published += 1;
    if (setup.wiring === 'calls') {
      // The publisher calls every service it knows wants this key, and waits for each.
      const targets = SERVICES.filter(({ id }) => setup.subs[id].on && wants(setup, id, key));
      if (targets.some(({ id }) => setup.subs[id].down)) current.failedPublishes += 1;
      for (const { id } of targets) {
        spawn(current, ['pub', `s-${id}`], { kind: 'call', key, target: id }, setup.subs[id].down ? 'failure' : 'success');
      }
      return;
    }
    // A cross marks an event no binding will route: it reaches the exchange and is dropped there.
    const routable = SERVICES.some(({ id }) =>
      setup.shared ? setup.subs[id].on && wants(setup, id, key) : ownQueueExists(setup, id) && wants(setup, id, key),
    );
    spawn(current, ['pub', 'ex'], { kind: 'publish', key }, routable ? 'success' : 'failure');
  };

  /** What happens when a particle reaches the end of its wire. */
  const arrive = (current: State, meta: Meta) => {
    const { key, target } = meta;
    if (meta.kind === 'publish') {
      if (setup.wiring !== 'broker') return;
      if (setup.shared) {
        // One queue: it gets one copy if any of the bindings on it matches.
        if (SERVICES.some(({ id }) => setup.subs[id].on && wants(setup, id, key))) {
          spawn(current, ['ex', 'shared'], { kind: 'enqueue-shared', key });
        } else {
          dropped(current, key);
        }
        return;
      }
      let routed = 0;
      for (const { id } of SERVICES) {
        const sub = setup.subs[id];
        if (!sub.on || !wants(setup, id, key)) continue;
        if (ownQueueExists(setup, id)) {
          routed += 1;
          spawn(current, ['ex', `q-${id}`], { kind: 'enqueue', key, target: id });
        } else {
          // Subscribed and interested, but its exclusive queue went away with it.
          current.missed += 1;
        }
      }
      if (routed === 0) dropped(current, key);
      return;
    }
    if (!target) {
      if (meta.kind === 'enqueue-shared' && setup.wiring === 'broker' && setup.shared) current.shared.push(key);
      return;
    }
    if (meta.kind === 'enqueue') {
      if (ownQueueExists(setup, target)) current.queues[target].push(key);
      else if (setup.subs[target].on) current.missed += 1;
      return;
    }
    if (meta.kind === 'deliver' || (meta.kind === 'call' && !setup.subs[target].down)) {
      current.handled[target] += 1;
      current.delivered += 1;
    }
  };

  const dropped = (current: State, key: RoutingKey) => {
    current.dropped += 1;
    if (!current.droppedKeysLogged.has(key)) {
      current.droppedKeysLogged.add(key);
      log(`${key} matched no binding - the exchange dropped it, and the publisher got no error`, 'warn');
    }
  };

  /** Re-declares queues when the shape changes, and logs subscribers leaving, failing and coming back. */
  const syncTopology = (current: State) => {
    const topology = topologyOf(setup);
    if (topology !== current.topology) {
      const waiting = SERVICES.reduce((sum, { id }) => sum + current.queues[id].length, current.shared.length);
      current.queues = emptyQueues();
      current.shared = [];
      current.topology = topology;
      log(
        setup.wiring === 'calls'
          ? 'No broker: the publisher now calls every service itself'
          : setup.shared
            ? 'One shared queue: subscribers now compete for each event'
            : 'One queue per subscriber: each gets its own copy',
        'info',
      );
      if (waiting > 0) log(`Queues re-declared, ${formatNumber(waiting)} waiting events discarded (simplified)`, 'warn');
    }
    for (const { id, name } of SERVICES) {
      const sub = setup.subs[id];
      const exists = ownQueueExists(setup, id);
      const down = sub.on && sub.down;
      if (current.queueExisted[id] && !exists) {
        const lost = current.queues[id].length;
        current.missed += lost;
        current.queues[id] = [];
        if (setup.wiring === 'broker' && !setup.shared) {
          log(
            !sub.on
              ? `${name} unsubscribed: its queue and binding are deleted${lost ? `, with ${lost} waiting events` : ''}`
              : `${name} disconnected: its exclusive queue is deleted${lost ? ` with ${lost} events in it` : ''}`,
            'danger',
          );
        }
      } else if (!current.queueExisted[id] && exists) {
        log(`${name} queue declared and bound with ${setup.exchange === 'fanout' ? 'no key (fanout)' : sub.binding}`, 'ok');
      }
      if (down !== current.wasDown[id]) {
        if (down) {
          log(
            setup.wiring === 'calls'
              ? `${name} is down - every call to it fails, and so does the publish`
              : exists
                ? `${name} is down - its queue keeps collecting, the others carry on`
                : `${name} is down - events for it are now lost`,
            'danger',
          );
        } else if (sub.on) {
          log(`${name} is back${exists && current.queues[id].length ? ` - draining ${current.queues[id].length} waiting events` : ''}`, 'ok');
        }
      }
      current.queueExisted[id] = exists;
      current.wasDown[id] = down;
    }
  };

  useTicker(running, (dt) => {
    const current = state.current;
    syncTopology(current);

    // Publish at the chosen rate; the fraction carries to the next frame.
    current.carry += setup.rate * dt;
    while (current.carry >= 1) {
      current.carry -= 1;
      publishOne(current);
    }

    // Consume: each service pulls at its own rate from its own queue, or its share of the shared one.
    if (setup.wiring === 'broker') {
      const up = SERVICES.filter(({ id }) => setup.subs[id].on && !setup.subs[id].down);
      if (setup.shared) {
        const order = up.map((_, index) => up[(index + current.sharedTurn) % up.length]);
        current.sharedTurn += 1;
        for (const { id, rate } of order) {
          const capacity = rate * dt + current.consumeCarry[id];
          let take = Math.floor(capacity);
          current.consumeCarry[id] = current.shared.length ? capacity - take : Math.min(capacity - take, 1);
          while (take > 0 && current.shared.length) {
            take -= 1;
            const key = current.shared.shift() as RoutingKey;
            const useful = wants(setup, id, key);
            // Every other service that wanted this event never sees it: the queue hands each message to one consumer.
            current.missed += SERVICES.filter(
              (other) => other.id !== id && setup.subs[other.id].on && wants(setup, other.id, key),
            ).length;
            if (useful) spawn(current, ['shared', `s-${id}`], { kind: 'deliver', key, target: id });
            else spawn(current, ['shared', `s-${id}`], { kind: 'enqueue-shared', key }, 'warning');
          }
        }
      } else {
        for (const { id, rate } of up) {
          if (!ownQueueExists(setup, id)) continue;
          const queue = current.queues[id];
          const capacity = rate * dt + current.consumeCarry[id];
          let take = Math.floor(capacity);
          current.consumeCarry[id] = queue.length ? capacity - take : Math.min(capacity - take, 1);
          while (take > 0 && queue.length) {
            take -= 1;
            const key = queue.shift() as RoutingKey;
            spawn(current, [`q-${id}`, `s-${id}`], { kind: 'deliver', key, target: id });
          }
        }
      }
    }

    const { alive, finished } = advanceParticles(current.particles, dt);
    current.particles = alive;
    for (const particle of finished) {
      const meta = particle.meta as unknown as Meta;
      // A "wrong service" particle from the shared queue only shows the waste; it counts nothing on arrival.
      if (meta.kind === 'enqueue-shared' && particle.route[0] === 'shared') continue;
      arrive(current, meta);
    }
    rerender();
  });

  // ---- Derived view ---------------------------------------------------------

  const current = state.current;
  const broker = setup.wiring === 'broker';
  const rows = SERVICES.filter(({ id }) => setup.subs[id].on).map(({ id }) => id);
  const layout = buildLayout(setup, rows);
  const keys = publishedKeys(setup);

  /** Who gets each published key right now. */
  const routes = keys.map((key) => {
    const receivers = rows.filter((id) => wants(setup, id, key));
    const routed = broker
      ? setup.shared
        ? receivers.length > 0
        : receivers.some((id) => ownQueueExists(setup, id))
      : receivers.length > 0;
    return { key, receivers, routed };
  });
  const droppedKeys = broker ? routes.filter((route) => !route.routed).map((route) => route.key) : [];

  const edges: DiagramEdge[] = [];
  if (broker) {
    edges.push({ from: 'pub', to: 'ex', tone: 'brand', width: 2 });
    if (setup.shared) {
      edges.push({
        from: 'ex',
        to: 'shared',
        tone: 'ok',
        label: setup.exchange === 'fanout' ? undefined : `${rows.length} bindings`,
      });
      for (const id of rows) {
        const down = setup.subs[id].down;
        edges.push({ from: 'shared', to: `s-${id}`, tone: down ? 'danger' : 'ok', dashed: down });
      }
    } else {
      for (const id of rows) {
        if (!ownQueueExists(setup, id)) continue;
        const down = setup.subs[id].down;
        const used = keys.some((key) => wants(setup, id, key));
        edges.push({
          from: 'ex',
          to: `q-${id}`,
          tone: used ? 'ok' : 'muted',
          label: setup.exchange === 'fanout' ? undefined : setup.subs[id].binding,
        });
        edges.push({ from: `q-${id}`, to: `s-${id}`, tone: down ? 'danger' : 'ok', dashed: down });
      }
    }
  } else {
    for (const id of rows) {
      const down = setup.subs[id].down;
      edges.push({ from: 'pub', to: `s-${id}`, tone: down ? 'danger' : 'brand', dashed: down });
    }
  }
  const wired = new Set(edges.map((edge) => `${edge.from}->${edge.to}`));

  const particleViews: ParticleView[] = current.particles
    .filter((particle) => wired.has(`${particle.route[particle.leg]}->${particle.route[particle.leg + 1]}`))
    .map((particle) => ({
      id: particle.id,
      from: particle.route[particle.leg],
      to: particle.route[particle.leg + 1],
      t: particle.t,
      outcome: particle.outcome ?? 'success',
    }));

  const backlog = SERVICES.reduce((sum, { id }) => sum + current.queues[id].length, current.shared.length);
  const downSubs = rows.filter((id) => setup.subs[id].down);
  // Events per second each subscriber receives, from the key mix - to spot one that cannot keep up.
  const lagging = broker && !setup.shared
    ? rows.filter((id) => {
        if (setup.subs[id].down) return false;
        const incoming = keys.reduce((sum, key) => sum + (wants(setup, id, key) ? keyShare(setup, key) * setup.rate : 0), 0);
        return incoming > SERVICE_BY_ID[id].rate;
      })
    : [];
  const names = (ids: SubId[]) => ids.map((id) => SERVICE_BY_ID[id].name).join(', ');
  const idle = rows.filter((id) => !setup.subs[id].down);

  const insight = (() => {
    if (!broker) {
      if (downSubs.length) {
        return (
          <>
            With direct calls the publisher calls each service itself and waits for every answer. {names(downSubs)}{' '}
            {downSubs.length === 1 ? 'is' : 'are'} down, so every publish that needs {downSubs.length === 1 ? 'it' : 'them'}{' '}
            fails - {formatNumber(current.failedPublishes)} so far. One sick service breaks the publisher. Switch back to
            Through the broker: the queue holds those events and the publisher never notices.
          </>
        );
      }
      return (
        <>
          With direct calls the publisher must know every service and call each one: {rows.length} calls per event.
          Subscribing a new service now means changing and redeploying the publisher. Take one service down to see
          the coupling bite.
        </>
      );
    }
    if (setup.shared) {
      return (
        <>
          One queue shared by {rows.length} services is a work queue, not pub/sub: each event goes to exactly one of
          them, in turn. {formatNumber(current.missed)} copies never reached a service that wanted them, and a
          triangle marks an event handed to a service with no use for it. Give each subscriber its own queue and each
          gets its own copy.
        </>
      );
    }
    if (downSubs.length) {
      const [first] = downSubs;
      return setup.keepQueues ? (
        <>
          {SERVICE_BY_ID[first].name} is down, but its queue outlives it and keeps collecting its events (
          {formatNumber(current.queues[first].length)} waiting) and every other subscriber carries on. The publisher
          does not notice. Bring it back and watch the backlog drain.
        </>
      ) : (
        <>
          {SERVICE_BY_ID[first].name} is down and its queue was exclusive, so the broker deleted it with the
          subscriber: {formatNumber(current.missed)} events it should have seen are gone, and nothing will replay
          them. Turn Queues outlive subscribers on to keep them while it is away.
        </>
      );
    }
    if (lagging.length) {
      const [first] = lagging;
      return (
        <>
          {SERVICE_BY_ID[first].name} handles {SERVICE_BY_ID[first].rate} events/s but now receives more, so its queue
          grows while the other subscribers keep up. Each subscriber has its own queue and falls behind on its own -
          watch the backlog per subscriber, not just the publish rate.
        </>
      );
    }
    const patterns = rows.filter((id) => /[*#]/.test(setup.subs[id].binding));
    if (setup.exchange === 'direct' && patterns.length) {
      return (
        <>
          A direct exchange routes when the binding key equals the routing key, character for character. The
          bindings of {names(patterns)} contain * or #, which here are just text, so they match nothing
          {droppedKeys.length ? <> - and {droppedKeys.join(', ')} now reach no queue at all and are dropped</> : null}.
          Switch to Topic and they become patterns again.
        </>
      );
    }
    if (droppedKeys.length) {
      return (
        <>
          {droppedKeys.join(', ')} {droppedKeys.length === 1 ? 'matches' : 'match'} no binding, so the exchange drops{' '}
          {droppedKeys.length === 1 ? 'it' : 'them'} and the publisher gets no error (RabbitMQ only returns an
          unroutable message when the publisher sets the mandatory flag). Add a binding that matches, or switch the
          exchange type.
        </>
      );
    }
    if (focus === 'event-driven-architecture' && setup.exchange !== 'fanout') {
      return (
        <>
          {names(idle)} each react to {setup.publish === 'mixed' ? 'the events' : setup.publish} on their own, and no
          service calls another - the publisher does not even know they exist. Subscribe CRM sync: nothing about the
          publisher changes. Then switch to Direct calls and take Payments down.
        </>
      );
    }
    if (setup.exchange === 'fanout') {
      return (
        <>
          A fanout exchange ignores the routing key: every bound queue gets its own copy of every event - {rows.length}{' '}
          {rows.length === 1 ? 'copy' : 'copies'} per publish here. That is pub/sub: one publish, many subscribers, and
          the publisher knows none of them. Take a subscriber down and the others do not notice.
        </>
      );
    }
    if (setup.exchange === 'direct') {
      return (
        <>
          A direct exchange routes when the binding key equals the routing key exactly - one key, one set of queues.
          Two queues bound with the same key both get a copy. Bind a queue with order.* and see what a direct
          exchange makes of it.
        </>
      );
    }
    return (
      <>
        A topic exchange compares the key word by word: * matches exactly one word and # matches zero or more. The
        publisher only names what happened; the bindings decide which queues get a copy. Switch to Direct and the
        pattern bindings stop matching.
      </>
    );
  })();

  return (
    <LabShell
      title="Broker Routing Lab"
      description="A publisher, an exchange, a queue per subscriber and the services behind them. Pick how the exchange routes, change the bindings, and take subscribers down."
      running={running}
      onRunningChange={setRunning}
      onReset={reset}
      events={events}
      actions={
        <Button
          variant="secondary"
          onClick={() => {
            publishOne(state.current);
            rerender();
          }}
        >
          <Send className="h-4 w-4" />
          Publish one
        </Button>
      }
      legend={
        <ParticleLegend
          outcomes={[
            { outcome: 'success', label: 'An event copy' },
            { outcome: 'warning', label: 'Handed to the wrong service' },
            { outcome: 'failure', label: 'Dropped, or a failed call' },
          ]}
        />
      }
      insight={<Insight>{insight}</Insight>}
      metrics={
        <>
          <MetricsPanel
            items={[
              { key: 'published', label: 'Published', value: formatNumber(current.published), tone: 'brand', hint: 'Events the publisher sent.' },
              {
                key: 'delivered',
                label: 'Handled',
                value: formatNumber(current.delivered),
                tone: 'ok',
                hint: 'Event copies a service that wanted them has processed. One publish can become several copies.',
              },
              {
                key: 'backlog',
                label: 'Waiting in queues',
                value: formatNumber(backlog),
                tone: backlog > 50 ? 'danger' : backlog > 10 ? 'warn' : 'neutral',
                hint: 'Events stored in queues, not yet handled. It grows while a subscriber is down or too slow.',
                simulated: true,
              },
              {
                key: 'dropped',
                label: 'Dropped as unroutable',
                value: formatNumber(current.dropped),
                tone: current.dropped ? 'warn' : 'ok',
                hint: 'Events that matched no binding. The exchange discards them and the publisher gets no error.',
              },
              {
                key: 'missed',
                label: 'Missed copies',
                value: formatNumber(current.missed),
                tone: current.missed ? 'danger' : 'ok',
                hint: 'Copies a subscriber wanted but never got: its exclusive queue was deleted, or a shared queue gave the event to another service.',
              },
              {
                key: 'failedPublishes',
                label: 'Failed publishes',
                value: formatNumber(current.failedPublishes),
                tone: current.failedPublishes ? 'danger' : 'ok',
                hint: 'Publishes that failed because a service the publisher called directly was down. Through a broker this stays at zero.',
              },
            ]}
          />
          <div className="card p-4">
            <p className="label mb-3">Who gets each routing key</p>
            <ul className="space-y-2">
              {routes.map(({ key, receivers, routed }) => (
                <li key={key} className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="w-32 shrink-0 font-mono text-ink">{key}</span>
                  {!routed ? (
                    <span className="rounded bg-danger/15 px-2 py-0.5 text-danger">
                      {broker ? 'dropped: no binding matches' : 'nobody is called'}
                    </span>
                  ) : broker && setup.shared ? (
                    <span className="rounded bg-warn/15 px-2 py-0.5 text-warn">
                      shared queue: one of {rows.length}, not {receivers.map((id) => SERVICE_BY_ID[id].name).join(' + ')}
                    </span>
                  ) : (
                    receivers.map((id) => {
                      const sub = setup.subs[id];
                      const lost = broker && sub.down && !setup.keepQueues;
                      return (
                        <span
                          key={id}
                          className={cn(
                            'rounded px-2 py-0.5',
                            lost || (!broker && sub.down)
                              ? 'bg-danger/15 text-danger line-through'
                              : sub.down
                                ? 'bg-warn/15 text-warn'
                                : 'bg-ok/15 text-ok',
                          )}
                        >
                          {SERVICE_BY_ID[id].name}
                          {sub.down ? (broker && setup.keepQueues ? ' (waiting)' : ' (down)') : ''}
                        </span>
                      );
                    })
                  )}
                </li>
              ))}
            </ul>
            <p className="mt-3 text-[11px] text-faint">
              {SIMULATED_HINT} Each service handles a fixed number of events per second (Analytics{' '}
              {SERVICE_BY_ID.analytics.rate}, the others 10), queues have no length limit, and a changed topology starts
              from empty queues.
            </p>
          </div>
        </>
      }
      controls={
        <>
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted">How the publisher reaches services</p>
            <SegmentedControl
              size="sm"
              className="w-full"
              value={setup.wiring}
              options={[
                { value: 'broker', label: 'Through the broker' },
                { value: 'calls', label: 'Direct calls' },
              ]}
              onChange={change('wiring')}
            />
          </div>
          {broker ? (
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted">Exchange type</p>
              <SegmentedControl
                size="sm"
                className="w-full"
                value={setup.exchange}
                options={EXCHANGE_TYPES}
                onChange={change('exchange')}
              />
              <p className="text-[11px] text-faint">
                Direct: binding equals the key. Fanout: every bound queue. Topic: * is one word, # is zero or more.
              </p>
            </div>
          ) : (
            <p className="text-[11px] text-faint">
              No exchange: the publisher code decides whom to call, using the same keys the services bind with.
            </p>
          )}
          <Select
            label="Routing key published"
            value={setup.publish}
            options={[{ value: 'mixed', label: 'Mixed keys (all four)' }, ...ROUTING_KEYS.map((key) => ({ value: key, label: key }))]}
            onChange={change('publish')}
            hint="The label the publisher puts on each event. It names what happened, not who should get it."
          />
          <Slider
            label="Publish rate"
            value={setup.rate}
            min={0}
            max={12}
            step={1}
            onChange={change('rate')}
            format={(value) => `${value} events/s`}
            hint={`Analytics handles ${SERVICE_BY_ID.analytics.rate} events/s, the others 10 (simplified).`}
          />
          {broker ? (
            <>
              <Toggle
                label="Queues outlive subscribers"
                checked={setup.keepQueues}
                onChange={change('keepQueues')}
                disabled={setup.shared}
                description={
                  setup.keepQueues
                    ? 'Named queues keep collecting while a subscriber is away'
                    : 'Exclusive queues: deleted when the subscriber disconnects'
                }
              />
              <Toggle
                label="One shared queue"
                checked={setup.shared}
                onChange={change('shared')}
                description="Every subscriber consumes from the same queue"
              />
            </>
          ) : null}
          <div className="space-y-3">
            <p className="text-xs font-medium text-muted">Subscribers</p>
            {SERVICES.map(({ id, name }) => {
              const sub = setup.subs[id];
              return (
                <div key={id} className="space-y-2 border-t border-line pt-3">
                  <Toggle label={name} checked={sub.on} onChange={(on) => changeSub(id, { on })} />
                  {sub.on ? (
                    <>
                      <Select
                        label={broker ? 'Binding key' : 'Called for'}
                        value={sub.binding}
                        options={BINDING_KEYS.map((key) => ({ value: key, label: key }))}
                        onChange={(binding) => changeSub(id, { binding })}
                        hint={
                          broker && setup.exchange === 'fanout'
                            ? 'A fanout exchange ignores it.'
                            : 'Exact keys match in every mode. order.* and # are patterns only on a topic exchange.'
                        }
                      />
                      <Toggle label="Service down" checked={sub.down} onChange={(down) => changeSub(id, { down })} />
                    </>
                  ) : null}
                </div>
              );
            })}
          </div>
        </>
      }
    >
      <DiagramCanvas layout={layout} edges={edges} particles={particleViews} height={HEIGHT} className="bg-canvas">
        <ArchNode
          kind="server"
          title="Publisher"
          subtitle={setup.publish === 'mixed' ? 'mixed keys' : setup.publish}
          placed={layout.pub}
          compact
        >
          {broker ? (
            <NodeStatRow label="Sent" value={formatNumber(current.published)} />
          ) : (
            <NodeStatRow
              label="Failed"
              value={formatNumber(current.failedPublishes)}
              tone={current.failedPublishes ? 'text-danger' : 'text-ok'}
            />
          )}
        </ArchNode>

        {layout.ex ? (
          <ArchNode
            kind="api-gateway"
            title={`${setup.exchange[0].toUpperCase()}${setup.exchange.slice(1)} exchange`}
            subtitle={EXCHANGE_BLURB[setup.exchange]}
            placed={layout.ex}
            alert={droppedKeys.length > 0}
            compact
          >
            <NodeStatRow label="Dropped" value={formatNumber(current.dropped)} tone={current.dropped ? 'text-warn' : 'text-ink'} />
          </ArchNode>
        ) : null}

        {layout.shared ? (
          <ArchNode
            kind="queue"
            title="Shared queue"
            subtitle={`${rows.length} competing consumers`}
            placed={layout.shared}
            alert={current.shared.length > 20}
            compact
          >
            <NodeStatRow label="Waiting" value={formatNumber(current.shared.length)} />
          </ArchNode>
        ) : null}

        {rows.map((id) => {
          const queue = layout[`q-${id}`];
          const depth = current.queues[id].length;
          return queue ? (
            <ArchNode
              key={`q-${id}`}
              kind="queue"
              title={`${SERVICE_BY_ID[id].name} queue`}
              subtitle={setup.keepQueues ? 'outlives subscriber' : 'exclusive'}
              placed={queue}
              alert={depth > 20}
              compact
            >
              <NodeStatRow label="Waiting" value={formatNumber(depth)} tone={depth > 20 ? 'text-warn' : 'text-ink'} />
            </ArchNode>
          ) : null;
        })}

        {rows.map((id) => {
          const sub = setup.subs[id];
          return (
            <ArchNode
              key={`s-${id}`}
              kind="service"
              title={SERVICE_BY_ID[id].name}
              subtitle={
                broker
                  ? setup.exchange === 'fanout' && !setup.shared
                    ? 'gets every event'
                    : `binds ${sub.binding}`
                  : `called for ${sub.binding}`
              }
              placed={layout[`s-${id}`]}
              status={sub.down ? 'down' : 'healthy'}
              compact
            >
              <NodeStatRow label={`Handled (${SERVICE_BY_ID[id].rate}/s max)`} value={formatNumber(current.handled[id])} />
            </ArchNode>
          );
        })}
      </DiagramCanvas>
    </LabShell>
  );
}

export default BrokerRoutingLab;
