import { useMemo, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
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
import { advanceParticles, nextParticleId, useTicker, type Particle } from '@/simulations/engine';
import { useRerender } from '@/hooks/useRerender';
import { cn } from '@/utils/cn';
import { clamp } from '@/utils/math';
import { formatBytes, formatLatency, formatPercent } from '@/utils/format';
import type { LabFocus, LabProps } from '@/types';
import {
  CALLERS,
  DB_MS,
  ITEMS_PER_ORDER,
  PROTO_RATIO,
  overFetched,
  planFor,
  type Caller,
  type Plan,
  type RestShape,
  type RpcDesign,
  type Setup,
  type Style,
} from './apiStylesModel';
import { useLabRunning } from '@/hooks/useLabRunning';

const STYLES: { value: Style; label: string }[] = [
  { value: 'rest', label: 'REST' },
  { value: 'graphql', label: 'GraphQL' },
  { value: 'grpc', label: 'gRPC' },
];

const STYLE_WIRE: Record<Style, string> = {
  rest: 'HTTP GET + JSON',
  graphql: 'HTTP POST + JSON',
  grpc: 'HTTP/2 + protobuf',
};

/** What the lab opens on at /labs/api-styles, with no Lab focus. */
const DEFAULT_SETUP: Setup = {
  style: 'rest',
  caller: 'mobile',
  rttMs: CALLERS.mobile.rttMs,
  orders: 3,
  restShape: 'per-resource',
  sparseFields: false,
  batching: true,
  rpcDesign: 'per-resource',
};

/**
 * The Lab focus of each Concept that hosts this lab. REST opens on one call per
 * resource from a mobile app, so the three round trips and the over-fetched bytes
 * are the first thing on screen. GraphQL opens on the same screen in one query.
 * gRPC opens between two services in one data centre, on the same resource calls
 * as REST, so the difference the learner sees is the binary encoding.
 */
const FOCUS_SETUPS: Record<LabFocus<'api-styles'>, Setup> = {
  'rest-apis': { ...DEFAULT_SETUP, style: 'rest' },
  graphql: { ...DEFAULT_SETUP, style: 'graphql' },
  grpc: { ...DEFAULT_SETUP, style: 'grpc', caller: 'service', rttMs: CALLERS.service.rttMs },
};

/**
 * Every card is wide enough for its longest subtitle ("users, orders, items, products"
 * needs 224px) and tall enough for its stat rows, and each gap between two cards
 * holds the label of its wire.
 */
const LAYOUT: Layout = {
  caller: { x: 16, y: 78, w: 176, h: 154 },
  proxy: { x: 262, y: 115, w: 154, h: 80 },
  server: { x: 470, y: 78, w: 200, h: 154 },
  db: { x: 720, y: 100, w: 224, h: 110 },
};

/** Dots drawn per hop. Calls past this still count in every number. */
const MAX_DOTS = 12;
/** How long the finished screen stays on screen before the load replays. */
const READY_PAUSE_S = 1.6;

type PhaseKind = 'up' | 'db' | 'down';
interface Phase {
  kind: PhaseKind;
  count: number;
  wave: number;
}

interface Sim {
  phase: number;
  spawned: boolean;
  particles: Particle[];
  /** Seconds spent on the finished screen before the replay. */
  readyFor: number;
  loads: number;
}

const createSim = (): Sim => ({ phase: 0, spawned: false, particles: [], readyFor: 0, loads: 0 });

function phasesOf(plan: Plan): Phase[] {
  return plan.waves.flatMap((wave, index) => [
    { kind: 'up' as const, count: wave.calls.length, wave: index },
    ...wave.dbLevels.map((count) => ({ kind: 'db' as const, count, wave: index })),
    { kind: 'down' as const, count: wave.calls.length, wave: index },
  ]);
}

export function ApiStylesLab({ focus }: LabProps<'api-styles'>) {
  // The page keys this lab by Concept, so the focus never changes under a mounted lab.
  const start = focus ? FOCUS_SETUPS[focus] : DEFAULT_SETUP;
  // Every control lives in one object, so Reset cannot miss one.
  const [setup, setSetup] = useState(start);
  const [running, setRunning] = useLabRunning();
  const sim = useRef<Sim>(createSim());
  const rerender = useRerender(30);

  const plan = useMemo(() => planFor(setup), [setup]);
  const phases = useMemo(() => phasesOf(plan), [plan]);
  /** The same screen with the other two styles, each on its own sub-options. */
  const compare = useMemo(
    () => STYLES.map((style) => ({ style: style.value, label: style.label, plan: planFor({ ...setup, style: style.value }) })),
    [setup],
  );

  const restart = () => {
    sim.current = createSim();
  };
  const change =
    <K extends keyof Setup>(key: K) =>
    (value: Setup[K]) => {
      setSetup((current) => ({ ...current, [key]: value }));
      restart();
    };
  const changeCaller = (caller: Caller) => {
    // A caller brings its own typical network; the slider can still move it after.
    setSetup((current) => ({ ...current, caller, rttMs: CALLERS[caller].rttMs }));
    restart();
  };

  const { style, caller, rttMs, orders } = setup;
  const route = (from: string, to: string) => (plan.proxy ? [from, 'proxy', to] : [from, to]);
  // A leg of the network takes longer on screen when the round trip is longer.
  // Visual only: the model time is the Screen ready metric.
  const networkLegsPerSecond = (plan.proxy ? 2 : 1) / clamp(0.3 + rttMs / 250, 0.3, 1.3);

  useTicker(running, (dt) => {
    const state = sim.current;
    if (state.phase >= phases.length) {
      state.readyFor += dt;
      if (state.readyFor >= READY_PAUSE_S) sim.current = { ...createSim(), loads: state.loads + 1 };
      rerender();
      return;
    }
    if (!state.spawned) {
      const phase = phases[state.phase];
      const dots = Math.min(phase.count, MAX_DOTS);
      for (let index = 0; index < dots; index += 1) {
        state.particles.push({
          id: nextParticleId(),
          route: phase.kind === 'up' ? route('caller', 'server') : phase.kind === 'down' ? route('server', 'caller') : ['server', 'db', 'server'],
          leg: 0,
          // Staggered starts, so parallel calls read as several dots, not one.
          t: -index * 0.08,
          speed: phase.kind === 'db' ? 3.2 : networkLegsPerSecond,
        });
      }
      state.spawned = true;
    }
    state.particles = advanceParticles(state.particles, dt).alive;
    if (state.particles.length === 0) {
      state.phase += 1;
      state.spawned = false;
    }
    rerender();
  });

  const state = sim.current;
  const current = phases[state.phase];
  const ready = state.phase >= phases.length;
  const waveNow = ready ? plan.waves.length : (current?.wave ?? 0) + 1;
  const callsDone = plan.waves.slice(0, ready ? plan.waves.length : (current?.wave ?? 0)).reduce((sum, wave) => sum + wave.calls.length, 0);
  const queriesDone = phases
    .slice(0, state.phase)
    .filter((phase) => phase.kind === 'db')
    .reduce((sum, phase) => sum + phase.count, 0);

  const particles: ParticleView[] = state.particles.map((particle) => ({
    id: particle.id,
    from: particle.route[particle.leg],
    to: particle.route[particle.leg + 1],
    t: particle.t,
    outcome: 'success',
  }));

  const edges: DiagramEdge[] = [
    ...(plan.proxy
      ? [
          { from: 'caller', to: 'proxy', tone: 'violet', label: 'grpc-web', width: 2 } satisfies DiagramEdge,
          { from: 'proxy', to: 'server', tone: 'brand', label: 'gRPC', width: 2 } satisfies DiagramEdge,
        ]
      : [{ from: 'caller', to: 'server', tone: 'brand', label: STYLE_WIRE[style], width: 2 } satisfies DiagramEdge]),
    { from: 'server', to: 'db', tone: 'info', label: 'SQL' },
  ];

  const over = overFetched(plan);
  const callerInfo = CALLERS[caller];
  const graphql = compare[1].plan;
  /**
   * The fixed REST baseline gRPC per resource is compared against: the same calls,
   * whole JSON resources. Not the current REST options, which the learner may have
   * set to Embed or Sparse fields - that would compare a different set of calls.
   */
  const restBaseline = useMemo(
    () => planFor({ ...setup, style: 'rest', restShape: 'per-resource', sparseFields: false }),
    [setup],
  );

  return (
    <LabShell
      title="API Styles Lab"
      description="One Order history screen, fetched with REST, GraphQL or gRPC. Count the round trips, the bytes the screen never shows, and the queries behind them."
      running={running}
      onRunningChange={setRunning}
      onReset={() => {
        // Back to this Concept's starting setup, not the lab's global default.
        setSetup(start);
        restart();
      }}
      actions={
        <Button onClick={restart}>
          <RefreshCw className="h-4 w-4" />
          Reload screen
        </Button>
      }
      legend={
        <div className="flex flex-wrap items-center justify-between gap-2">
          <ParticleLegend outcomes={['success']} />
          <span className="text-[11px] text-faint">
            One dot per call or query, up to {MAX_DOTS} per hop. Every call still counts in the numbers.
          </span>
        </div>
      }
      insight={<Insight>{insightFor(setup, plan, restBaseline, graphql)}</Insight>}
      metrics={
        <>
          <MetricsPanel
            items={[
              { key: 'requests', label: 'Requests', value: plan.requests, hint: 'Calls the caller sends to load the screen once.' },
              {
                key: 'waves',
                label: 'Round trips in a row',
                value: plan.waves.length,
                tone: plan.waves.length > 1 ? 'warn' : 'ok',
                hint: 'Calls that must wait for the answer of an earlier call, because they need ids from it. Calls in the same round trip go out together.',
              },
              {
                key: 'bytes',
                label: 'Downloaded',
                value: formatBytes(plan.bytes),
                hint: 'Response bodies only; headers are not counted.',
                simulated: true,
              },
              {
                key: 'over',
                label: 'Never shown',
                value: formatPercent(over),
                tone: over > 0.5 ? 'danger' : over > 0.2 ? 'warn' : 'ok',
                hint: 'Share of the downloaded bytes the screen does not display: over-fetching.',
                simulated: true,
              },
              {
                key: 'db',
                label: 'DB queries',
                value: plan.dbQueries,
                tone: plan.dbQueries > 6 ? 'warn' : 'ok',
                hint: 'Queries the server runs for one screen load.',
              },
              {
                key: 'ready',
                label: 'Screen ready',
                value: formatLatency(plan.readyMs),
                tone: plan.readyMs > 250 ? 'danger' : plan.readyMs > 120 ? 'warn' : 'ok',
                hint: `Round trips x ${rttMs} ms, plus ${DB_MS} ms per database level, plus transfer at ${callerInfo.mbps} Mbit/s.`,
                simulated: true,
              },
            ]}
          />

          <div className="card p-4">
            <p className="label mb-3">Same screen, three styles</p>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[520px] text-left text-xs">
                <thead className="text-faint">
                  <tr>
                    <th className="pb-2 font-medium">Style</th>
                    <th className="pb-2 text-right font-medium">Requests</th>
                    <th className="pb-2 text-right font-medium">Round trips</th>
                    <th className="pb-2 text-right font-medium">Downloaded</th>
                    <th className="pb-2 text-right font-medium">Never shown</th>
                    <th className="pb-2 text-right font-medium">DB queries</th>
                    <th className="pb-2 text-right font-medium">Ready</th>
                  </tr>
                </thead>
                <tbody className="font-mono tabular-nums">
                  {compare.map((row) => (
                    <tr
                      key={row.style}
                      className={cn('border-t border-line', row.style === style ? 'text-ink' : 'text-muted')}
                    >
                      <td className="py-1.5 pr-2 font-sans">
                        <button
                          type="button"
                          onClick={() => change('style')(row.style)}
                          aria-pressed={row.style === style}
                          className={cn('text-left hover:text-brand', row.style === style && 'font-semibold text-brand')}
                        >
                          {row.plan.variant}
                        </button>
                      </td>
                      <td className="py-1.5 text-right">{row.plan.requests}</td>
                      <td className="py-1.5 text-right">{row.plan.waves.length}</td>
                      <td className="py-1.5 text-right">{formatBytes(row.plan.bytes)}</td>
                      <td className="py-1.5 text-right">{formatPercent(overFetched(row.plan))}</td>
                      <td className="py-1.5 text-right">{row.plan.dbQueries}</td>
                      <td className="py-1.5 text-right">{formatLatency(row.plan.readyMs)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-xs text-faint">
              {SIMULATED_HINT} Illustrative JSON body sizes, protobuf taken as{' '}
              {Math.round(PROTO_RATIO * 100)}% of the same JSON (the real ratio depends on the data), {DB_MS} ms per
              database query, HTTP/2 for every style, and a {callerInfo.label.toLowerCase()}.
            </p>
          </div>

          <div className="card p-4">
            <p className="label mb-3">Calls for one screen load</p>
            <ol className="space-y-3">
              {plan.waves.map((wave, index) => (
                <li key={index}>
                  <p className="mb-1 text-[11px] font-medium text-muted">
                    Round trip {index + 1}
                    {index > 0 ? ' - waits for the ids in the answers above' : ''}
                  </p>
                  <ul className="space-y-1">
                    {wave.calls.slice(0, 3).map((call, callIndex) => (
                      <li key={callIndex} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 font-mono text-[11px]">
                        <span className="min-w-0 flex-1 break-all text-ink">{call.label}</span>
                        <span className="text-faint">{formatBytes(call.bytes)}</span>
                        <span className={cn(call.usedBytes / call.bytes < 0.5 ? 'text-danger' : 'text-ok')}>
                          {formatPercent(call.usedBytes / call.bytes)} shown
                        </span>
                      </li>
                    ))}
                    {wave.calls.length > 3 ? (
                      <li className="font-mono text-[11px] text-faint">+ {wave.calls.length - 3} more calls like these</li>
                    ) : null}
                  </ul>
                </li>
              ))}
            </ol>
          </div>
        </>
      }
      controls={
        <>
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted">API style</p>
            <SegmentedControl className="w-full" value={style} options={STYLES} onChange={change('style')} />
          </div>
          <Select
            label="Caller"
            value={caller}
            options={(Object.keys(CALLERS) as Caller[]).map((value) => ({ value, label: CALLERS[value].label }))}
            onChange={changeCaller}
            hint="Picking a caller also sets its typical round trip time and bandwidth."
          />
          <Slider
            label="Network round trip"
            value={rttMs}
            min={1}
            max={300}
            onChange={change('rttMs')}
            format={(value) => `${value} ms`}
            hint="Time for one request to reach the server and its answer to come back, before any work."
          />
          <Slider
            label="Orders on the screen"
            value={orders}
            min={1}
            max={8}
            onChange={change('orders')}
            format={(value) => `${value} orders`}
            hint={`Each order has ${ITEMS_PER_ORDER} items, and the screen shows the product name of each.`}
          />

          {style === 'rest' ? (
            <>
              <div className="space-y-2">
                <p className="text-xs font-medium text-muted">REST shape</p>
                <SegmentedControl<RestShape>
                  size="sm"
                  className="w-full"
                  value={setup.restShape}
                  options={[
                    { value: 'per-resource', label: 'Call per resource' },
                    { value: 'include', label: 'Embed (?include=)' },
                  ]}
                  onChange={change('restShape')}
                />
              </div>
              <Toggle
                label="Sparse fields (?fields=)"
                checked={setup.sparseFields}
                onChange={change('sparseFields')}
                description="Ask each resource for only the fields the screen shows"
              />
            </>
          ) : null}
          {style === 'graphql' ? (
            <Toggle
              label="Batch resolver queries"
              checked={setup.batching}
              onChange={change('batching')}
              description="DataLoader: one query per level instead of one per object"
            />
          ) : null}
          {style === 'grpc' ? (
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted">RPC design</p>
              <SegmentedControl<RpcDesign>
                size="sm"
                className="w-full"
                value={setup.rpcDesign}
                options={[
                  { value: 'per-resource', label: 'RPC per resource' },
                  { value: 'screen', label: 'RPC for the screen' },
                ]}
                onChange={change('rpcDesign')}
              />
            </div>
          ) : null}
        </>
      }
    >
      <DiagramCanvas layout={LAYOUT} edges={edges} particles={particles} height={320} className="bg-canvas">
        <ArchNode
          kind={caller === 'service' ? 'service' : 'client'}
          title={callerInfo.title}
          subtitle="Order history screen"
          placed={LAYOUT.caller}
          status={ready ? 'healthy' : 'starting'}
          statusLabel={ready ? 'Screen ready' : 'Loading'}
        >
          <NodeStatRow label="Round trip" value={`${Math.min(waveNow, plan.waves.length)} / ${plan.waves.length}`} />
          <NodeStatRow label="Answers in" value={`${callsDone} / ${plan.requests}`} />
          <NodeStatRow label="Downloaded" value={formatBytes(plan.bytes)} tone={over > 0.5 ? 'text-danger' : 'text-ink'} />
        </ArchNode>
        {plan.proxy ? (
          <ArchNode kind="load-balancer" title="Envoy proxy" subtitle="grpc-web to gRPC" placed={LAYOUT.proxy} compact />
        ) : null}
        <ArchNode kind="service" title="Orders service" subtitle={STYLE_WIRE[style]} placed={LAYOUT.server} selected>
          <NodeStatRow
            label={style === 'rest' ? 'Endpoints hit' : style === 'graphql' ? 'Endpoint' : 'Methods called'}
            value={style === 'graphql' ? '/graphql' : endpointsOf(setup)}
          />
          <NodeStatRow label="Encoding" value={style === 'grpc' ? 'binary' : 'JSON text'} />
          <NodeStatRow label="DB queries" value={plan.dbQueries} tone={plan.dbQueries > 6 ? 'text-warn' : 'text-ink'} />
        </ArchNode>
        <ArchNode kind="sql" title="Orders DB" subtitle="users, orders, items, products" placed={LAYOUT.db}>
          <NodeStatRow label="Queries run" value={`${queriesDone} / ${plan.dbQueries}`} />
        </ArchNode>
      </DiagramCanvas>
    </LabShell>
  );
}

/** Distinct endpoints or methods the screen touches: the surface a client has to know. */
function endpointsOf(setup: Setup) {
  if (setup.style === 'rest') return setup.restShape === 'include' ? 2 : 4;
  if (setup.style === 'grpc') return setup.rpcDesign === 'screen' ? 1 : 4;
  return 1;
}

function insightFor(setup: Setup, plan: Plan, restBaseline: Plan, graphql: Plan) {
  const over = formatPercent(overFetched(plan));
  if (setup.style === 'rest') {
    if (setup.restShape === 'per-resource') {
      return (
        <>
          The screen needs {plan.requests} requests in {plan.waves.length} round trips in a row: the items can only be
          asked for once the orders arrive, and the products once the items arrive. That is under-fetching. Each resource
          also comes back whole, so {over} of the {formatBytes(plan.bytes)} is never shown - over-fetching. Try Embed
          (?include=), Sparse fields, or switch to GraphQL: one request, {formatBytes(graphql.bytes)}.
        </>
      );
    }
    return setup.sparseFields ? (
      <>
        Embedding related resources and asking only for the shown fields gets REST close to GraphQL for this screen:{' '}
        {plan.requests} requests in one round trip, {formatBytes(plan.bytes)}. The cost moved to the API: someone had to
        build and keep these query parameters working on every endpoint.
      </>
    ) : (
      <>
        ?include= fixed the round trips - one, instead of three - but
        every embedded order, item and product still comes back whole, so {over} of the bytes are never shown. Turn on
        Sparse fields to cut the payload too.
      </>
    );
  }
  if (setup.style === 'graphql') {
    return setup.batching ? (
      <>
        One POST, one round trip, and the response has exactly the fields the query named - almost nothing is wasted.
        The work moved to the server: its resolvers run {plan.dbQueries} batched queries, one per level. Turn batching
        off to see what the same query costs without it.
      </>
    ) : (
      <>
        Still one request for the caller, but every item and product resolver now runs its own query: {plan.dbQueries}{' '}
        queries instead of 4. That is the N+1 problem - raise Orders on the screen and it grows with them, while the
        network numbers do not move. Batching (DataLoader) is what keeps it at one query per level.
      </>
    );
  }
  if (plan.proxy) {
    return (
      <>
        A browser cannot speak gRPC directly: it does not expose the HTTP/2 framing gRPC needs. The call goes out as
        grpc-web and an Envoy proxy translates it to gRPC for the service - one more part to run. For a public API used
        from browsers, REST or GraphQL is the usual front door, with gRPC behind it.
      </>
    );
  }
  if (setup.rpcDesign === 'per-resource') {
    return (
      <>
        The same {plan.requests} calls as REST with one call per resource, but binary protobuf makes the answers{' '}
        {formatBytes(plan.bytes)} instead of the {formatBytes(restBaseline.bytes)} of whole JSON resources, and the generated stub checks every field against the .proto contract. Protobuf
        shrinks the encoding, not the choice of fields: {over} is still never shown.{' '}
        {setup.caller === 'service'
          ? `Inside one data centre a round trip is about ${setup.rttMs} ms, so ${plan.waves.length} round trips cost little - switch the caller to the mobile app and see them add up.`
          : 'Over this network the round trips in a row cost more than the bytes - try RPC for the screen.'}
      </>
    );
  }
  return (
    <>
      One RPC designed for the screen returns exactly what it needs in {formatBytes(plan.bytes)}. The contract is a
      method in the .proto file, so this shape was designed on the server ahead of time - a new screen that needs other
      fields needs a new or changed method, where GraphQL would let the client write a new query.
    </>
  );
}

export default ApiStylesLab;
