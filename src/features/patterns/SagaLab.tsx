import { useCallback, useRef, useState } from 'react';
import { ShoppingCart } from 'lucide-react';
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
import { Button, SegmentedControl, Toggle } from '@/components/ui';
import { nextParticleId, useEventLog, useTicker, type EventTone } from '@/simulations/engine';
import { useRerender } from '@/hooks/useRerender';
import { cn } from '@/utils/cn';
import type { NodeStatus, RequestOutcome } from '@/types';
import { useLabRunning } from '@/hooks/useLabRunning';

/*
 * Simplified model, not a measurement. One saga runs at a time and its messages
 * travel one after another, so the order of the steps is easy to follow. The
 * order (2 units, 89 euro), the timeout and the backoff delays are round,
 * illustrative numbers. In choreography the event bus delivers each event to
 * the one subscriber that acts on it next; other subscribers are not drawn.
 */

type Mode = 'orchestration' | 'choreography';
type FailAt = 'none' | 'inventory' | 'payment' | 'shipping';
type RefundTrouble = 'none' | 'reply-lost' | 'payment-down';

interface Setup {
  mode: Mode;
  failAt: FailAt;
  refundTrouble: RefundTrouble;
  idempotent: boolean;
  autoRepeat: boolean;
}

/** Single host, no Lab focus: the lab opens on an orchestrated saga whose last step fails. */
const DEFAULT_SETUP: Setup = {
  mode: 'orchestration',
  failAt: 'shipping',
  refundTrouble: 'none',
  idempotent: true,
  autoRepeat: true,
};

const UNITS = 2;
const PRICE = 89;
const START_STOCK = 10;
/** Legs per second for one message. */
const HOP_SPEED = 1.15;
/** Pause between two messages, in seconds. */
const HOP_GAP = 0.2;
/** How long the orchestrator waits for a reply before it retries, in seconds. */
const REPLY_TIMEOUT = 1.2;
/** Attempts at a compensation before the saga is parked for a human. */
const MAX_ATTEMPTS = 3;
/** Pause after a saga ends before the next order is placed automatically. */
const NEXT_ORDER_DELAY = 3;

/** React keys for statement lines and result rows. Plain counter: these are rows, not particles. */
let rowCounter = 0;
const nextRowId = () => ++rowCounter;

type StepId = 'order' | 'inventory' | 'payment' | 'shipping';
type StepState = 'not run' | 'committed' | 'failed' | 'compensated' | 'stuck';
type OrderStatus = 'none' | 'PENDING' | 'APPROVED' | 'REJECTED' | 'NEEDS A HUMAN';
type Outcome = 'running' | 'completed' | 'compensated' | 'stuck';

const STEPS: { id: StepId; action: string; compensation: string; service: string }[] = [
  { id: 'order', action: 'Create order (PENDING)', compensation: 'Reject order', service: 'Order' },
  { id: 'inventory', action: `Reserve ${UNITS} units`, compensation: `Release ${UNITS} units`, service: 'Inventory' },
  { id: 'payment', action: `Charge ${PRICE} euro`, compensation: `Refund ${PRICE} euro`, service: 'Payment' },
  { id: 'shipping', action: 'Schedule shipment', compensation: 'none - last step', service: 'Shipping' },
];

interface StatementLine {
  id: number;
  text: string;
  amount: number;
}

interface World {
  order: OrderStatus;
  steps: Record<StepId, StepState>;
  available: number;
  reserved: number;
  statement: StatementLine[];
  refunded: boolean;
  shipment: 'none' | 'scheduled' | 'rejected';
  paymentDown: boolean;
  parked: boolean;
  outcome: Outcome;
}

interface Note {
  text: string;
  tone?: EventTone;
}

interface Hop {
  from: string;
  to: string;
  outcome: RequestOutcome;
  /** Seconds to wait before this message is sent (a timeout or a backoff). */
  wait?: number;
  /** What happens when the message arrives: the local transaction it triggers. */
  apply?: (world: World) => Note | void;
  note?: Note;
}

interface Sim {
  setup: Setup;
  number: number;
  plan: Hop[];
  index: number;
  t: number;
  waitLeft: number;
  world: World;
  messages: number;
  /** Seconds since the saga ended, or null while it runs. */
  endedFor: number | null;
  particleId: number;
}

interface RunResult {
  id: number;
  number: number;
  mode: Mode;
  failAt: FailAt;
  outcome: Outcome;
  messages: number;
  net: number;
}

const createWorld = (setup: Setup): World => ({
  order: 'none',
  steps: { order: 'not run', inventory: 'not run', payment: 'not run', shipping: 'not run' },
  available: setup.failAt === 'inventory' ? 0 : START_STOCK,
  reserved: 0,
  statement: [],
  refunded: false,
  shipment: 'none',
  paymentDown: false,
  parked: false,
  outcome: 'running',
});

/* ---------- the local transactions, shared by both coordination styles ---------- */

const createOrder = (world: World): Note => {
  world.order = 'PENDING';
  world.steps.order = 'committed';
  return { text: 'Order: step 1 committed - order saved as PENDING' };
};

const reserveStock = (world: World): Note => {
  if (world.available < UNITS) {
    world.steps.inventory = 'failed';
    return { text: 'Inventory: out of stock - step 2 fails, nothing reserved', tone: 'danger' };
  }
  world.available -= UNITS;
  world.reserved += UNITS;
  world.steps.inventory = 'committed';
  return { text: `Inventory: step 2 committed - ${UNITS} units marked RESERVED for this saga` };
};

const chargeCard = (fail: boolean) => (world: World): Note => {
  if (fail) {
    world.steps.payment = 'failed';
    return { text: 'Payment: card declined - step 3 fails, nothing charged', tone: 'danger' };
  }
  world.statement.push({ id: nextRowId(), text: 'Charge', amount: PRICE });
  world.steps.payment = 'committed';
  return { text: `Payment: step 3 committed - card charged ${PRICE} euro` };
};

const scheduleShipment = (fail: boolean) => (world: World): Note => {
  if (fail) {
    world.shipment = 'rejected';
    world.steps.shipping = 'failed';
    return { text: 'Shipping: address undeliverable - step 4 fails', tone: 'danger' };
  }
  world.shipment = 'scheduled';
  world.steps.shipping = 'committed';
  return { text: 'Shipping: step 4 committed - shipment scheduled' };
};

/** The compensation for step 3. With idempotency keys a repeated refund is recognised and skipped. */
const refund = (idempotent: boolean) => (world: World): Note => {
  world.paymentDown = false;
  if (world.refunded && idempotent) {
    return { text: 'Payment: same idempotency key seen before - already refunded, nothing to do', tone: 'ok' };
  }
  world.statement.push({ id: nextRowId(), text: 'Refund', amount: -PRICE });
  world.steps.payment = 'compensated';
  if (world.refunded) {
    return {
      text: `Payment: no idempotency key - refunded a second time, the customer got ${PRICE * 2} euro back`,
      tone: 'danger',
    };
  }
  world.refunded = true;
  return { text: `Payment: compensation - refunded ${PRICE} euro`, tone: 'warn' };
};

const releaseStock = (world: World): Note => {
  world.available += world.reserved;
  world.reserved = 0;
  world.steps.inventory = 'compensated';
  return { text: `Inventory: compensation - ${UNITS} reserved units released`, tone: 'warn' };
};

const rejectOrder = (world: World): Note => {
  world.order = 'REJECTED';
  world.steps.order = 'compensated';
  return { text: 'Order: compensation - order marked REJECTED', tone: 'warn' };
};

const approveOrder = (world: World): Note => {
  world.order = 'APPROVED';
  // The reserved units now belong to an approved order; they leave the warehouse with the shipment.
  return { text: 'Order: order marked APPROVED', tone: 'ok' };
};

const finish = (outcome: Outcome, text: string, tone: EventTone) => (world: World): Note => {
  world.outcome = outcome;
  return { text, tone };
};

const paymentDown = (attempt: number) => (world: World): Note => {
  world.paymentDown = true;
  return { text: `Payment is down - refund attempt ${attempt} of ${MAX_ATTEMPTS} times out`, tone: 'danger' };
};

const park = (who: string) => (world: World): Note => {
  world.parked = true;
  world.steps.payment = 'stuck';
  world.outcome = 'stuck';
  if (who === 'orchestrator') world.order = 'NEEDS A HUMAN';
  return {
    text:
      who === 'orchestrator'
        ? `Orchestrator: ${MAX_ATTEMPTS} refund attempts failed - saga parked for a human, stock still reserved`
        : `Bus: ${MAX_ATTEMPTS} deliveries failed - event dead-lettered; the order still says PENDING`,
    tone: 'danger',
  };
};

/* ---------- the two plans ---------- */

/** Orchestration: the Order service runs the saga, sends each command and waits for the reply. */
function orchestrationPlan(setup: Setup): Hop[] {
  const { failAt, refundTrouble, idempotent } = setup;
  const hops: Hop[] = [{ from: 'client', to: 'order', outcome: 'success', apply: createOrder }];
  const reply = (from: string, outcome: RequestOutcome = 'success', note?: Note) =>
    hops.push({ from, to: 'order', outcome, note });
  const toClient = (outcome: RequestOutcome, result: Outcome, text: string, tone: EventTone) =>
    hops.push({ from: 'order', to: 'client', outcome, apply: finish(result, text, tone) });
  const rejectAndTell = (why: string) => {
    hops.push({ from: 'order', to: 'order', outcome: 'warning', apply: rejectOrder });
    toClient('failure', 'compensated', `Customer told: order rejected, ${why}`, 'warn');
  };

  hops.push({ from: 'order', to: 'inventory', outcome: 'success', apply: reserveStock });
  if (failAt === 'inventory') {
    reply('inventory', 'failure');
    rejectAndTell('out of stock');
    return hops;
  }
  reply('inventory');

  hops.push({ from: 'order', to: 'payment', outcome: 'success', apply: chargeCard(failAt === 'payment') });
  if (failAt === 'payment') {
    reply('payment', 'failure');
    hops.push({ from: 'order', to: 'inventory', outcome: 'warning', apply: releaseStock });
    reply('inventory', 'warning');
    rejectAndTell('card declined');
    return hops;
  }
  reply('payment');

  hops.push({ from: 'order', to: 'shipping', outcome: 'success', apply: scheduleShipment(failAt === 'shipping') });
  if (failAt !== 'shipping') {
    reply('shipping');
    hops.push({ from: 'order', to: 'order', outcome: 'success', apply: approveOrder });
    toClient('success', 'completed', 'Customer told: order confirmed - saga completed', 'ok');
    return hops;
  }
  reply('shipping', 'failure', { text: 'Orchestrator: step 4 failed - compensating steps 3, 2, 1 in reverse', tone: 'warn' });

  // Compensate step 3: the refund, and what can go wrong with it.
  if (refundTrouble === 'payment-down') {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      hops.push({
        from: 'order',
        to: 'payment',
        outcome: 'failure',
        wait: attempt === 1 ? 0 : REPLY_TIMEOUT * 2 ** (attempt - 2),
        apply: paymentDown(attempt),
      });
    }
    hops.push({ from: 'order', to: 'review', outcome: 'failure', wait: REPLY_TIMEOUT, apply: park('orchestrator') });
    return hops;
  }
  hops.push({ from: 'order', to: 'payment', outcome: 'warning', apply: refund(idempotent) });
  if (refundTrouble === 'reply-lost') {
    hops.push({
      from: 'payment',
      to: 'order',
      outcome: 'failure',
      note: { text: 'The reply is lost - the orchestrator times out and retries the refund, same saga id', tone: 'warn' },
    });
    hops.push({ from: 'order', to: 'payment', outcome: 'warning', wait: REPLY_TIMEOUT, apply: refund(idempotent) });
  }
  reply('payment', 'warning');

  hops.push({ from: 'order', to: 'inventory', outcome: 'warning', apply: releaseStock });
  reply('inventory', 'warning');
  rejectAndTell('address undeliverable');
  return hops;
}

/** Choreography: no one runs the saga. Each service reacts to an event and publishes the next one. */
function choreographyPlan(setup: Setup): Hop[] {
  const { failAt, refundTrouble, idempotent } = setup;
  const hops: Hop[] = [{ from: 'client', to: 'order', outcome: 'success', apply: createOrder }];
  const publish = (from: string, event: string, outcome: RequestOutcome = 'success') =>
    hops.push({ from, to: 'bus', outcome, note: { text: `${capital(from)} publishes ${event}`, tone: outcome === 'failure' ? 'danger' : 'info' } });
  const deliver = (to: string, outcome: RequestOutcome, apply?: Hop['apply'], wait?: number) =>
    hops.push({ from: 'bus', to, outcome, apply, wait });
  const rejectAndTell = (why: string) => {
    deliver('order', 'warning', rejectOrder);
    hops.push({
      from: 'order',
      to: 'client',
      outcome: 'failure',
      apply: finish('compensated', `Customer told: order rejected, ${why}`, 'warn'),
    });
  };

  publish('order', 'OrderCreated');
  deliver('inventory', 'success', reserveStock);
  if (failAt === 'inventory') {
    publish('inventory', 'StockUnavailable', 'failure');
    rejectAndTell('out of stock');
    return hops;
  }
  publish('inventory', 'StockReserved');

  deliver('payment', 'success', chargeCard(failAt === 'payment'));
  if (failAt === 'payment') {
    publish('payment', 'PaymentFailed', 'failure');
    deliver('inventory', 'warning', releaseStock);
    publish('inventory', 'StockReleased', 'warning');
    rejectAndTell('card declined');
    return hops;
  }
  publish('payment', 'PaymentCharged');

  deliver('shipping', 'success', scheduleShipment(failAt === 'shipping'));
  if (failAt !== 'shipping') {
    publish('shipping', 'ShipmentScheduled');
    deliver('order', 'success', approveOrder);
    hops.push({
      from: 'order',
      to: 'client',
      outcome: 'success',
      apply: finish('completed', 'Customer told: order confirmed - saga completed', 'ok'),
    });
    return hops;
  }
  publish('shipping', 'ShippingFailed', 'failure');

  if (refundTrouble === 'payment-down') {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      deliver('payment', 'failure', paymentDown(attempt), attempt === 1 ? 0 : REPLY_TIMEOUT * 2 ** (attempt - 2));
    }
    deliver('review', 'failure', park('bus'), REPLY_TIMEOUT);
    return hops;
  }
  deliver('payment', 'warning', refund(idempotent));
  if (refundTrouble === 'reply-lost') {
    // Payment refunded but crashed before it acknowledged the event, so the bus delivers it again.
    hops.push({
      from: 'payment',
      to: 'payment',
      outcome: 'failure',
      note: { text: 'Payment crashes before acknowledging ShippingFailed - the bus will deliver it again', tone: 'warn' },
    });
    deliver('payment', 'warning', refund(idempotent), REPLY_TIMEOUT);
  }
  publish('payment', 'PaymentRefunded', 'warning');
  deliver('inventory', 'warning', releaseStock);
  publish('inventory', 'StockReleased', 'warning');
  rejectAndTell('address undeliverable');
  return hops;
}

const capital = (id: string) => id.charAt(0).toUpperCase() + id.slice(1);

const createSim = (setup: Setup, number: number): Sim => ({
  setup,
  number,
  plan: setup.mode === 'orchestration' ? orchestrationPlan(setup) : choreographyPlan(setup),
  index: 0,
  t: 0,
  waitLeft: 0.4,
  world: createWorld(setup),
  messages: 0,
  endedFor: null,
  particleId: nextParticleId(),
});

/* ---------- layout ---------- */

const CANVAS_W = 960;
const CANVAS_H = 450;

const LAYOUT: Layout = {
  client: { x: 20, y: 185, w: 130, h: 74 },
  order: { x: 190, y: 160, w: 220, h: 122 },
  bus: { x: 455, y: 175, w: 180, h: 95 },
  inventory: { x: 690, y: 20, w: 250, h: 122 },
  payment: { x: 690, y: 170, w: 250, h: 122 },
  shipping: { x: 690, y: 330, w: 250, h: 95 },
  review: { x: 210, y: 340, w: 180, h: 95 },
};

const STEP_TONE: Record<StepState, string> = {
  'not run': 'text-faint',
  committed: 'text-ok',
  failed: 'text-danger',
  compensated: 'text-warn',
  stuck: 'text-danger',
};

const OUTCOME_LABEL: Record<Outcome, string> = {
  running: 'Running',
  completed: 'Completed',
  compensated: 'Compensated',
  stuck: 'Needs a human',
};

const FAIL_LABEL: Record<FailAt, string> = {
  none: 'Nothing fails',
  inventory: 'Inventory fails',
  payment: 'Payment fails',
  shipping: 'Shipping fails',
};

/**
 * Saga: one order that spans the Order, Inventory, Payment and Shipping
 * services, each with its own database. The learner picks which step fails and
 * how the saga is coordinated, and watches the compensations undo the steps
 * that had already committed - in reverse order.
 */
export function SagaLab() {
  const [setup, setSetup] = useState<Setup>(DEFAULT_SETUP);
  const [running, setRunning] = useLabRunning();
  const [results, setResults] = useState<RunResult[]>([]);
  const state = useRef<Sim>(createSim(DEFAULT_SETUP, 1));
  const rerender = useRerender(30);
  const { events, log, clear } = useEventLog(60);

  const start = useCallback(
    (next: Setup, number: number) => {
      state.current = createSim(next, number);
      log(
        `Order #${number} placed - ${next.mode === 'orchestration' ? 'orchestrated' : 'choreographed'} saga, ${FAIL_LABEL[next.failAt].toLowerCase()}`,
        'info',
      );
      rerender();
    },
    [log, rerender],
  );

  const change =
    <K extends keyof Setup>(key: K) =>
    (value: Setup[K]) => {
      const next = { ...setup, [key]: value };
      setSetup(next);
      // autoRepeat does not change the saga, so it does not restart the one in flight.
      if (key !== 'autoRepeat') start(next, state.current.number + 1);
    };

  useTicker(running, (dt) => {
    const sim = state.current;
    if (sim.endedFor !== null) {
      sim.endedFor += dt;
      if (setup.autoRepeat && sim.endedFor >= NEXT_ORDER_DELAY) start(setup, sim.number + 1);
      else rerender();
      return;
    }
    if (sim.waitLeft > 0) {
      sim.waitLeft -= dt;
      rerender();
      return;
    }
    const hop = sim.plan[sim.index];
    sim.t += dt * HOP_SPEED;
    if (sim.t >= 1) {
      // A hop inside one service is a local transaction, not a message.
      if (hop.from !== hop.to) sim.messages += 1;
      const note = hop.apply?.(sim.world) ?? hop.note;
      if (note) log(note.text, note.tone ?? 'info');
      sim.index += 1;
      sim.t = 0;
      sim.particleId = nextParticleId();
      if (sim.index >= sim.plan.length) {
        sim.endedFor = 0;
        const net = sim.world.statement.reduce((sum, line) => sum + line.amount, 0);
        const { number, messages, world } = sim;
        const { mode, failAt } = sim.setup;
        const id = nextRowId();
        setResults((list) =>
          [{ id, number, mode, failAt, outcome: world.outcome, messages, net }, ...list].slice(0, 8),
        );
      } else {
        sim.waitLeft = HOP_GAP + (sim.plan[sim.index].wait ?? 0);
      }
    }
    rerender();
  });

  const reset = useCallback(() => {
    setSetup(DEFAULT_SETUP);
    state.current = createSim(DEFAULT_SETUP, 1);
    setResults([]);
    clear();
  }, [clear]);

  const sim = state.current;
  const { world } = sim;
  const orchestrated = sim.setup.mode === 'orchestration';
  const hop = sim.endedFor === null && sim.waitLeft <= 0 ? sim.plan[sim.index] : null;
  const net = world.statement.reduce((sum, line) => sum + line.amount, 0);

  const layout: Layout = orchestrated
    ? Object.fromEntries(Object.entries(LAYOUT).filter(([id]) => id !== 'bus'))
    : LAYOUT;

  const wires: [string, string][] = orchestrated
    ? [
        ['client', 'order'],
        ['order', 'inventory'],
        ['order', 'payment'],
        ['order', 'shipping'],
        ['order', 'review'],
      ]
    : [
        ['client', 'order'],
        ['order', 'bus'],
        ['bus', 'inventory'],
        ['bus', 'payment'],
        ['bus', 'shipping'],
        ['bus', 'review'],
      ];
  const onWire = (a: string, b: string) => hop !== null && ((hop.from === a && hop.to === b) || (hop.from === b && hop.to === a));
  const edges: DiagramEdge[] = wires.map(([from, to]) => {
    const active = onWire(from, to);
    const reviewWire = to === 'review';
    return {
      from,
      to,
      tone: active
        ? hop?.outcome === 'failure'
          ? 'danger'
          : hop?.outcome === 'warning'
            ? 'warn'
            : 'brand'
        : reviewWire && !world.parked
          ? 'muted'
          : 'default',
      dashed: reviewWire && !world.parked,
      animated: active,
      width: active ? 2 : undefined,
    };
  });

  // A hop inside one service (a local transaction with no message) draws no particle.
  const particles: ParticleView[] =
    hop && hop.from !== hop.to ? [{ id: sim.particleId, from: hop.from, to: hop.to, t: sim.t, outcome: hop.outcome }] : [];

  const orderNode: { status: NodeStatus; label: string } =
    world.order === 'APPROVED'
      ? { status: 'healthy', label: 'Approved' }
      : world.order === 'REJECTED'
        ? { status: 'degraded', label: 'Rejected' }
        : world.order === 'NEEDS A HUMAN'
          ? { status: 'down', label: 'Saga stuck' }
          : { status: 'healthy', label: world.order === 'PENDING' ? 'Order pending' : 'Waiting' };

  return (
    <LabShell
      title="Saga Lab"
      description="One order spans four services, each with its own database. Make a later step fail and watch the compensations undo the earlier ones in reverse - run by an orchestrator, or by services reacting to events."
      running={running}
      onRunningChange={setRunning}
      onReset={reset}
      events={events}
      legend={
        <div className="flex flex-wrap items-center justify-between gap-2">
          <ParticleLegend
            outcomes={[
              { outcome: 'success', label: 'Step or reply' },
              { outcome: 'warning', label: 'Compensation' },
              { outcome: 'failure', label: 'Failure or rejection' },
            ]}
          />
          <span className="text-[11px] text-faint">
            {orchestrated
              ? 'Commands out, replies back: the Order service runs the saga.'
              : 'Events through the bus: each service reacts and publishes the next.'}
          </span>
        </div>
      }
      actions={
        <Button variant="primary" onClick={() => start(setup, sim.number + 1)}>
          <ShoppingCart className="h-4 w-4" />
          Place a new order
        </Button>
      }
      insight={<Insight>{insightText()}</Insight>}
      metrics={
        <>
          <MetricsPanel
            title={`Order #${sim.number}`}
            items={[
              {
                key: 'outcome',
                label: 'Saga',
                value: OUTCOME_LABEL[world.outcome],
                tone:
                  world.outcome === 'completed'
                    ? 'ok'
                    : world.outcome === 'compensated'
                      ? 'warn'
                      : world.outcome === 'stuck'
                        ? 'danger'
                        : 'neutral',
                hint: 'Completed: every step committed. Compensated: every committed step was undone. Needs a human: a compensation could not run.',
              },
              {
                key: 'net',
                label: 'Customer net charge',
                value: `${net} euro`,
                tone: net < 0 ? 'danger' : net > 0 && world.outcome !== 'completed' && world.outcome !== 'running' ? 'danger' : 'neutral',
                hint: 'Charges minus refunds on the customer statement. After a compensated saga it should be 0.',
              },
              {
                key: 'reserved',
                label: 'Stock on hold',
                value: world.reserved,
                unit: 'units',
                tone: world.reserved > 0 && world.outcome === 'stuck' ? 'danger' : 'neutral',
                hint: 'Units marked RESERVED by this order (a semantic lock). Other customers cannot buy them meanwhile; a compensated saga must release them.',
              },
              {
                key: 'messages',
                label: 'Messages',
                value: sim.messages,
                hint: 'Commands, replies and events sent so far for this order.',
                simulated: true,
              },
              {
                key: 'where',
                label: 'Workflow written in',
                value: orchestrated ? '1 service' : '4 services',
                hint: orchestrated
                  ? 'The orchestrator in the Order service holds the whole sequence and its compensations.'
                  : 'Each service only knows which events it reacts to. The sequence exists nowhere as one piece of code.',
              },
            ]}
          />

          <div className="card p-4">
            <p className="label mb-3">Saga steps and their compensations</p>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[440px] text-left text-xs">
                <thead className="text-faint">
                  <tr>
                    <th className="py-1 pr-3 font-medium">Step</th>
                    <th className="py-1 pr-3 font-medium">Service</th>
                    <th className="py-1 pr-3 font-medium">Compensation</th>
                    <th className="py-1 font-medium">State</th>
                  </tr>
                </thead>
                <tbody className="text-muted">
                  {STEPS.map((step, index) => (
                    <tr key={step.id} className="border-t border-line">
                      <td className="py-1.5 pr-3 text-ink">
                        {index + 1}. {step.action}
                      </td>
                      <td className="py-1.5 pr-3">{step.service}</td>
                      <td className="py-1.5 pr-3">{step.compensation}</td>
                      <td className={cn('py-1.5 font-mono text-[11px]', STEP_TONE[world.steps[step.id]])}>
                        {world.steps[step.id]}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <div>
                <p className="label mb-2">Customer statement</p>
                {world.statement.length === 0 ? (
                  <p className="text-xs text-faint">No card movements yet.</p>
                ) : (
                  <ul className="space-y-1 font-mono text-[11px]">
                    {world.statement.map((line) => (
                      <li key={line.id} className="flex justify-between gap-3">
                        <span className="text-muted">{line.text}</span>
                        <span className={line.amount < 0 ? 'text-ok' : 'text-ink'}>
                          {line.amount > 0 ? '+' : ''}
                          {line.amount} euro
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                <p className="mt-2 text-[11px] text-faint">
                  A refund does not erase the charge: the customer sees both lines.
                </p>
              </div>
              <div>
                <p className="label mb-2">Runs so far</p>
                {results.length === 0 ? (
                  <p className="text-xs text-faint">Each finished order lands here, so you can compare setups.</p>
                ) : (
                  <ul className="space-y-1 font-mono text-[11px] text-muted">
                    {results.map((row) => (
                      <li key={row.id} className="flex justify-between gap-2">
                        <span>
                          #{row.number} {row.mode === 'orchestration' ? 'orch.' : 'chor.'}, {FAIL_LABEL[row.failAt].toLowerCase()}
                        </span>
                        <span className={row.outcome === 'stuck' || (row.net !== 0 && row.outcome !== 'completed') ? 'text-danger' : 'text-ink'}>
                          {OUTCOME_LABEL[row.outcome]}, {row.messages} msgs, {row.net} euro
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
            <p className="mt-3 text-xs text-faint">
              {SIMULATED_HINT} One saga at a time, messages sent one after another, a{' '}
              {REPLY_TIMEOUT} s timeout, and a {UNITS}-unit, {PRICE} euro order. In choreography the bus delivers
              each event to the service that acts on it next; its other subscribers are not drawn.
            </p>
          </div>
        </>
      }
      controls={
        <>
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted">Coordination</p>
            <SegmentedControl
              size="sm"
              className="w-full"
              value={setup.mode}
              options={[
                { value: 'orchestration', label: 'Orchestration' },
                { value: 'choreography', label: 'Choreography' },
              ]}
              onChange={change('mode')}
            />
            <p className="text-[11px] text-faint">
              Orchestration: one component sends commands and drives compensation. Choreography: services react to
              the events of the others through a bus.
            </p>
          </div>
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted">Which step fails</p>
            <div className="grid grid-cols-2 gap-1.5">
              {(Object.keys(FAIL_LABEL) as FailAt[]).map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={setup.failAt === value}
                  onClick={() => change('failAt')(value)}
                  className={cn(
                    'rounded-lg border px-2 py-1.5 text-left text-xs font-medium transition-colors',
                    setup.failAt === value
                      ? 'border-brand bg-brand/10 text-brand'
                      : 'border-line text-muted hover:border-brand/50 hover:text-ink',
                  )}
                >
                  {FAIL_LABEL[value]}
                </button>
              ))}
            </div>
            <p className="text-[11px] text-faint">
              The later the failure, the more committed steps there are to compensate.
            </p>
          </div>
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted">During the refund</p>
            <SegmentedControl
              size="sm"
              className="w-full"
              value={setup.refundTrouble}
              options={[
                { value: 'none', label: 'All fine' },
                { value: 'reply-lost', label: 'Retried' },
                { value: 'payment-down', label: 'Payment down' },
              ]}
              onChange={change('refundTrouble')}
            />
            <p className="text-[11px] text-faint">
              Only when Shipping fails, since only then is there a charge to refund. Retried: the refund runs, but it is
              delivered a second time. Payment down: every attempt fails.
            </p>
          </div>
          <Toggle
            label="Idempotency key on the refund"
            checked={setup.idempotent}
            onChange={change('idempotent')}
            description="The saga id travels with the refund, so a repeat is recognised and skipped."
          />
          <Toggle
            label="Place orders automatically"
            checked={setup.autoRepeat}
            onChange={change('autoRepeat')}
            description={`A new order ${NEXT_ORDER_DELAY} s after each saga ends.`}
          />
        </>
      }
    >
      <DiagramCanvas layout={layout} edges={edges} particles={particles} width={CANVAS_W} height={CANVAS_H} className="bg-canvas">
        <ArchNode kind="client" title="Customer" subtitle={`#${sim.number}: ${UNITS} units`} placed={layout.client} compact />
        <ArchNode
          kind="service"
          title="Order service"
          subtitle={orchestrated ? 'runs the saga orchestrator' : 'a participant like the rest'}
          placed={layout.order}
          status={orderNode.status}
          statusLabel={orderNode.label}
          alert={hop?.from === 'order' && hop.to === 'order'}
          compact
        >
          <NodeStatRow
            label="Order"
            value={world.order === 'none' ? '-' : world.order}
            tone={world.order === 'APPROVED' ? 'text-ok' : world.order === 'PENDING' ? 'text-ink' : 'text-warn'}
          />
          <NodeStatRow label="Knows the sequence" value={orchestrated ? 'all 4 steps' : 'its own step'} />
        </ArchNode>
        {orchestrated ? null : (
          <ArchNode kind="queue" title="Event bus" subtitle="at-least-once delivery" placed={layout.bus} compact>
            <NodeStatRow label="Events" value={sim.plan.slice(0, sim.index).filter((item) => item.to === 'bus').length} />
          </ArchNode>
        )}
        <ArchNode
          kind="service"
          title="Inventory service"
          subtitle="own database"
          placed={layout.inventory}
          status={world.steps.inventory === 'failed' ? 'degraded' : 'healthy'}
          statusLabel={world.steps.inventory === 'failed' ? 'Out of stock' : undefined}
          alert={hop?.to === 'inventory' && hop.from !== 'inventory'}
          compact
        >
          <NodeStatRow label="Available" value={world.available} />
          <NodeStatRow label="Reserved (pending)" value={world.reserved} tone={world.reserved > 0 ? 'text-warn' : 'text-ink'} />
        </ArchNode>
        <ArchNode
          kind="service"
          title="Payment service"
          subtitle="own database"
          placed={layout.payment}
          status={world.paymentDown ? 'down' : world.steps.payment === 'failed' ? 'degraded' : 'healthy'}
          statusLabel={world.paymentDown ? 'Down' : world.steps.payment === 'failed' ? 'Declined' : undefined}
          alert={hop?.to === 'payment'}
          compact
        >
          <NodeStatRow label="Charged" value={`${world.statement.filter((line) => line.amount > 0).length * PRICE} euro`} />
          <NodeStatRow
            label="Refunded"
            value={`${world.statement.filter((line) => line.amount < 0).length * PRICE} euro`}
            tone={net < 0 ? 'text-danger' : 'text-ink'}
          />
        </ArchNode>
        <ArchNode
          kind="service"
          title="Shipping service"
          subtitle="own database"
          placed={layout.shipping}
          status={world.shipment === 'rejected' ? 'degraded' : 'healthy'}
          statusLabel={world.shipment === 'rejected' ? 'Address rejected' : undefined}
          alert={hop?.to === 'shipping'}
          compact
        >
          <NodeStatRow label="Shipment" value={world.shipment} />
        </ArchNode>
        <ArchNode
          kind="monitoring"
          title="Manual review"
          subtitle={orchestrated ? 'parked sagas' : 'dead-letter queue'}
          placed={layout.review}
          status={world.parked ? 'down' : 'healthy'}
          statusLabel={world.parked ? 'Needs a human' : 'Empty'}
          alert={world.parked}
          compact
        >
          <NodeStatRow label="Waiting" value={world.parked ? 1 : 0} tone={world.parked ? 'text-danger' : 'text-ink'} />
        </ArchNode>
      </DiagramCanvas>
    </LabShell>
  );

  function insightText() {
    const { mode, failAt, refundTrouble, idempotent } = sim.setup;
    if (world.outcome === 'stuck') {
      return mode === 'orchestration'
        ? `Compensations fail too. The refund failed ${MAX_ATTEMPTS} times, so the orchestrator parked the saga for a human: the customer is still charged ${PRICE} euro and ${UNITS} units stay reserved until someone acts. Somebody has to watch that queue.`
        : `Compensations fail too - and in choreography nobody owns the whole saga. The ShippingFailed event went to a dead-letter queue, the customer is still charged, and the Order service still shows PENDING because no event ever told it otherwise.`;
    }
    if (world.outcome === 'compensated' && net < 0) {
      return `The refund ran twice because nothing recognised the repeat, so the customer is ${-net} euro up. Retries are guaranteed in a saga, so every compensation must be idempotent - turn the idempotency key back on and run it again.`;
    }
    if (world.outcome === 'compensated') {
      if (failAt === 'inventory')
        return 'Inventory failed at step 2, so only step 1 had committed: the only compensation is rejecting the order. Make a later step fail and count how many compensations it takes.';
      if (failAt === 'payment')
        return 'Payment failed at step 3, so steps 2 and 1 were compensated in reverse: release the stock, then reject the order. There was no charge, so there is nothing to refund.';
      return `Shipping failed at step 4, so steps 3, 2 and 1 were compensated in reverse. Look at the statement: a charge and a refund, both visible to the customer. Compensation is a new transaction, not an erasure.${
        refundTrouble === 'reply-lost' && idempotent ? ' The refund arrived twice, and the idempotency key made the second one do nothing.' : ''
      }`;
    }
    if (world.outcome === 'completed') {
      return `Every step committed, so nothing needed undoing - ${sim.messages} messages for one order. Now make Shipping fail and watch the compensations run.`;
    }
    if (failAt === 'none') {
      return 'Nothing fails in this run. Watch the order go PENDING first and APPROVED only at the end - in between, other requests can see the order and the reserved stock half-finished.';
    }
    return mode === 'orchestration'
      ? 'The Order service is the orchestrator: every command goes out from it and every reply comes back to it, so the whole sequence - and its compensations - is written in one place.'
      : 'No one runs this saga. Each service reacts to an event on the bus and publishes the next one, so the sequence is spread across four services. Compare the message count with orchestration.';
  }
}

export default SagaLab;
