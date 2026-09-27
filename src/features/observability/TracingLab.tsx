import { useCallback, useMemo, useRef, useState } from 'react';
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
import { Badge, Slider, Toggle } from '@/components/ui';
import { useRerender } from '@/hooks/useRerender';
import { nextParticleId, useEventLog, useTicker } from '@/simulations/engine';
import type { NodeKind, RequestOutcome } from '@/types';
import { cn } from '@/utils/cn';
import { formatLatency, formatNumber } from '@/utils/format';
import { useLabRunning } from '@/hooks/useLabRunning';

/** The parts of the diagram. Every span belongs to exactly one of them. */
type NodeId =
  | 'users'
  | 'gateway'
  | 'order'
  | 'redis'
  | 'inventory'
  | 'payment'
  | 'postgres'
  | 'kafka'
  | 'notification';

type SpanKind = 'gateway' | 'service' | 'db' | 'cache' | 'queue';

interface SpanSpec {
  id: string;
  /** Id of the span that made this call; absent for the root span. */
  parent?: string;
  /** Low-cardinality name: the route template or operation, never a raw id. */
  name: string;
  /** The part the span is about - what the "Components" metric counts. */
  component: string;
  /** Where the span sits on the diagram. */
  node: NodeId;
  /** The wire this span travels: from the part that made the call to `node`. */
  hop: [NodeId, NodeId];
  /** Own work, excluding children. */
  selfMs: number;
  kind: SpanKind;
  /** The 16-hex span id, sent onward as the parent-id of the next traceparent. */
  spanId: string;
  attributes: Record<string, string>;
}

interface Span extends SpanSpec {
  depth: number;
  startMs: number;
  /** Duration including every child span, as a tracing UI shows it. */
  totalMs: number;
}

/**
 * Colour is only the span kind - it never means status. Green, amber and red are
 * kept out, so a service span does not read as healthy or a queue span as a
 * warning; the kind is also named in the span detail badge.
 */
const KIND_TONE = {
  gateway: 'bg-brand',
  service: 'bg-muted',
  db: 'bg-info',
  cache: 'bg-violet',
  queue: 'bg-faint',
} as const;

/** W3C Trace Context: a 32-hex trace-id shared by every span of the request. */
const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
/** The trace-id the consumer invents when no context arrives with the message. */
const ORPHAN_TRACE_ID = '7d3e9a1c5b8f2046e1a7c3d9b5f02468';

/** Illustrative cost of sending the notification (an email provider call). */
const SYNC_NOTIFY_MS = 150;
/** Illustrative time the message waits in Kafka before the consumer picks it up. */
const QUEUE_WAIT_MS = 40;

interface Setup {
  gatewayMs: number;
  orderMs: number;
  inventoryMs: number;
  paymentMs: number;
  dbMs: number;
  cacheHit: boolean;
  asyncNotify: boolean;
  /** Inject the trace context into the Kafka message headers. */
  propagate: boolean;
}

const START: Setup = {
  gatewayMs: 18,
  orderMs: 35,
  inventoryMs: 30,
  paymentMs: 120,
  dbMs: 25,
  cacheHit: true,
  asyncNotify: true,
  propagate: true,
};

/**
 * Teaching simplification: a span does its own work first, then calls its
 * children one after another (no parallel calls). A parent span therefore lasts
 * its own time plus all of its children, and the self times of every span on the
 * request path add up exactly to the root duration.
 */
function layoutSpans(specs: SpanSpec[]): Span[] {
  const place = (spec: SpanSpec, startMs: number, depth: number): Span[] => {
    let cursor = startMs + spec.selfMs;
    const descendants: Span[] = [];
    for (const child of specs.filter((item) => item.parent === spec.id)) {
      const placed = place(child, cursor, depth + 1);
      descendants.push(...placed);
      cursor = placed[0].startMs + placed[0].totalMs;
    }
    return [{ ...spec, depth, startMs, totalMs: cursor - startMs }, ...descendants];
  };
  const root = specs.find((spec) => spec.parent === undefined);
  return root ? place(root, 0, 0) : [];
}

/** The spans of one request, on the request path (the response waits for all of them). */
function requestSpecs(setup: Setup): SpanSpec[] {
  const { cacheHit, asyncNotify, propagate } = setup;
  return [
    {
      id: 'gateway',
      name: 'POST /api/orders',
      component: 'api-gateway',
      node: 'gateway',
      hop: ['users', 'gateway'],
      selfMs: setup.gatewayMs,
      kind: 'gateway',
      spanId: '00f067aa0ba902b7',
      attributes: { 'http.request.method': 'POST', 'http.route': '/api/orders', 'user.id': 'user_42' },
    },
    {
      id: 'order',
      parent: 'gateway',
      name: 'order-service create order',
      component: 'order-service',
      node: 'order',
      hop: ['gateway', 'order'],
      selfMs: setup.orderMs,
      kind: 'service',
      spanId: '53995c3f42cd8ad8',
      attributes: { 'service.version': '2.14.0', 'order.id': 'ord_8812' },
    },
    {
      id: 'cache',
      parent: 'order',
      name: `redis GET cart (${cacheHit ? 'HIT' : 'MISS'})`,
      component: 'redis',
      node: 'redis',
      hop: ['order', 'redis'],
      selfMs: cacheHit ? 3 : 5,
      kind: 'cache',
      spanId: '1f0e6b2a9c4d7e38',
      attributes: { 'db.system': 'redis', 'cache.hit': String(cacheHit) },
    },
    ...(cacheHit
      ? []
      : [
          {
            id: 'db',
            parent: 'order',
            name: 'postgres SELECT cart_items',
            component: 'postgres',
            node: 'postgres' as const,
            hop: ['order', 'postgres'] as [NodeId, NodeId],
            selfMs: setup.dbMs,
            kind: 'db' as const,
            spanId: '6e0c63257de34c92',
            attributes: { 'db.system': 'postgresql', 'db.query.text': 'SELECT * FROM cart_items WHERE user_id = $1' },
          },
        ]),
    {
      id: 'inventory',
      parent: 'order',
      name: 'inventory-service reserve',
      component: 'inventory-service',
      node: 'inventory',
      hop: ['order', 'inventory'],
      selfMs: setup.inventoryMs,
      kind: 'service',
      spanId: 'b7ad6b7169203331',
      attributes: { 'inventory.items': '3' },
    },
    {
      id: 'inventory-db',
      parent: 'inventory',
      name: 'postgres UPDATE stock',
      component: 'postgres',
      node: 'postgres',
      hop: ['inventory', 'postgres'],
      selfMs: setup.dbMs,
      kind: 'db',
      spanId: '2c8d1e5f7a9b3c4d',
      attributes: { 'db.system': 'postgresql', 'db.operation.name': 'UPDATE' },
    },
    {
      id: 'payment',
      parent: 'order',
      name: 'payment-service authorize',
      component: 'payment-service',
      node: 'payment',
      hop: ['order', 'payment'],
      selfMs: setup.paymentMs,
      kind: 'service',
      spanId: 'c2fb3b3e1d8a6f40',
      attributes: { 'payment.provider': 'card processor', 'retry.count': '0' },
    },
    {
      id: 'payment-db',
      parent: 'payment',
      name: 'postgres INSERT payments',
      component: 'postgres',
      node: 'postgres',
      hop: ['payment', 'postgres'],
      selfMs: setup.dbMs,
      kind: 'db',
      spanId: '8a3f9e2d1c7b6a50',
      attributes: { 'db.system': 'postgresql', 'db.operation.name': 'INSERT' },
    },
    // Async: publish an event and move on - the notification is sent later, off
    // the request path. Sync: the order service waits for the notification
    // service to send it, and the user waits too.
    asyncNotify
      ? {
          id: 'queue',
          parent: 'order',
          name: 'kafka publish order.created',
          component: 'kafka',
          node: 'kafka',
          hop: ['order', 'kafka'],
          selfMs: 4,
          kind: 'queue',
          spanId: 'e457b5a2e4d86bd1',
          attributes: {
            'messaging.system': 'kafka',
            'messaging.destination.name': 'order.created',
            'context injected': propagate ? 'yes, in message headers' : 'no',
          },
        }
      : {
          id: 'notify',
          parent: 'order',
          name: 'notification-service send',
          component: 'notification-service',
          node: 'notification',
          hop: ['order', 'notification'],
          selfMs: SYNC_NOTIFY_MS,
          kind: 'service',
          spanId: '9d1a4c7e2b5f8036',
          attributes: { 'notification.channel': 'email' },
        },
  ];
}

/**
 * The Kafka consumer, after the response has gone back. With the context in the
 * message headers it continues the trace as a child of the publish span (OpenTelemetry
 * allows that for one message; many setups use a span link instead). Without it,
 * the consumer starts a new trace that nothing connects to this one.
 */
function consumerSpan(publish: Span): Span {
  return {
    id: 'consumer',
    parent: 'queue',
    name: 'notification-service process order.created',
    component: 'notification-service',
    node: 'notification',
    hop: ['kafka', 'notification'],
    selfMs: SYNC_NOTIFY_MS,
    kind: 'service',
    spanId: '4f6b2e8d1a9c3570',
    attributes: { 'messaging.operation.type': 'process', 'notification.channel': 'email' },
    depth: publish.depth + 1,
    startMs: publish.startMs + publish.totalMs + QUEUE_WAIT_MS,
    totalMs: SYNC_NOTIFY_MS,
  };
}

/** How the trace context reached this span - the part of tracing that breaks in real systems. */
function carrierOf(span: Span, byId: Map<string, Span>, propagate: boolean): string {
  const parent = span.parent ? byId.get(span.parent) : undefined;
  if (!parent) return 'No traceparent came in, so the gateway starts the trace and creates the trace_id.';
  if (span.kind === 'db' || span.kind === 'cache')
    return `A client span, recorded by the database driver inside ${parent.component}. No header goes to ${span.component}.`;
  if (span.id === 'queue')
    return propagate
      ? 'A producer span in order-service. It injects its context into the Kafka message headers.'
      : 'A producer span in order-service. Nothing is injected, so the message carries no trace context.';
  if (span.id === 'consumer') return `Extracted from the Kafka message headers: 00-${TRACE_ID}-${parent.spanId}-01`;
  return `HTTP header traceparent: 00-${TRACE_ID}-${parent.spanId}-01`;
}

// ---- Diagram ---------------------------------------------------------------

const LAYOUT: Layout = {
  // As tall as its subtitle and stat row make it, like the rest of the row.
  users: { x: 20, y: 140, w: 120, h: 94 },
  gateway: { x: 175, y: 140, w: 160, h: 94 },
  order: { x: 380, y: 140, w: 170, h: 94 },
  redis: { x: 380, y: 10, w: 170, h: 94 },
  inventory: { x: 610, y: 10, w: 170, h: 94 },
  payment: { x: 610, y: 270, w: 170, h: 94 },
  postgres: { x: 810, y: 140, w: 140, h: 94 },
  kafka: { x: 150, y: 330, w: 170, h: 94 },
  notification: { x: 380, y: 330, w: 190, h: 94 },
};
const CANVAS_HEIGHT = 440;

const NODE_INFO: Record<NodeId, { kind: NodeKind; title: string; subtitle: string }> = {
  users: { kind: 'client', title: 'Users', subtitle: 'checkout' },
  gateway: { kind: 'api-gateway', title: 'Gateway', subtitle: 'starts the trace' },
  order: { kind: 'service', title: 'Order', subtitle: 'order-service' },
  redis: { kind: 'cache', title: 'Redis', subtitle: 'cart cache' },
  inventory: { kind: 'service', title: 'Inventory', subtitle: 'inventory-service' },
  payment: { kind: 'service', title: 'Payment', subtitle: 'calls card processor' },
  postgres: { kind: 'sql', title: 'Postgres', subtitle: 'orders, stock' },
  kafka: { kind: 'queue', title: 'Kafka', subtitle: 'order.created' },
  notification: { kind: 'service', title: 'Notification', subtitle: 'sends the email' },
};

/**
 * Simplified animation, not to scale: a dot crosses a call wire slower when the
 * span it opens has a longer self time, so a slow hop is visibly slow. Replies
 * travel back at one fixed speed.
 */
const callSeconds = (selfMs: number) => Math.min(4, 0.3 + (selfMs / 1000) * 2.2);
const REPLY_SECONDS = 0.25;
/** Real seconds between two requests entering the diagram. */
const REQUEST_EVERY_S = 1.4;

interface Leg {
  from: NodeId;
  to: NodeId;
  seconds: number;
}

interface Dot {
  id: number;
  legs: Leg[];
  leg: number;
  t: number;
  outcome: RequestOutcome;
}

interface SimState {
  dots: Dot[];
  sinceSpawn: number;
}

/** The legs one request walks: out along each call, then back, in waterfall order. */
function routeOf(spans: Span[]): Leg[] {
  const legs: Leg[] = [];
  const walk = (span: Span) => {
    legs.push({ from: span.hop[0], to: span.hop[1], seconds: callSeconds(span.selfMs) });
    for (const child of spans.filter((item) => item.parent === span.id)) walk(child);
    legs.push({ from: span.hop[1], to: span.hop[0], seconds: REPLY_SECONDS });
  };
  if (spans[0]) walk(spans[0]);
  return legs;
}

export function TracingLab() {
  // Every control lives in one object, so Reset cannot miss one.
  const [setup, setSetup] = useState<Setup>(START);
  const change =
    <K extends keyof Setup>(key: K) =>
    (value: Setup[K]) =>
      setSetup((current) => ({ ...current, [key]: value }));
  const [selected, setSelected] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [running, setRunning] = useLabRunning();
  const state = useRef<SimState>({ dots: [], sinceSpawn: REQUEST_EVERY_S });
  const rerender = useRerender(30);
  const { events, log, clear } = useEventLog();

  const spans = useMemo(() => layoutSpans(requestSpecs(setup)), [setup]);
  const byId = useMemo(() => new Map(spans.map((span) => [span.id, span])), [spans]);
  const publish = byId.get('queue');
  const consumer = publish ? consumerSpan(publish) : null;
  // The consumer is in this trace only when the context crossed the broker.
  const traced = consumer && setup.propagate ? [...spans, consumer] : spans;
  const route = useMemo(() => routeOf(spans), [spans]);

  const root = spans[0];
  const responseMs = root.totalMs;
  const traceEndMs = Math.max(responseMs, ...traced.map((span) => span.startMs + span.totalMs));
  // Slowest by self time on the request path: the span whose own work costs the
  // user the most, not a parent that is long only because it waits on its children,
  // and not the consumer, which runs after the response.
  const slowest = spans.slice(1).reduce((worst, span) => (span.selfMs > worst.selfMs ? span : worst), spans[1]);
  const allSpans = consumer ? [...spans, consumer] : spans;
  const active = allSpans.find((span) => span.id === selected) ?? null;
  const litId = hovered ?? selected;
  const lit = allSpans.find((span) => span.id === litId) ?? null;

  const reset = useCallback(() => {
    setSetup(START);
    setSelected(null);
    setHovered(null);
    state.current = { dots: [], sinceSpawn: REQUEST_EVERY_S };
    clear();
  }, [clear]);

  const toggle = (key: 'cacheHit' | 'asyncNotify' | 'propagate', value: boolean) => {
    change(key)(value);
    if (key === 'propagate')
      log(
        value
          ? 'Context injected into the message: the consumer span joins the trace'
          : 'Context not injected: the consumer starts a new trace_id - this trace ends at the publish',
        value ? 'ok' : 'warn',
      );
    else if (key === 'asyncNotify')
      log(value ? 'Notification moved off the request path (Kafka)' : `Notification called in the request: +${SYNC_NOTIFY_MS} ms`, value ? 'ok' : 'warn');
    else log(value ? 'Cache hit: the Postgres read disappears from the trace' : 'Cache miss: a Postgres span appears under order-service', 'info');
  };

  useTicker(running, (dt) => {
    const sim = state.current;
    sim.sinceSpawn += dt;
    if (sim.sinceSpawn >= REQUEST_EVERY_S) {
      sim.sinceSpawn = 0;
      sim.dots.push({ id: nextParticleId(), legs: route, leg: 0, t: 0, outcome: 'success' });
    }
    const next: Dot[] = [];
    for (const dot of sim.dots) {
      dot.t += dt / dot.legs[dot.leg].seconds;
      while (dot.t >= 1) {
        const done = dot.legs[dot.leg];
        // The publish reaches Kafka: the message goes on to the consumer on its
        // own, whether or not it carries the trace context.
        if (done.from === 'order' && done.to === 'kafka' && setup.asyncNotify)
          next.push({
            id: nextParticleId(),
            legs: [{ from: 'kafka', to: 'notification', seconds: callSeconds(SYNC_NOTIFY_MS) }],
            leg: 0,
            t: 0,
            outcome: setup.propagate ? 'success' : 'warning',
          });
        dot.t -= 1;
        dot.leg += 1;
        if (dot.leg >= dot.legs.length) break;
      }
      if (dot.leg < dot.legs.length) next.push(dot);
    }
    sim.dots = next.slice(-80);
    rerender();
  });

  const onHop = (from: string, to: string) =>
    lit !== null && ((lit.hop[0] === from && lit.hop[1] === to) || (lit.hop[0] === to && lit.hop[1] === from));

  const particles: ParticleView[] = state.current.dots.map((dot) => {
    const leg = dot.legs[dot.leg];
    return { id: dot.id, from: leg.from, to: leg.to, t: dot.t, outcome: dot.outcome, highlighted: onHop(leg.from, leg.to) };
  });

  const used = new Set(spans.map((span) => `${span.hop[0]}->${span.hop[1]}`));
  if (setup.asyncNotify) used.add('kafka->notification');
  const edge = (from: NodeId, to: NodeId, extra: Partial<DiagramEdge> = {}): DiagramEdge => {
    const inUse = used.has(`${from}->${to}`);
    const isLit = onHop(from, to);
    return {
      from,
      to,
      tone: isLit ? 'brand' : 'default',
      width: isLit ? 3 : undefined,
      animated: isLit,
      // A wire this request does not travel stays in the picture: the part still exists.
      dashed: !inUse,
      faded: !inUse,
      ...extra,
    };
  };
  const contextLost = setup.asyncNotify && !setup.propagate;
  const edges: DiagramEdge[] = [
    edge('users', 'gateway'),
    edge('gateway', 'order'),
    edge('order', 'redis'),
    edge('order', 'postgres'),
    edge('order', 'inventory'),
    edge('inventory', 'postgres'),
    edge('order', 'payment'),
    edge('payment', 'postgres'),
    edge('order', 'kafka'),
    edge('order', 'notification'),
    edge('kafka', 'notification', contextLost && !onHop('kafka', 'notification') ? { tone: 'warn', dashed: true } : {}),
  ];

  const selfOn = (node: NodeId) => traced.filter((span) => span.node === node);
  const selectNode = (node: NodeId) => {
    const first = allSpans.find((span) => span.node === node);
    if (first) setSelected(first.id === selected ? null : first.id);
  };
  const statFor = (node: NodeId) => {
    if (node === 'users') return { label: 'Waits', value: formatLatency(responseMs) };
    const own = selfOn(node);
    if (node === 'notification' && setup.asyncNotify && !setup.propagate) return { label: 'Trace', value: 'separate' };
    if (own.length === 0) return { label: 'Spans', value: 'none' };
    const self = own.reduce((sum, span) => sum + span.selfMs, 0);
    if (own.length > 1) return { label: `${own.length} spans`, value: formatLatency(self) };
    return { label: 'Self', value: formatLatency(self) };
  };

  const insight = contextLost ? (
    <>
      The publish span is the last thing this trace shows. The consumer still sends the email, but it started a new
      trace_id <span className="font-mono">{ORPHAN_TRACE_ID.slice(0, 8)}...</span> that nothing links back to this order -
      if emails arrive late, no trace shows where the time went. Turn context propagation back on.
    </>
  ) : (
    <>
      The user waits {formatLatency(responseMs)}, and <strong className="text-ink">{slowest.name}</strong> accounts for{' '}
      {formatLatency(slowest.selfMs)} of its own work - about {Math.round((slowest.selfMs / responseMs) * 100)}% of the
      response time. Without a trace, &quot;checkout is slow&quot; is a guess; with one it is a single row on the waterfall
      and a single wire on the diagram. Metrics tell you that something is slow, traces tell you which hop.
    </>
  );

  return (
    <LabShell
      title="Distributed Tracing Lab"
      description="One checkout request crosses five services, a cache, a database and a broker. Every hop records a span under the same trace_id. Point at a span in the waterfall to light up its hop, and change a latency to see which span owns the total."
      running={running}
      onRunningChange={setRunning}
      onReset={reset}
      events={events}
      legend={
        <div className="space-y-1.5">
          <ParticleLegend
            outcomes={
              contextLost ? ['success', { outcome: 'warning', label: 'Message without trace context' }] : ['success']
            }
          />
          <p className="text-[11px] text-faint">
            A dot is one request walking its trace: out along each call, back along each reply. A triangle from Kafka is a
            message that carries no trace context. Dashed, faded wires are parts this request does not touch. Simplified: a
            dot moves slower on a hop whose span is slower, not to scale.
          </p>
        </div>
      }
      insight={<Insight>{insight}</Insight>}
      metrics={
        <>
          <MetricsPanel
            items={[
              {
                key: 'total',
                label: 'Response time',
                value: formatLatency(responseMs),
                tone: responseMs > 300 ? 'warn' : 'ok',
                hint: 'Duration of the root span: what the user waits for.',
                simulated: true,
              },
              { key: 'spans', label: 'Spans', value: traced.length, hint: 'Operations recorded under this trace_id.' },
              {
                key: 'components',
                label: 'Components',
                value: new Set(traced.map((span) => span.component)).size,
                hint: 'Distinct parts (gateway, services, stores, broker) this trace reaches.',
              },
              {
                key: 'slowest',
                label: 'Slowest span (self)',
                value: formatLatency(slowest.selfMs),
                tone: 'danger',
                hint: 'The hop on the request path whose own work dominates - time spent waiting on children is not counted.',
                simulated: true,
              },
              {
                key: 'depth',
                label: 'Max depth',
                value: Math.max(...traced.map((span) => span.depth)) + 1,
                hint: 'How deep the call tree goes.',
              },
            ]}
          />

          {active ? (
            <div className="card p-4">
              <div className="flex items-center justify-between">
                <p className="label">Span detail</p>
                <Badge tone="brand">{active.kind}</Badge>
              </div>
              <p className="mt-2 font-mono text-sm text-ink">{active.name}</p>
              <dl className="mt-3 grid gap-x-6 gap-y-1.5 font-mono text-[11px] sm:grid-cols-2">
                <div className="flex justify-between gap-4">
                  <dt className="text-faint">span id</dt>
                  <dd className="text-ink">{active.spanId}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-faint">parent span id</dt>
                  <dd className="text-ink">{active.parent ? byId.get(active.parent)?.spanId : 'none (root)'}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-faint">duration</dt>
                  <dd className="text-ink">{formatLatency(active.totalMs)}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-faint">self time</dt>
                  <dd className="text-ink">{formatLatency(active.selfMs)}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-faint">start offset</dt>
                  <dd className="text-ink">+{formatLatency(active.startMs)}</dd>
                </div>
                {Object.entries(active.attributes).map(([key, value]) => (
                  <div key={key} className="flex justify-between gap-4">
                    <dt className="text-faint">{key}</dt>
                    <dd className="truncate text-muted">{value}</dd>
                  </div>
                ))}
              </dl>
              <p className="mt-3 break-all font-mono text-[11px] leading-relaxed text-muted">
                <span className="text-faint">context in: </span>
                {active.id === 'consumer' && !setup.propagate
                  ? `No traceparent in the message headers, so this span starts a new trace: ${ORPHAN_TRACE_ID}.`
                  : carrierOf(active, byId, setup.propagate)}
              </p>
            </div>
          ) : null}

          <div className="card p-4">
            <p className="label mb-3">Logs, metrics and traces</p>
            <ul className="grid gap-4 sm:grid-cols-3">
              {[
                {
                  title: 'Logs',
                  body: 'Discrete events with context. Answer "what exactly happened to this request?" - only if every line carries the trace_id.',
                },
                {
                  title: 'Metrics',
                  body: 'Cheap aggregates over time. Answer "is something wrong right now?" and drive alerts.',
                },
                {
                  title: 'Traces',
                  body: 'One request across services. Answer "where did the time go?" - this waterfall.',
                },
              ].map((item) => (
                <li key={item.title}>
                  <p className="text-xs font-semibold text-ink">{item.title}</p>
                  <p className="mt-1 text-[11px] leading-relaxed text-muted">{item.body}</p>
                </li>
              ))}
            </ul>
          </div>
        </>
      }
      controls={
        <>
          <Slider label="API Gateway" value={setup.gatewayMs} min={2} max={200} onChange={change('gatewayMs')} format={(value) => `${value} ms`} />
          <Slider label="Order service" value={setup.orderMs} min={5} max={400} onChange={change('orderMs')} format={(value) => `${value} ms`} />
          <Slider
            label="Inventory service"
            value={setup.inventoryMs}
            min={5}
            max={400}
            onChange={change('inventoryMs')}
            format={(value) => `${value} ms`}
          />
          <Slider
            label="Payment service"
            value={setup.paymentMs}
            min={5}
            max={2000}
            step={5}
            onChange={change('paymentMs')}
            format={(value) => `${value} ms`}
            tone={setup.paymentMs > 500 ? 'danger' : 'brand'}
            hint="It waits on a card processor outside your system. Usually the first thing a trace exposes."
          />
          <Slider
            label="Database query"
            value={setup.dbMs}
            min={1}
            max={500}
            onChange={change('dbMs')}
            format={(value) => `${value} ms`}
            hint="Applies to every Postgres query in the request."
          />
          <Toggle
            label="Cache hit"
            checked={setup.cacheHit}
            onChange={(value) => toggle('cacheHit', value)}
            description="Off: the cart is read from Postgres instead"
          />
          <Toggle
            label="Async notification"
            checked={setup.asyncNotify}
            onChange={(value) => toggle('asyncNotify', value)}
            description={`On: publish to Kafka and return. Off: call the notification service in the request (~${SYNC_NOTIFY_MS} ms on the request path)`}
          />
          <Toggle
            label="Inject context into the message"
            checked={setup.propagate}
            disabled={!setup.asyncNotify}
            onChange={(value) => toggle('propagate', value)}
            description="Off: the producer does not copy traceparent into the Kafka headers"
          />
          <p className="font-mono text-[11px] leading-relaxed text-muted">
            <span className="break-all">traceparent: 00-{TRACE_ID}-{(active ?? root).spanId}-01</span>
            <span className="mt-1 block text-faint">
              version - trace_id - parent span id - flags (01 = sampled). Each service sends its own span id onward, so
              only the middle part changes from hop to hop.
            </span>
          </p>
        </>
      }
    >
      <DiagramCanvas layout={LAYOUT} edges={edges} particles={particles} height={CANVAS_HEIGHT} className="bg-canvas">
        {(Object.keys(NODE_INFO) as NodeId[]).map((node) => {
          const info = NODE_INFO[node];
          const stat = statFor(node);
          const isSlowest = slowest.node === node && node !== 'users';
          const orphan = node === 'notification' && contextLost;
          return (
            <ArchNode
              key={node}
              kind={info.kind}
              title={info.title}
              subtitle={info.subtitle}
              placed={LAYOUT[node]}
              selected={lit?.node === node}
              alert={isSlowest}
              status={orphan ? 'degraded' : 'healthy'}
              statusLabel={orphan ? 'Not in this trace' : undefined}
              onClick={node === 'users' ? undefined : () => selectNode(node)}
              compact
            >
              <NodeStatRow label={stat.label} value={stat.value} tone={isSlowest ? 'text-danger' : 'text-ink'} />
            </ArchNode>
          );
        })}
      </DiagramCanvas>

      <div className="border-t border-line p-5">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <p className="break-all font-mono text-xs text-muted">trace_id {TRACE_ID}</p>
          <p className="font-mono text-xs text-ink">{formatLatency(responseMs)} response</p>
        </div>
        <div className="space-y-1.5" onMouseLeave={() => setHovered(null)}>
          {traced.map((span) => (
            <SpanRow
              key={span.id}
              span={span}
              endMs={traceEndMs}
              selected={selected === span.id}
              lit={litId === span.id}
              onPick={() => setSelected(span.id === selected ? null : span.id)}
              onHover={(on) => setHovered(on ? span.id : null)}
            />
          ))}
          {consumer && !setup.propagate ? (
            <button
              type="button"
              onClick={() => setSelected(selected === 'consumer' ? null : 'consumer')}
              onMouseEnter={() => setHovered('consumer')}
              onFocus={() => setHovered('consumer')}
              onBlur={() => setHovered(null)}
              className={cn(
                'flex w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-dashed border-warn/60 px-2 py-1.5 text-left',
                litId === 'consumer' ? 'bg-elevated' : 'hover:bg-elevated',
              )}
            >
              <span className="font-mono text-[11px] text-warn">notification-service process order.created</span>
              <span className="text-[11px] text-muted">
                is in another trace ({ORPHAN_TRACE_ID.slice(0, 8)}...), so it is missing here.
              </span>
            </button>
          ) : null}
        </div>
        <p className="mt-4 font-mono text-[11px] text-muted">
          Self times on the request path add up to the response: {spans.map((span) => formatNumber(span.selfMs)).join(' + ')} ={' '}
          {formatNumber(responseMs)} ms. A parent bar spans its children, so its duration includes their time.
          {consumer && setup.propagate
            ? ` The consumer span starts ${formatNumber(QUEUE_WAIT_MS)} ms after the publish, once the response has gone back, so the trace outlasts the response.`
            : ''}
        </p>
        <p className="mt-2 text-xs text-faint">
          Simplified: every call here runs one after another and the timings are illustrative. Real services often call in
          parallel, and then children overlap. Point at or click a span to light up its hop and read its attributes. Only a
          sample of traces is usually kept - tail-based sampling keeps the slow and failed ones, which are the traces you
          wanted.
        </p>
      </div>
    </LabShell>
  );
}

function SpanRow({
  span,
  endMs,
  selected,
  lit,
  onPick,
  onHover,
}: {
  span: Span;
  endMs: number;
  selected: boolean;
  lit: boolean;
  onPick: () => void;
  onHover: (on: boolean) => void;
}) {
  // Keep tiny spans visible (1.5% minimum) without pushing the bar past
  // the right edge - a span at the very end is nudged left instead.
  const width = Math.max(1.5, (span.totalMs / endMs) * 100);
  const offset = Math.min((span.startMs / endMs) * 100, 100 - width);
  return (
    <button
      type="button"
      onClick={onPick}
      onMouseEnter={() => onHover(true)}
      onFocus={() => onHover(true)}
      onBlur={() => onHover(false)}
      aria-pressed={selected}
      className={cn(
        // On a phone the name takes its own line; side by side it would leave the bar 0px wide.
        'flex w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-lg px-2 py-1.5 text-left transition-colors sm:flex-nowrap',
        selected || lit ? 'bg-elevated' : 'hover:bg-elevated',
        selected && 'ring-1 ring-brand/60',
      )}
    >
      <span
        className={cn('w-full shrink-0 truncate font-mono text-[11px] sm:w-64', lit ? 'text-ink' : 'text-muted')}
        title={span.name}
        style={{ paddingLeft: span.depth * 12 }}
      >
        {span.name}
      </span>
      <span className="relative h-4 min-w-0 flex-1 overflow-hidden rounded bg-line/40" aria-hidden>
        <span className={cn('absolute inset-y-0 rounded', KIND_TONE[span.kind])} style={{ left: `${offset}%`, width: `${width}%` }} />
      </span>
      <span className="w-16 shrink-0 text-right font-mono text-[11px] text-ink">{formatLatency(span.totalMs)}</span>
    </button>
  );
}

export default TracingLab;
