import { useRef, useState } from 'react';
import { ShoppingCart, Zap } from 'lucide-react';
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
import { Button, SegmentedControl, Slider, Toggle } from '@/components/ui';
import { advanceParticles, nextParticleId, useEventLog, useTicker, type Particle } from '@/simulations/engine';
import { useRerender } from '@/hooks/useRerender';
import { cn } from '@/utils/cn';
import type { RequestOutcome } from '@/types';
import { useLabRunning } from '@/hooks/useLabRunning';

/**
 * Outbox pattern: an Order service must save an order and publish OrderPlaced.
 * With a dual write it does the two in separate steps, and a crash between them
 * leaves a committed order with no event (commit first) or an event for an order
 * that never committed (publish first). With the outbox, the order row and the
 * event row commit in one transaction, and a separate relay publishes from the
 * outbox table and marks rows sent. A relay crash after the publish and before
 * the mark republishes the row, so the consumer must deduplicate by event id.
 *
 * Simplified model, not a measurement: every hop takes the same simulated time,
 * the crash chance is per order and always lands between the two steps (or, with
 * the outbox, inside the transaction), the relay claims up to three rows per poll,
 * and sent rows are never pruned here.
 */

type Strategy = 'commit-first' | 'publish-first' | 'outbox';

interface Setup {
  strategy: Strategy;
  /** Chance that the Order service crashes between its two steps, per order. */
  crashChance: number;
  /** Simulated seconds between two relay polls. */
  pollInterval: number;
  /** Chance that the relay crashes after publishing, before marking the rows sent. */
  relayCrashChance: number;
  relayOn: boolean;
  idempotentConsumer: boolean;
  autoOrders: boolean;
}

/** Opens on the most common dual write (commit, then publish), so the first thing the learner sees is a lost event. */
const DEFAULT_SETUP: Setup = {
  strategy: 'commit-first',
  crashChance: 0.2,
  pollInterval: 1,
  relayCrashChance: 0.15,
  relayOn: true,
  idempotentConsumer: true,
  autoOrders: true,
};

const STRATEGIES: { value: Strategy; label: string }[] = [
  { value: 'commit-first', label: 'Commit, publish' },
  { value: 'publish-first', label: 'Publish, commit' },
  { value: 'outbox', label: 'Outbox' },
];

/** Simulated seconds. */
const ORDER_INTERVAL_S = 1.8;
const SERVICE_RESTART_S = 1.2;
const RELAY_RESTART_S = 1.5;
const LEG_SPEED = 1.5;
const RELAY_BATCH = 3;
const LAG_ALERT_S = 5;

const LAYOUT: Layout = {
  client: { x: 20, y: 61, w: 160, h: 116 },
  service: { x: 240, y: 50, w: 220, h: 139 },
  broker: { x: 540, y: 50, w: 190, h: 139 },
  consumer: { x: 770, y: 50, w: 170, h: 139 },
  orders: { x: 240, y: 290, w: 220, h: 116 },
  outbox: { x: 510, y: 290, w: 220, h: 116 },
  relay: { x: 770, y: 290, w: 170, h: 116 },
};

/** Both tables live in one database, so one local transaction can cover them. */
const DATABASE_BOX = { x: 222, y: 250, w: 528, h: 170 };

type Stage =
  | 'request'
  | 'write'
  | 'txn'
  | 'txn-shadow'
  | 'db-ack'
  | 'publish'
  | 'broker-ack'
  | 'commit'
  | 'response'
  | 'poll'
  | 'relay-publish'
  | 'relay-ack'
  | 'mark'
  | 'deliver';

type Hop = {
  stage: Stage;
  order: number;
  /** Outbox row ids a relay particle carries. */
  rows?: number[];
  /** The event a delivery carries. */
  eventId?: string;
};

interface OrderRow {
  id: number;
  committedAt: number;
  event: 'waiting' | 'published' | 'lost';
}

interface OutboxRow {
  id: number;
  order: number;
  createdAt: number;
  status: 'unsent' | 'claimed' | 'sent';
  publishes: number;
}

interface BrokerEvent {
  seq: number;
  eventId: string;
  order: number;
  phantom: boolean;
  duplicate: boolean;
}

interface Stats {
  placed: number;
  committed: number;
  rolledBack: number;
  rejected: number;
  serviceCrashes: number;
  relayCrashes: number;
  lost: number;
  phantom: number;
  published: number;
  republished: number;
  processed: number;
  processedTwice: number;
  deduped: number;
  phantomProcessed: number;
  delaySum: number;
  delayCount: number;
}

interface SimState {
  clock: number;
  nextOrderAt: number;
  nextOrder: number;
  nextSeq: number;
  nextPollAt: number;
  particles: Particle[];
  orders: Map<number, OrderRow>;
  outbox: OutboxRow[];
  topic: BrokerEvent[];
  seen: Set<string>;
  processedCount: Map<string, number>;
  serviceDownUntil: number;
  relayDownUntil: number;
  relayBusy: boolean;
  /** "Crash the service" was pressed: the next order to reach its crash point crashes. */
  forceCrash: boolean;
  stats: Stats;
}

const createState = (): SimState => ({
  clock: 0,
  nextOrderAt: 0.4,
  nextOrder: 0,
  nextSeq: 0,
  nextPollAt: 0,
  particles: [],
  orders: new Map(),
  outbox: [],
  topic: [],
  seen: new Set(),
  processedCount: new Map(),
  serviceDownUntil: 0,
  relayDownUntil: 0,
  relayBusy: false,
  forceCrash: false,
  stats: {
    placed: 0,
    committed: 0,
    rolledBack: 0,
    rejected: 0,
    serviceCrashes: 0,
    relayCrashes: 0,
    lost: 0,
    phantom: 0,
    published: 0,
    republished: 0,
    processed: 0,
    processedTwice: 0,
    deduped: 0,
    phantomProcessed: 0,
    delaySum: 0,
    delayCount: 0,
  },
});

const hopOf = (particle: Particle) => particle.meta as Hop;
const eventIdOf = (order: number) => `evt-${order}`;

export function OutboxLab() {
  const [setup, setSetup] = useState(DEFAULT_SETUP);
  const { strategy, crashChance, pollInterval, relayCrashChance, relayOn, idempotentConsumer, autoOrders } = setup;
  const change =
    <K extends keyof Setup>(key: K) =>
    (value: Setup[K]) =>
      setSetup((current) => ({ ...current, [key]: value }));
  const [running, setRunning] = useLabRunning();
  const sim = useRef<SimState>(createState());
  const rerender = useRerender(30);
  const { events, log, clear } = useEventLog();

  const spawn = (route: string[], outcome: RequestOutcome, hop: Hop) => {
    sim.current.particles.push({ id: nextParticleId(), route, leg: 0, t: 0, speed: LEG_SPEED, outcome, meta: hop });
  };

  const serviceDown = () => sim.current.clock < sim.current.serviceDownUntil;
  const relayDown = () => sim.current.clock < sim.current.relayDownUntil;

  /** Rolls the dice for the crash window of one order, and takes the service down if it hits. */
  const crashesNow = () => {
    const state = sim.current;
    if (serviceDown()) return true;
    const hit = state.forceCrash || Math.random() < crashChance;
    if (!hit) return false;
    state.forceCrash = false;
    state.serviceDownUntil = state.clock + SERVICE_RESTART_S;
    state.stats.serviceCrashes += 1;
    return true;
  };

  const placeOrder = () => {
    const state = sim.current;
    state.nextOrder += 1;
    state.stats.placed += 1;
    spawn(['client', 'service'], 'success', { stage: 'request', order: state.nextOrder });
  };

  const commitOrder = (order: number, event: OrderRow['event']) => {
    const state = sim.current;
    state.orders.set(order, { id: order, committedAt: state.clock, event });
    state.stats.committed += 1;
  };

  /** An event reaches the broker topic; the consumer gets a copy. */
  const appendToTopic = (order: number, eventId: string, duplicate: boolean, phantom: boolean) => {
    const state = sim.current;
    state.nextSeq += 1;
    state.topic.push({ seq: state.nextSeq, eventId, order, phantom, duplicate });
    if (state.topic.length > 60) state.topic.shift();
    state.stats.published += 1;
    if (duplicate) state.stats.republished += 1;
    spawn(['broker', 'consumer'], duplicate ? 'warning' : 'success', { stage: 'deliver', order, eventId });
  };

  const recordDelay = (order: number) => {
    const state = sim.current;
    const row = state.orders.get(order);
    if (!row) return;
    state.stats.delaySum += state.clock - row.committedAt;
    state.stats.delayCount += 1;
  };

  const arrive = (particle: Particle) => {
    const state = sim.current;
    const hop = hopOf(particle);
    const { order } = hop;

    switch (hop.stage) {
      case 'request': {
        if (serviceDown()) {
          state.stats.rejected += 1;
          log(`Order #${order}: the service is restarting - the client gets an error, nothing was written`, 'info');
          return;
        }
        if (strategy === 'commit-first') spawn(['service', 'orders'], 'success', { stage: 'write', order });
        else if (strategy === 'publish-first')
          spawn(['service', 'broker'], 'success', { stage: 'publish', order, eventId: eventIdOf(order) });
        else {
          // One transaction: both particles travel together and arrive in the same tick.
          spawn(['service', 'orders'], 'success', { stage: 'txn', order });
          spawn(['service', 'outbox'], 'success', { stage: 'txn-shadow', order });
        }
        return;
      }

      case 'write': {
        if (serviceDown()) {
          // The service died while its transaction was open: the database rolls it back.
          state.stats.rolledBack += 1;
          log(`Order #${order}: the service went down before COMMIT - rolled back, nothing written`, 'info');
          return;
        }
        commitOrder(order, 'waiting');
        spawn(['orders', 'service'], 'success', { stage: 'db-ack', order });
        return;
      }

      case 'db-ack': {
        // Commit, then publish: the crash window is right here.
        if (crashesNow()) {
          const row = state.orders.get(order);
          if (row) row.event = 'lost';
          state.stats.lost += 1;
          log(`Order #${order}: committed, then the service crashed before publishing - the event is lost for good`, 'danger');
          return;
        }
        spawn(['service', 'broker'], 'success', { stage: 'publish', order, eventId: eventIdOf(order) });
        return;
      }

      case 'publish': {
        appendToTopic(order, eventIdOf(order), false, false);
        const row = state.orders.get(order);
        if (row) {
          // Commit, then publish: the order is already in; this was the second step.
          row.event = 'published';
          recordDelay(order);
          spawn(['broker', 'service', 'client'], 'success', { stage: 'response', order });
        } else {
          // Publish, then commit: the broker acknowledges and the service goes on to commit.
          spawn(['broker', 'service'], 'success', { stage: 'broker-ack', order });
        }
        return;
      }

      case 'broker-ack': {
        // Publish, then commit: the event is already out when the crash hits.
        if (crashesNow()) {
          const event = state.topic.find((item) => item.eventId === eventIdOf(order));
          if (event) event.phantom = true;
          state.stats.phantom += 1;
          log(`Order #${order}: event published, then the service crashed before the commit - a phantom event for an order that does not exist`, 'danger');
          return;
        }
        spawn(['service', 'orders'], 'success', { stage: 'commit', order });
        return;
      }

      case 'commit': {
        if (serviceDown()) {
          const event = state.topic.find((item) => item.eventId === eventIdOf(order));
          if (event) event.phantom = true;
          state.stats.phantom += 1;
          log(`Order #${order}: the service went down before COMMIT - the order rolled back, but its event is already out`, 'danger');
          return;
        }
        commitOrder(order, 'published');
        spawn(['orders', 'service', 'client'], 'success', { stage: 'response', order });
        return;
      }

      case 'txn': {
        if (serviceDown()) {
          state.stats.rolledBack += 1;
          log(`Order #${order}: the service went down before COMMIT - the order row and the outbox row roll back together`, 'ok');
          return;
        }
        if (crashesNow()) {
          if (Math.random() < 0.5) {
            state.stats.rolledBack += 1;
            log(`Order #${order}: the service crashed before COMMIT - the order row and the outbox row roll back together. No order, no event: consistent`, 'ok');
            return;
          }
          log(`Order #${order}: the service crashed just after COMMIT - both rows are safe, the relay will publish the event`, 'ok');
        } else {
          spawn(['orders', 'service', 'client'], 'success', { stage: 'response', order });
        }
        commitOrder(order, 'waiting');
        state.outbox.push({ id: order, order, createdAt: state.clock, status: 'unsent', publishes: 0 });
        if (state.outbox.length > 200) state.outbox.shift();
        return;
      }

      case 'poll': {
        spawn(['relay', 'broker'], 'success', { stage: 'relay-publish', order, rows: hop.rows });
        return;
      }

      case 'relay-publish': {
        for (const id of hop.rows ?? []) {
          const row = state.outbox.find((item) => item.id === id);
          if (!row) continue;
          const duplicate = row.publishes > 0;
          row.publishes += 1;
          appendToTopic(row.order, eventIdOf(row.order), duplicate, false);
          const orderRow = state.orders.get(row.order);
          if (orderRow && !duplicate) {
            orderRow.event = 'published';
            recordDelay(row.order);
          }
        }
        spawn(['broker', 'relay'], 'success', { stage: 'relay-ack', order, rows: hop.rows });
        return;
      }

      case 'relay-ack': {
        if (Math.random() < relayCrashChance) {
          state.relayDownUntil = state.clock + RELAY_RESTART_S;
          state.relayBusy = false;
          state.stats.relayCrashes += 1;
          for (const id of hop.rows ?? []) {
            const row = state.outbox.find((item) => item.id === id);
            if (row && row.status === 'claimed') row.status = 'unsent';
          }
          log(`Relay crashed after publishing, before marking rows sent - ${(hop.rows ?? []).map(eventIdOf).join(', ')} will be published again`, 'warn');
          return;
        }
        spawn(['relay', 'outbox'], 'success', { stage: 'mark', order, rows: hop.rows });
        return;
      }

      case 'mark': {
        for (const id of hop.rows ?? []) {
          const row = state.outbox.find((item) => item.id === id);
          if (row) row.status = 'sent';
        }
        state.relayBusy = false;
        return;
      }

      case 'deliver': {
        const eventId = hop.eventId ?? eventIdOf(order);
        if (idempotentConsumer && state.seen.has(eventId)) {
          state.stats.deduped += 1;
          log(`Fulfilment: ${eventId} seen before - skipped, the order ships once`, 'ok');
          return;
        }
        state.seen.add(eventId);
        const count = (state.processedCount.get(eventId) ?? 0) + 1;
        state.processedCount.set(eventId, count);
        state.stats.processed += 1;
        if (count === 2) {
          state.stats.processedTwice += 1;
          log(`Fulfilment: ${eventId} processed a second time - order #${order} ships twice`, 'danger');
        }
        return;
      }

      default:
        return;
    }
  };

  useTicker(running, (dt) => {
    const state = sim.current;
    state.clock += dt;

    if (autoOrders && state.clock >= state.nextOrderAt) {
      placeOrder();
      state.nextOrderAt = state.clock + ORDER_INTERVAL_S;
    }

    // The relay: poll the outbox, claim the oldest unsent rows (like FOR UPDATE SKIP LOCKED).
    if (strategy === 'outbox' && relayOn && !relayDown() && !state.relayBusy && state.clock >= state.nextPollAt) {
      state.nextPollAt = state.clock + pollInterval;
      const claimed = state.outbox.filter((row) => row.status === 'unsent').slice(0, RELAY_BATCH);
      if (claimed.length) {
        claimed.forEach((row) => (row.status = 'claimed'));
        state.relayBusy = true;
        spawn(['outbox', 'relay'], 'success', { stage: 'poll', order: claimed[0].order, rows: claimed.map((row) => row.id) });
      }
    }

    const { alive, finished } = advanceParticles(state.particles, dt);
    state.particles = alive.slice(-90);
    finished.forEach(arrive);

    // A phantom event is counted as processed by fulfilment once both the crash and the delivery happened.
    let phantomProcessed = 0;
    for (const event of state.topic) if (event.phantom && state.processedCount.has(event.eventId)) phantomProcessed += 1;
    state.stats.phantomProcessed = phantomProcessed;
    rerender();
  });

  const reset = () => {
    sim.current = createState();
    setSetup(DEFAULT_SETUP);
    clear();
    rerender();
  };

  const crashNext = () => {
    sim.current.forceCrash = true;
    log('Crash armed: the service will crash at the next order, between its two steps', 'warn');
    if (!autoOrders) placeOrder();
  };

  const state = sim.current;
  const { stats } = state;
  const outboxOn = strategy === 'outbox';
  const down = state.clock < state.serviceDownUntil;
  const relayIsDown = state.clock < state.relayDownUntil;
  const unsent = state.outbox.filter((row) => row.status !== 'sent');
  const oldestUnsent = unsent.length ? state.clock - Math.min(...unsent.map((row) => row.createdAt)) : 0;
  const lagAlert = outboxOn && oldestUnsent > LAG_ALERT_S;
  const avgDelay = stats.delayCount ? stats.delaySum / stats.delayCount : 0;
  const orderRows = [...state.orders.values()].slice(-5).reverse();
  const outboxRows = state.outbox.slice(-5).reverse();
  const topicRows = state.topic.slice(-5).reverse();

  const particleViews: ParticleView[] = state.particles.map((particle) => {
    const hop = hopOf(particle);
    const phantom = hop.stage === 'deliver' && state.topic.some((item) => item.eventId === hop.eventId && item.phantom);
    return {
      id: particle.id,
      from: particle.route[particle.leg],
      to: particle.route[particle.leg + 1],
      t: particle.t,
      outcome: phantom ? 'failure' : (particle.outcome ?? 'success'),
    };
  });

  const edges: DiagramEdge[] = [
    { from: 'client', to: 'service', tone: 'brand' },
    { from: 'service', to: 'orders', tone: 'violet' },
    { from: 'service', to: 'outbox', tone: outboxOn ? 'violet' : 'muted', dashed: !outboxOn },
    { from: 'service', to: 'broker', tone: outboxOn ? 'muted' : 'warn', dashed: outboxOn },
    { from: 'outbox', to: 'relay', tone: outboxOn ? 'ok' : 'muted', dashed: !outboxOn || !relayOn },
    { from: 'relay', to: 'broker', tone: outboxOn ? 'ok' : 'muted', dashed: !outboxOn || !relayOn },
    { from: 'broker', to: 'consumer', tone: 'brand' },
  ];

  const underlay = (
    <g>
      <rect
        x={DATABASE_BOX.x}
        y={DATABASE_BOX.y}
        width={DATABASE_BOX.w}
        height={DATABASE_BOX.h}
        rx={14}
        className="fill-elevated stroke-line"
        fillOpacity={0.6}
        strokeDasharray="6 5"
        strokeWidth={1.5}
      />
      <text
        x={DATABASE_BOX.x + 14}
        y={DATABASE_BOX.y + 24}
        className="fill-muted font-mono"
        style={{ fontSize: 11 }}
      >
        {outboxOn ? 'Orders DB - order row + outbox row in one transaction' : 'Orders DB - the broker is not in this transaction'}
      </text>
    </g>
  );

  return (
    <LabShell
      title="Outbox Lab"
      description="Save an order and publish OrderPlaced. Crash the service between the two steps and watch an event go missing or appear for an order that does not exist. Then switch to the outbox and watch every committed order get its event from the outbox row."
      running={running}
      onRunningChange={setRunning}
      onReset={reset}
      legend={
        <ParticleLegend
          outcomes={['success', { outcome: 'warning', label: 'Duplicate event' }, { outcome: 'failure', label: 'Phantom event' }]}
        />
      }
      events={events}
      actions={
        <>
          <Button variant="secondary" onClick={crashNext}>
            <Zap className="h-4 w-4" />
            Crash the service
          </Button>
          <Button variant="primary" onClick={placeOrder}>
            <ShoppingCart className="h-4 w-4" />
            Place order
          </Button>
        </>
      }
      insight={
        <Insight>
          {strategy === 'commit-first' ? (
            <>
              The order commits, then the service publishes. A crash in between leaves an order in the database that no
              other service will ever hear about - {stats.lost} lost so far. Nothing records that the publish was
              missing, so nothing retries it. Try Publish, commit to see the opposite failure, or press Crash the service.
            </>
          ) : strategy === 'publish-first' ? (
            <>
              Swapping the order does not help, it only changes the failure: the event is out before the commit, so a
              crash in between leaves fulfilment acting on an order that does not exist - {stats.phantom} phantom
              event{stats.phantom === 1 ? '' : 's'} (red crosses). Choose Outbox.
            </>
          ) : !relayOn ? (
            <>
              The relay is stopped. Orders still commit with their outbox rows, so nothing is lost - the rows wait.
              Watch Oldest unsent row climb: that is the number to alert on. Turn the relay back on and the backlog is
              published in order.
            </>
          ) : (
            <>
              The order row and the outbox row commit in one transaction, so a crash leaves both or neither - the Lost
              and Phantom counters stop growing. The relay publishes from the committed row. A relay crash after
              publishing republishes the row ({stats.republished} duplicate{stats.republished === 1 ? '' : 's'}, amber
              triangles): delivery is at least once.{' '}
              {idempotentConsumer
                ? `The consumer skips repeats by event id (${stats.deduped} skipped). Turn Idempotent consumer off to see why it matters.`
                : `The consumer does not deduplicate, so ${stats.processedTwice} order${stats.processedTwice === 1 ? '' : 's'} shipped twice.`}
            </>
          )}
        </Insight>
      }
      metrics={
        <>
          <MetricsPanel
            items={[
              { key: 'committed', label: 'Orders committed', value: stats.committed, hint: 'Order rows in the database.' },
              {
                key: 'lost',
                label: 'Lost events',
                value: stats.lost,
                tone: stats.lost > 0 ? 'danger' : 'ok',
                hint: 'Committed orders whose event was never published: the service crashed after the commit and before the publish.',
              },
              {
                key: 'phantom',
                label: 'Phantom events',
                value: stats.phantom,
                tone: stats.phantom > 0 ? 'danger' : 'ok',
                hint: 'Events published for an order that never committed: the service crashed after the publish and before the commit.',
              },
              {
                key: 'rolledback',
                label: 'Rolled back',
                value: stats.rolledBack,
                hint: 'Outbox transactions cut before COMMIT: neither the order nor the event exists, which is consistent. The client gets an error and can retry.',
              },
              {
                key: 'republished',
                label: 'Published again',
                value: stats.republished,
                tone: stats.republished > 0 ? 'warn' : 'neutral',
                hint: 'Outbox rows the relay published twice because it crashed before marking them sent.',
              },
              {
                key: 'twice',
                label: 'Shipped twice',
                value: stats.processedTwice,
                tone: stats.processedTwice > 0 ? 'danger' : 'ok',
                hint: 'Events the consumer processed more than once. An idempotent consumer keeps this at 0.',
              },
              {
                key: 'lag',
                label: 'Oldest unsent row',
                value: outboxOn ? `${oldestUnsent.toFixed(1)} s` : '-',
                tone: lagAlert ? 'danger' : 'neutral',
                hint: `Age of the oldest outbox row not yet marked sent. Alert on it: a stalled relay shows here in seconds. Red above ${LAG_ALERT_S} s.`,
                simulated: true,
              },
              {
                key: 'delay',
                label: 'Commit to publish',
                value: `${avgDelay.toFixed(2)} s`,
                hint: 'Average time from the order commit to the first publish of its event. The outbox adds up to one poll interval.',
                simulated: true,
              },
            ]}
          />
          <div className="grid gap-4 md:grid-cols-3">
            <div className="card p-4">
              <p className="label mb-3">orders table (newest first)</p>
              {orderRows.length === 0 ? (
                <p className="text-xs text-faint">No orders yet.</p>
              ) : (
                <ul className="space-y-1.5 font-mono text-[11px]">
                  {orderRows.map((row) => (
                    <li key={row.id} className={cn('flex items-center gap-2', row.event === 'lost' ? 'text-danger' : 'text-muted')}>
                      <span className="w-16 shrink-0 text-ink">order #{row.id}</span>
                      <span className="min-w-0 truncate">
                        {row.event === 'lost' ? 'EVENT LOST' : row.event === 'published' ? 'event published' : 'event waiting'}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="card p-4">
              <p className="label mb-3">outbox table</p>
              {!outboxOn && outboxRows.length === 0 ? (
                <p className="text-xs text-faint">Not used: the service publishes directly.</p>
              ) : outboxRows.length === 0 ? (
                <p className="text-xs text-faint">No rows yet.</p>
              ) : (
                <ul className="space-y-1.5 font-mono text-[11px] text-muted">
                  {outboxRows.map((row) => (
                    <li key={row.id} className="flex items-center gap-2">
                      <span className="w-16 shrink-0 text-ink">{eventIdOf(row.order)}</span>
                      <span className={row.status === 'sent' ? 'text-ok' : 'text-warn'}>
                        {row.status === 'sent' ? 'sent' : row.status === 'claimed' ? 'publishing' : 'unsent'}
                      </span>
                      {row.publishes > 1 ? <span className="ml-auto shrink-0 text-warn">published x{row.publishes}</span> : null}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="card p-4">
              <p className="label mb-3">order-events topic</p>
              {topicRows.length === 0 ? (
                <p className="text-xs text-faint">No events yet.</p>
              ) : (
                <ul className="space-y-1.5 font-mono text-[11px] text-muted">
                  {topicRows.map((row) => (
                    <li key={row.seq} className={cn('flex items-center gap-2', row.phantom && 'text-danger')}>
                      <span className="w-16 shrink-0 text-ink">{row.eventId}</span>
                      {row.phantom ? <span>PHANTOM - no such order</span> : row.duplicate ? <span className="text-warn">duplicate</span> : <span>ok</span>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
          <p className="text-xs text-faint">
            {SIMULATED_HINT} Every hop takes the same simulated time, a crash always lands between
            the two steps (or inside the outbox transaction, half before and half after COMMIT), the service restarts in{' '}
            {SERVICE_RESTART_S} s, the relay claims up to {RELAY_BATCH} rows per poll, and sent rows are never pruned here.
            A real outbox deletes sent rows on a schedule so the table stays small.
          </p>
        </>
      }
      controls={
        <>
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted">How the event is published</p>
            <SegmentedControl size="sm" className="w-full" value={strategy} options={STRATEGIES} onChange={change('strategy')} />
            <p className="text-[11px] text-faint">
              {strategy === 'commit-first'
                ? 'Dual write: commit the order, then publish to the broker in a second step.'
                : strategy === 'publish-first'
                  ? 'Dual write: publish to the broker first, then commit the order.'
                  : 'One transaction writes the order row and the outbox row. A relay publishes from the outbox.'}
            </p>
          </div>
          <Slider
            label="Service crash chance"
            value={crashChance}
            min={0}
            max={0.5}
            step={0.05}
            onChange={change('crashChance')}
            format={(value) => `${Math.round(value * 100)}%`}
            tone="danger"
            hint="Chance per order that the Order service crashes (a deploy, an out-of-memory kill, a timeout) between its two steps."
          />
          <Slider
            label="Relay poll interval"
            value={pollInterval}
            min={0.25}
            max={3}
            step={0.25}
            onChange={change('pollInterval')}
            format={(value) => `${value} s`}
            disabled={!outboxOn}
            hint="How often the relay queries the outbox for unsent rows. Longer means fewer queries and a later publish."
          />
          <Slider
            label="Relay crash chance"
            value={relayCrashChance}
            min={0}
            max={0.5}
            step={0.05}
            onChange={change('relayCrashChance')}
            format={(value) => `${Math.round(value * 100)}%`}
            tone="warn"
            disabled={!outboxOn}
            hint="Chance per batch that the relay crashes after the broker accepted the events and before it marks the rows sent."
          />
          <Toggle
            label="Relay running"
            checked={relayOn}
            onChange={change('relayOn')}
            disabled={!outboxOn}
            description="Stop it to see rows wait in the outbox instead of being lost."
          />
          <Toggle
            label="Idempotent consumer"
            checked={idempotentConsumer}
            onChange={change('idempotentConsumer')}
            description="Fulfilment remembers processed event ids and skips a repeat."
          />
          <Toggle
            label="Automatic orders"
            checked={autoOrders}
            onChange={change('autoOrders')}
            description={`A new order every ${ORDER_INTERVAL_S} s. Turn off to follow one order at a time.`}
          />
        </>
      }
    >
      <DiagramCanvas
        layout={LAYOUT}
        edges={edges}
        particles={particleViews}
        underlay={underlay}
        height={440}
        className="bg-canvas"
      >
        <ArchNode kind="client" title="Checkout" subtitle="places orders" placed={LAYOUT.client} compact>
          <NodeStatRow label="Orders" value={stats.placed} />
          <NodeStatRow label="Errors" value={stats.rejected + stats.rolledBack} />
        </ArchNode>
        <ArchNode
          kind="service"
          title="Order service"
          subtitle={outboxOn ? 'one transaction' : strategy === 'commit-first' ? 'commit, then publish' : 'publish, then commit'}
          placed={LAYOUT.service}
          status={down ? 'down' : 'healthy'}
          statusLabel={down ? 'Crashed' : undefined}
          compact
        >
          <NodeStatRow label="Crashes" value={stats.serviceCrashes} tone={stats.serviceCrashes > 0 ? 'text-warn' : 'text-ink'} />
          <NodeStatRow label="Lost events" value={stats.lost} tone={stats.lost > 0 ? 'text-danger' : 'text-ok'} />
          <NodeStatRow label="Phantom events" value={stats.phantom} tone={stats.phantom > 0 ? 'text-danger' : 'text-ok'} />
        </ArchNode>
        <ArchNode kind="queue" title="Broker" subtitle="order-events topic" placed={LAYOUT.broker} alert={stats.phantom > 0 && !outboxOn} compact>
          <NodeStatRow label="Events" value={stats.published} />
          <NodeStatRow label="Duplicates" value={stats.republished} tone={stats.republished > 0 ? 'text-warn' : 'text-ink'} />
          <NodeStatRow label="Phantoms" value={stats.phantom} tone={stats.phantom > 0 ? 'text-danger' : 'text-ink'} />
        </ArchNode>
        <ArchNode
          kind="worker"
          title="Fulfilment"
          subtitle={idempotentConsumer ? 'dedupes by event id' : 'no dedupe'}
          placed={LAYOUT.consumer}
          alert={stats.processedTwice > 0 || stats.phantomProcessed > 0}
          compact
        >
          <NodeStatRow label="Processed" value={stats.processed} />
          <NodeStatRow label="Skipped" value={stats.deduped} tone={stats.deduped > 0 ? 'text-ok' : 'text-ink'} />
          <NodeStatRow label="Twice" value={stats.processedTwice} tone={stats.processedTwice > 0 ? 'text-danger' : 'text-ink'} />
        </ArchNode>
        <ArchNode kind="sql" title="orders" subtitle="order rows" placed={LAYOUT.orders} alert={stats.lost > 0 && !outboxOn} compact>
          <NodeStatRow label="Rows" value={state.orders.size} />
          <NodeStatRow label="No event" value={stats.lost} tone={stats.lost > 0 ? 'text-danger' : 'text-ok'} />
        </ArchNode>
        <ArchNode
          kind="sql"
          title="outbox"
          subtitle="event rows"
          placed={LAYOUT.outbox}
          status={outboxOn ? 'healthy' : 'down'}
          statusLabel={outboxOn ? undefined : 'Not used'}
          alert={lagAlert}
          compact
        >
          <NodeStatRow label="Unsent" value={unsent.length} tone={lagAlert ? 'text-danger' : 'text-ink'} />
          <NodeStatRow label="Oldest" value={outboxOn ? `${oldestUnsent.toFixed(1)} s` : '-'} />
        </ArchNode>
        <ArchNode
          kind="worker"
          title="Relay"
          subtitle={`polls every ${pollInterval} s`}
          placed={LAYOUT.relay}
          status={!outboxOn || !relayOn ? 'down' : relayIsDown ? 'down' : 'healthy'}
          statusLabel={!outboxOn ? 'Not used' : !relayOn ? 'Stopped' : relayIsDown ? 'Crashed' : undefined}
          compact
        >
          <NodeStatRow label="Crashes" value={stats.relayCrashes} tone={stats.relayCrashes > 0 ? 'text-warn' : 'text-ink'} />
          <NodeStatRow label="Republished" value={stats.republished} />
        </ArchNode>
      </DiagramCanvas>
    </LabShell>
  );
}

export default OutboxLab;
