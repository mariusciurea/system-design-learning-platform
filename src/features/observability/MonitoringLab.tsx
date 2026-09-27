import { useCallback, useRef, type ReactNode } from 'react';
import { Zap } from 'lucide-react';
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
import { Insight, LabShell, MetricsPanel, SIMULATED_HINT } from '@/components/learning';
import { Button, SegmentedControl, Slider, Toggle } from '@/components/ui';
import { useLabSetup } from '@/hooks/useLabSetup';
import { useRerender } from '@/hooks/useRerender';
import {
  advanceParticles,
  nextParticleId,
  useEventLog,
  useTicker,
  type Particle,
  type SeriesPoint,
} from '@/simulations/engine';
import type { LabFocus, LabProps, RequestOutcome } from '@/types';
import { cn } from '@/utils/cn';
import { formatBytes, formatLatency, formatNumber, formatPercent } from '@/utils/format';
import { mulberry32 } from '@/utils/math';
import { AlertsView, DashboardView, LogsView, MetricsView } from './MonitoringPanels';
import {
  BLIP_EVERY_S,
  BLIP_LENGTH_S,
  FAULTS,
  FAULT_SIZE_LABEL,
  HISTORY_S,
  SERVICES,
  SIGNALS,
  SIM_SPEED,
  aggregate,
  blipActive,
  clockText,
  durationText,
  evaluateAlert,
  logVolume,
  markHurt,
  newAlertState,
  paymentErrorRate,
  seriesCount,
  signalValue,
  simulateSecond,
  type AlertPhase,
  type AlertSignal,
  type AlertState,
  type Fault,
  type LogFormat,
  type LogLevel,
  type Panel,
  type Second,
  type ServiceId,
  type Setup,
  type Trace,
} from './monitoringModel';
import { useLabRunning } from '@/hooks/useLabRunning';

/** What the Lab opens on at /labs/monitoring, with no Lab focus: the whole-system dashboard, payments failing. */
const DEFAULT_SETUP: Setup = {
  panel: 'dashboard',
  traffic: 300,
  fault: 'payment-errors',
  faultSize: 0.1,
  logFormat: 'json',
  logLevel: 'info',
  sampleSuccess: false,
  windowS: 60,
  userIdLabel: false,
  probe: true,
  alertSignal: 'error-ratio',
  threshold: 2,
  forS: 120,
};

/**
 * The Lab focus of each Concept that hosts this Lab. All four look at the same running shop;
 * each opens the panel and the fault that shows its own idea first.
 */
const FOCUS_SETUPS: Record<LabFocus<'monitoring'>, Setup> = {
  // The log lines of one failing request, joined by trace_id.
  logging: { ...DEFAULT_SETUP, panel: 'logs' },
  // A slow tail: the average barely moves while p99 jumps.
  metrics: { ...DEFAULT_SETUP, panel: 'metrics', fault: 'slow-db', faultSize: 0.03 },
  // The same as the default today, on purpose: spelled out so it stays the dashboard if the default moves.
  monitoring: { ...DEFAULT_SETUP, panel: 'dashboard' },
  // Short blips that heal alone, a rule with no `for`: the noisy page.
  alerting: { ...DEFAULT_SETUP, panel: 'alerts', fault: 'blips', faultSize: 0.25, forS: 0 },
};

const PANELS: { value: Panel; label: string }[] = [
  { value: 'logs', label: 'Logs' },
  { value: 'metrics', label: 'Metrics' },
  { value: 'dashboard', label: 'Dashboard' },
  { value: 'alerts', label: 'Alerts' },
];

// Heights fit each card: two stat rows in the top row, one below. Probe is wide enough for
// its subtitle, and Users matches it so the column stays one width.
const LAYOUT: Layout = {
  users: { x: 20, y: 30, w: 170, h: 74 },
  probe: { x: 20, y: 150, w: 170, h: 74 },
  gateway: { x: 240, y: 45, w: 170, h: 117 },
  orders: { x: 470, y: 45, w: 170, h: 117 },
  payments: { x: 750, y: 10, w: 190, h: 117 },
  db: { x: 750, y: 140, w: 190, h: 117 },
  collector: { x: 400, y: 268, w: 180, h: 95 },
  logs: { x: 170, y: 400, w: 170, h: 95 },
  metrics: { x: 400, y: 400, w: 170, h: 95 },
  alerting: { x: 630, y: 400, w: 150, h: 95 },
  oncall: { x: 830, y: 400, w: 120, h: 95 },
};
const CANVAS_HEIGHT = 505;

/**
 * Simulated seconds of healthy history built before the Lab first renders, so charts and windows
 * start full. The warm-up runs with no fault and its alert counters are thrown away: the fault of
 * the setup starts when the learner is watching, so every page, noisy page and missed second on
 * screen happened in front of them. 420 s covers the 300 s chart span and ends 10 simulated
 * seconds (1 real second) before the first blip, so the Alerting focus shows its blip at once.
 */
const WARM_UP_S = BLIP_EVERY_S * 3 - BLIP_LENGTH_S - 10;
/** Chart points are one every 5 simulated seconds over the last 5 simulated minutes. */
const CHART_STEP_S = 5;
const CHART_SPAN_S = 300;

interface SimState {
  t: number;
  carry: number;
  history: Second[];
  traces: Trace[];
  followed: Trace | null;
  stream: Trace[];
  streamAt: number;
  alert: AlertState;
  chart: SeriesPoint[];
  /** The setup the chart was built for; a change rebuilds it at once, even while paused. */
  chartKey: string;
  particles: Particle[];
  emit: Record<string, number>;
  random: () => number;
  /** Whether the first live tick has logged the fault it starts. */
  announced: boolean;
}

function stepSecond(state: SimState, setup: Setup, log?: (message: string, tone: 'ok' | 'warn' | 'danger') => void) {
  const { second, traces } = simulateSecond(setup, state.t, state.random);
  state.history.push(second);
  if (state.history.length > HISTORY_S) state.history.shift();
  markHurt(state.history);
  evaluateAlert(state.alert, setup, state.history, log ?? (() => {}));
  state.traces.push(...traces);
  if (state.traces.length > 60) state.traces.splice(0, state.traces.length - 60);
  if (!state.followed) state.followed = traces.find((trace) => trace.failed) ?? null;
  state.t += 1;
}

function buildChart(state: SimState, setup: Setup): SeriesPoint[] {
  const { history } = state;
  const points: SeriesPoint[] = [];
  const last = history.length - 1;
  for (let end = Math.max(0, last - CHART_SPAN_S + CHART_STEP_S); end <= last; end += CHART_STEP_S) {
    const agg = aggregate(history, 'gateway', setup.windowS, end);
    const minute = aggregate(history, 'gateway', 60, end);
    points.push({
      t: history[end].t,
      avg: agg.avgMs,
      p50: agg.p50,
      p99: agg.p99,
      errorPct: agg.errorRatio * 100,
      errorPct1m: minute.errorRatio * 100,
      traffic: minute.rate,
      expected: history.slice(Math.max(0, end - 59), end + 1).reduce((sum, s) => sum + s.offered, 0) / Math.min(60, end + 1),
      signal: signalValue(history, setup.alertSignal, end),
      threshold: setup.threshold,
    });
  }
  return points;
}

const chartKeyOf = (setup: Setup) => `${setup.windowS}|${setup.alertSignal}|${setup.threshold}`;

function refreshChart(state: SimState, setup: Setup) {
  state.chart = buildChart(state, setup);
  state.chartKey = chartKeyOf(setup);
}

function createState(setup: Setup): SimState {
  const state: SimState = {
    t: 0,
    carry: 0,
    history: [],
    traces: [],
    followed: null,
    stream: [],
    streamAt: 0,
    alert: newAlertState(),
    chart: [],
    chartKey: '',
    particles: [],
    emit: {},
    random: mulberry32(49),
    announced: false,
  };
  const healthy: Setup = { ...setup, fault: 'none' };
  for (let index = 0; index < WARM_UP_S; index += 1) stepSecond(state, healthy);
  // Counters and the followed request start now, with the learner watching.
  state.alert = newAlertState();
  state.followed = null;
  state.stream = state.traces.slice(-8);
  refreshChart(state, setup);
  return state;
}

const faultLabel = (fault: Fault) => FAULTS.find((item) => item.value === fault)?.label ?? fault;

/** Emits `rate` particles per real second on average, smoothly, using a per-stream carry. */
function emitCount(state: SimState, key: string, rate: number, dt: number) {
  const next = (state.emit[key] ?? 0) + rate * dt;
  const whole = Math.floor(next);
  state.emit[key] = next - whole;
  return whole;
}

export function MonitoringLab({ focus }: LabProps<'monitoring'>) {
  // The page keys this Lab by Concept, so the focus never changes under a mounted Lab.
  const start = focus ? FOCUS_SETUPS[focus] : DEFAULT_SETUP;
  // Every control lives in one object, so Reset cannot miss one.
  const { setup, setSetup, change } = useLabSetup(start);
  const [running, setRunning] = useLabRunning();
  const state = useRef<SimState | null>(null);
  if (state.current === null) state.current = createState(start);
  const rerender = useRerender(30);
  const { events, log, clear } = useEventLog();

  const reset = useCallback(() => {
    setSetup(start);
    state.current = createState(start);
    clear();
  }, [start, clear, setSetup]);

  const chooseFault = (fault: Fault) => {
    if (fault === setup.fault) return;
    change('fault')(fault);
    log(fault === 'none' ? 'Fault removed' : `Fault injected: ${faultLabel(fault)}`, fault === 'none' ? 'ok' : 'warn');
  };

  const chooseSignal = (signal: AlertSignal) =>
    setSetup((current) => ({ ...current, alertSignal: signal, threshold: SIGNALS[signal].start }));

  useTicker(running, (dt) => {
    const sim = state.current;
    if (!sim) return;
    if (!sim.announced) {
      sim.announced = true;
      log(`${Math.round(WARM_UP_S / 60)} simulated minutes of healthy history loaded - pages count from now`, 'ok');
      if (setup.fault !== 'none') log(`Fault injected: ${faultLabel(setup.fault)}`, 'warn');
    }
    sim.carry += dt * SIM_SPEED;
    let stepped = false;
    while (sim.carry >= 1) {
      sim.carry -= 1;
      stepSecond(sim, setup, log);
      stepped = true;
      if (sim.t % CHART_STEP_S === 0) refreshChart(sim, setup);
    }
    const now = performance.now();
    if (stepped && now - sim.streamAt > 1000) {
      sim.streamAt = now;
      sim.stream = sim.traces.slice(-8);
    }

    spawnParticles(sim, setup, dt);
    const { alive, finished } = advanceParticles(sim.particles, dt);
    // A request that cannot find us dies half way along its wire: it never arrives.
    const reached = alive.filter((particle) => !(particle.meta?.dropAt && particle.t >= (particle.meta.dropAt as number)));
    for (const particle of [...finished, ...alive.filter((p) => !reached.includes(p))]) {
      if (particle.meta?.kind === 'probe') {
        reached.push({
          id: nextParticleId(),
          route: ['probe', 'collector'],
          leg: 0,
          t: 0,
          speed: 1.2,
          outcome: particle.outcome === 'failure' ? 'failure' : 'success',
        });
      }
    }
    sim.particles = reached.slice(-140);
    rerender();
  });

  const sim = state.current;
  if (sim.chartKey !== chartKeyOf(setup)) refreshChart(sim, setup);
  const { history, alert } = sim;
  const latest = history[history.length - 1];
  const aggregates = Object.fromEntries(SERVICES.map((id) => [id, aggregate(history, id, 60)])) as Record<
    ServiceId,
    ReturnType<typeof aggregate>
  >;
  const windowed = aggregate(history, 'gateway', setup.windowS);
  const expectedRate = history.slice(-60).reduce((sum, s) => sum + s.offered, 0) / Math.max(1, Math.min(60, history.length));
  const payErrNow = paymentErrorRate(setup, sim.t);
  const volume = logVolume(setup, aggregates.gateway.rate, setup.fault === 'blips' ? 0.001 : payErrNow);
  const series = seriesCount(setup.userIdLabel);
  const lastProbe = [...history].reverse().find((s) => s.probe !== null)?.probe ?? null;
  const probeResult = setup.probe ? lastProbe : null;
  const blip = setup.fault === 'blips' && blipActive(sim.t);
  const paymentsBad = setup.fault === 'payment-errors' || blip;
  const slowDb = setup.fault === 'slow-db';
  const unreachable = setup.fault === 'unreachable';
  const timeline = buildTimeline(history);

  const particleViews: ParticleView[] = sim.particles.map((particle) => ({
    id: particle.id,
    from: particle.route[particle.leg],
    to: particle.route[particle.leg + 1],
    t: particle.t,
    outcome: particle.outcome ?? 'success',
  }));

  const focusEdges = (panel: Panel): Record<string, boolean> => ({
    logs: panel === 'logs',
    metrics: panel === 'metrics' || panel === 'dashboard' || panel === 'alerts',
    alerts: panel === 'alerts',
  });
  const lit = focusEdges(setup.panel);
  const telemetryTone = (on: boolean, tone: EdgeTone): EdgeTone => (on ? tone : 'muted');

  const edges: DiagramEdge[] = [
    { from: 'users', to: 'gateway', tone: unreachable ? 'danger' : 'brand', dashed: unreachable, width: 2 },
    { from: 'gateway', to: 'orders', tone: 'brand', width: 2 },
    { from: 'orders', to: 'payments', tone: paymentsBad ? 'danger' : 'brand' },
    { from: 'orders', to: 'db', tone: slowDb ? 'warn' : 'brand' },
    { from: 'probe', to: 'gateway', tone: setup.probe ? (unreachable ? 'danger' : 'info') : 'muted', dashed: true, faded: !setup.probe },
    { from: 'probe', to: 'collector', tone: setup.probe ? 'info' : 'muted', dashed: true, faded: !setup.probe },
    { from: 'gateway', to: 'collector', tone: telemetryTone(true, 'violet') },
    { from: 'orders', to: 'collector', tone: telemetryTone(true, 'violet') },
    { from: 'payments', to: 'collector', tone: telemetryTone(true, 'violet') },
    { from: 'db', to: 'collector', tone: telemetryTone(true, 'violet') },
    { from: 'collector', to: 'logs', tone: telemetryTone(lit.logs, 'info'), animated: lit.logs },
    { from: 'collector', to: 'metrics', tone: telemetryTone(lit.metrics, 'info'), animated: lit.metrics },
    { from: 'metrics', to: 'alerting', tone: telemetryTone(lit.alerts, 'info'), animated: lit.alerts },
    { from: 'alerting', to: 'oncall', tone: alert.phase === 'firing' ? 'danger' : 'muted', animated: alert.phase === 'firing' },
  ];

  const errorTone = (ratio: number) => (ratio > 0.01 ? 'text-danger' : ratio > 0.003 ? 'text-warn' : 'text-ok');
  const latencyTone = (ms: number) => (ms > 1000 ? 'text-danger' : ms > 500 ? 'text-warn' : 'text-ink');
  const faultInfo = FAULTS.find((item) => item.value === setup.fault);

  return (
    <LabShell
      title="Monitoring Lab"
      description="A small shop running live. Inject a fault, then read what comes out of every part: the log lines of one request, the metric graphs of the trend, the dashboard of the whole system and the alert rule that pages a human - or does not."
      running={running}
      onRunningChange={setRunning}
      onReset={reset}
      events={events}
      actions={
        <Button variant="secondary" onClick={() => chooseFault(setup.fault === 'none' ? 'payment-errors' : 'none')}>
          <Zap className="h-4 w-4" />
          {setup.fault === 'none' ? 'Inject a fault' : 'Remove the fault'}
        </Button>
      }
      legend={
        <div className="space-y-1.5">
          <ParticleLegend
            outcomes={[
              { outcome: 'success', label: 'Request or log line' },
              { outcome: 'warning', label: 'Slow database query' },
              { outcome: 'failure', label: 'Failed request, ERROR or page' },
            ]}
          />
          <p className="text-[11px] text-faint">
            Top row: user requests. Violet wires: every part sends its log lines and metrics to the collector
            (a cross on them is an ERROR line). Red wire to On-call: a page. The simulated clock runs 10x faster than real
            time. {SIMULATED_HINT}
          </p>
        </div>
      }
      insight={<Insight>{insightFor(setup, { alert, aggregates, windowed, probeResult, volume })}</Insight>}
      metrics={
        <>
          <MetricsPanel
            items={[
              { key: 'clock', label: 'Simulated clock', value: clockText(sim.t), hint: 'Runs 10x faster than real time.' },
              {
                key: 'rps',
                label: 'Traffic',
                value: formatNumber(aggregates.gateway.rate),
                unit: 'req/s',
                tone: aggregates.gateway.rate < expectedRate * 0.5 ? 'danger' : 'brand',
                hint: 'Requests arriving at the gateway, averaged over the last simulated minute.',
                simulated: true,
              },
              {
                key: 'errorRate',
                label: 'Errors (1m)',
                value: formatPercent(aggregates.gateway.errorRatio, 2),
                tone: aggregates.gateway.errorRatio > 0.01 ? 'danger' : 'ok',
                hint: 'Share of requests that failed at the gateway over the last simulated minute.',
                simulated: true,
              },
              {
                key: 'p99',
                label: 'p99 (1m)',
                value: formatLatency(aggregates.gateway.p99),
                tone: aggregates.gateway.p99 > 1000 ? 'danger' : 'neutral',
                simulated: true,
              },
              {
                key: 'alert',
                label: 'Alert',
                value: PHASE_LABEL[alert.phase],
                tone: alert.phase === 'firing' ? 'danger' : alert.phase === 'pending' ? 'warn' : 'ok',
                hint: 'The state of the alert rule set in the Alerts panel.',
              },
            ]}
          />
          <div className="card p-4">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
              <p className="label">What comes out of the system</p>
              <SegmentedControl size="sm" value={setup.panel} options={PANELS} onChange={change('panel')} />
            </div>
            {setup.panel === 'logs' ? (
              <LogsView
                setup={setup}
                stream={sim.stream}
                followed={sim.followed}
                onNext={() => {
                  sim.followed = [...sim.traces].reverse().find((trace) => trace.failed && trace.id !== sim.followed?.id) ?? null;
                  rerender();
                }}
                linesPerSecond={volume.linesPerSecond}
                bytesPerDay={volume.bytesPerDay}
              />
            ) : setup.panel === 'metrics' ? (
              <MetricsView setup={setup} chart={sim.chart} gateway={windowed} series={series} />
            ) : setup.panel === 'dashboard' ? (
              <DashboardView
                setup={setup}
                aggregates={aggregates}
                expectedRate={expectedRate}
                probe={probeResult}
                chart={sim.chart}
              />
            ) : (
              <AlertsView setup={setup} alert={alert} chart={sim.chart} timeline={timeline} />
            )}
          </div>
        </>
      }
      controls={
        <>
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted">Fault</p>
            <div className="space-y-1.5">
              {FAULTS.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  aria-pressed={setup.fault === item.value}
                  onClick={() => chooseFault(item.value)}
                  className={cn(
                    'w-full rounded-lg border px-3 py-2 text-left text-xs font-medium transition-colors',
                    setup.fault === item.value
                      ? 'border-brand bg-brand/10 text-brand'
                      : 'border-line text-muted hover:border-brand/50 hover:text-ink',
                  )}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>
          {faultInfo?.sized ? (
            <Slider
              label={FAULT_SIZE_LABEL[setup.fault]}
              value={setup.faultSize}
              min={0.01}
              max={0.5}
              step={0.01}
              onChange={change('faultSize')}
              format={(value) => `${Math.round(value * 100)}%`}
              tone="danger"
              hint={
                setup.fault === 'slow-db'
                  ? 'Share of product queries that take 1.5-2.5 s.'
                  : setup.fault === 'blips'
                    ? 'For 20 s in every 150 s, then it heals on its own.'
                    : 'Checkouts are 40% of requests, so the gateway sees 40% of this as errors.'
              }
            />
          ) : null}
          <Slider
            label="Traffic"
            value={setup.traffic}
            min={50}
            max={700}
            step={10}
            onChange={change('traffic')}
            format={(value) => `${formatNumber(value)} req/s`}
            hint="Average requests per second the users send. It rises and falls by 20% like a day."
          />

          <div className="border-t border-line pt-4">
            <PanelControls setup={setup} change={change} chooseSignal={chooseSignal} />
          </div>
        </>
      }
    >
      <DiagramCanvas layout={LAYOUT} edges={edges} particles={particleViews} height={CANVAS_HEIGHT} className="bg-canvas">
        <ArchNode
          kind="client"
          title="Users"
          subtitle={`${formatNumber(latest?.offered ?? 0)} req/s sent`}
          placed={LAYOUT.users}
          status={unreachable ? 'degraded' : 'healthy'}
          statusLabel={unreachable ? 'Cannot reach us' : undefined}
          compact
        />
        <ArchNode
          kind="client"
          title="Probe"
          subtitle="black box, every 10 s"
          placed={LAYOUT.probe}
          status={!setup.probe ? 'down' : probeResult === 'fail' ? 'degraded' : 'healthy'}
          statusLabel={!setup.probe ? 'Off' : probeResult === 'fail' ? 'Failing' : 'Passing'}
          compact
        />
        <ArchNode kind="api-gateway" title="Gateway" subtitle="entry point" placed={LAYOUT.gateway} compact>
          <NodeStatRow label="Errors 1m" value={formatPercent(aggregates.gateway.errorRatio, 1)} tone={errorTone(aggregates.gateway.errorRatio)} />
          <NodeStatRow label="p99 1m" value={formatLatency(aggregates.gateway.p99)} tone={latencyTone(aggregates.gateway.p99)} />
        </ArchNode>
        <ArchNode kind="service" title="Orders" subtitle="checkout, browse" placed={LAYOUT.orders} compact>
          <NodeStatRow label="Errors 1m" value={formatPercent(aggregates.orders.errorRatio, 1)} tone={errorTone(aggregates.orders.errorRatio)} />
          <NodeStatRow
            label="CPU"
            value={formatPercent(latest?.saturation.orders ?? 0)}
            tone={(latest?.saturation.orders ?? 0) > 0.6 ? 'text-warn' : 'text-ink'}
          />
        </ArchNode>
        <ArchNode
          kind="service"
          title="Payments"
          subtitle="calls card processor"
          placed={LAYOUT.payments}
          status={paymentsBad && setup.faultSize >= 0.05 ? 'degraded' : 'healthy'}
          alert={paymentsBad}
          compact
        >
          <NodeStatRow label="Errors 1m" value={formatPercent(aggregates.payments.errorRatio, 1)} tone={errorTone(aggregates.payments.errorRatio)} />
          <NodeStatRow label="p99 1m" value={formatLatency(aggregates.payments.p99)} tone={latencyTone(aggregates.payments.p99)} />
        </ArchNode>
        <ArchNode
          kind="sql"
          title="Database"
          subtitle="products"
          placed={LAYOUT.db}
          status={slowDb ? 'degraded' : 'healthy'}
          alert={slowDb}
          compact
        >
          <NodeStatRow label="p99 1m" value={formatLatency(aggregates.db.p99)} tone={latencyTone(aggregates.db.p99)} />
          <NodeStatRow label="Pool in use" value={formatPercent(aggregates.db.saturation)} />
        </ArchNode>
        <ArchNode kind="queue" title="Collector" subtitle="logs + metrics in" placed={LAYOUT.collector} compact>
          <NodeStatRow label="Log lines" value={`${formatNumber(volume.linesPerSecond)}/s`} />
        </ArchNode>
        <ArchNode kind="search" title="Log store" subtitle="search by trace_id" placed={LAYOUT.logs} selected={setup.panel === 'logs'} compact>
          <NodeStatRow label="Per day" value={formatBytes(volume.bytesPerDay)} />
        </ArchNode>
        <ArchNode
          kind="monitoring"
          title="Metrics DB"
          subtitle="time series"
          placed={LAYOUT.metrics}
          selected={setup.panel === 'metrics' || setup.panel === 'dashboard'}
          status={setup.userIdLabel ? 'degraded' : 'healthy'}
          statusLabel={setup.userIdLabel ? 'Out of memory soon' : undefined}
          alert={setup.userIdLabel}
          compact
        >
          <NodeStatRow label="Series" value={formatCompactSeries(series)} tone={setup.userIdLabel ? 'text-danger' : 'text-ink'} />
        </ArchNode>
        <ArchNode
          kind="monitoring"
          title="Alert rules"
          subtitle={setup.alertSignal === 'cpu' ? 'cause rule' : 'symptom rule'}
          placed={LAYOUT.alerting}
          selected={setup.panel === 'alerts'}
          alert={alert.phase === 'firing'}
          compact
        >
          <NodeStatRow
            label="State"
            value={PHASE_LABEL[alert.phase]}
            tone={alert.phase === 'firing' ? 'text-danger' : alert.phase === 'pending' ? 'text-warn' : 'text-ok'}
          />
        </ArchNode>
        <ArchNode kind="client" title="On-call" subtitle="pager" placed={LAYOUT.oncall} compact>
          <NodeStatRow label="Pages" value={formatNumber(alert.pages)} tone={alert.pages > 0 ? 'text-danger' : 'text-ink'} />
        </ArchNode>
      </DiagramCanvas>
    </LabShell>
  );
}

const PHASE_LABEL: Record<AlertPhase, string> = { ok: 'Inactive', pending: 'Pending', firing: 'Firing' };

const formatCompactSeries = (count: number) =>
  count >= 1e6 ? `${(count / 1e6).toFixed(1)}M` : count >= 1e3 ? `${(count / 1e3).toFixed(1)}k` : formatNumber(count);

/** 60 cells of 5 simulated seconds each: the worst alert phase and whether users hurt. */
function buildTimeline(history: Second[]) {
  const rank: Record<AlertPhase, number> = { ok: 0, pending: 1, firing: 2 };
  const cells: { phase: AlertPhase; hurt: boolean }[] = [];
  const recent = history.slice(-CHART_SPAN_S);
  for (let index = 0; index < recent.length; index += CHART_STEP_S) {
    const chunk = recent.slice(index, index + CHART_STEP_S);
    let phase: AlertPhase = 'ok';
    for (const s of chunk) if (rank[s.alert] > rank[phase]) phase = s.alert;
    cells.push({ phase, hurt: chunk.some((s) => s.hurt) });
  }
  return cells;
}

/** Particles are a sample of the traffic for the eye, never the traffic that is counted. */
function spawnParticles(sim: SimState, setup: Setup, dt: number) {
  const payErr = paymentErrorRate(setup, sim.t);
  const slowShare = setup.fault === 'slow-db' ? setup.faultSize : 0;
  const unreachable = setup.fault === 'unreachable';
  const push = (route: string[], outcome: RequestOutcome, speed = 1.1, meta?: Record<string, unknown>) =>
    sim.particles.push({ id: nextParticleId(), route, leg: 0, t: 0, speed: speed + sim.random() * 0.3, outcome, meta });

  for (let i = emitCount(sim, 'req', 3 + setup.traffic / 150, dt); i > 0; i -= 1) {
    if (unreachable) {
      push(['users', 'gateway'], 'failure', 1.1, { dropAt: 0.5 });
      continue;
    }
    if (sim.random() < 0.4) {
      const failed = sim.random() < payErr;
      push(['users', 'gateway', 'orders', 'payments'], failed ? 'failure' : 'success');
    } else {
      const slow = sim.random() < slowShare;
      push(['users', 'gateway', 'orders', 'db'], slow ? 'warning' : 'success', slow ? 0.7 : 1.1);
    }
  }

  const levelFactor = { debug: 1.5, info: 1, warn: 0.4, error: 0.25 }[setup.logLevel] * (setup.sampleSuccess ? 0.4 : 1);
  const telemetryRate = unreachable ? 0.35 : 1.1 * levelFactor;
  for (const service of SERVICES) {
    for (let i = emitCount(sim, `tel-${service}`, telemetryRate, dt); i > 0; i -= 1) {
      const errorLine =
        (service === 'payments' || service === 'orders') && sim.random() < Math.min(0.9, payErr * 3)
          ? 'failure'
          : service === 'db' && sim.random() < slowShare * 5
            ? 'warning'
            : 'success';
      push([service, 'collector'], errorLine, 1.2);
    }
  }
  for (let i = emitCount(sim, 'to-logs', 1.4 * levelFactor, dt); i > 0; i -= 1) push(['collector', 'logs'], 'success', 1.3);
  for (let i = emitCount(sim, 'to-metrics', 1.4, dt); i > 0; i -= 1) push(['collector', 'metrics'], 'success', 1.3);
  for (let i = emitCount(sim, 'rules', 0.8, dt); i > 0; i -= 1) push(['metrics', 'alerting'], 'success', 1.4);
  if (sim.alert.phase === 'firing')
    for (let i = emitCount(sim, 'page', 1.5, dt); i > 0; i -= 1) push(['alerting', 'oncall'], 'failure', 1.5);
  if (setup.probe)
    for (let i = emitCount(sim, 'probe', 1, dt); i > 0; i -= 1)
      push(['probe', 'gateway'], unreachable ? 'failure' : 'success', 1.2, unreachable ? { kind: 'probe', dropAt: 0.5 } : { kind: 'probe' });
}

type Change = <K extends keyof Setup>(key: K) => (value: Setup[K]) => void;

function PanelControls({
  setup,
  change,
  chooseSignal,
}: {
  setup: Setup;
  change: Change;
  chooseSignal: (signal: AlertSignal) => void;
}) {
  if (setup.panel === 'logs')
    return (
      <div className="space-y-4">
        <p className="label">Logs</p>
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-muted">Format</p>
          <SegmentedControl<LogFormat>
            size="sm"
            className="w-full"
            value={setup.logFormat}
            options={[
              { value: 'text', label: 'Plain text' },
              { value: 'json', label: 'JSON + trace_id' },
            ]}
            onChange={change('logFormat')}
          />
        </div>
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-muted">Lowest level written</p>
          <SegmentedControl<LogLevel>
            size="sm"
            className="w-full"
            value={setup.logLevel}
            options={[
              { value: 'debug', label: 'DEBUG' },
              { value: 'info', label: 'INFO' },
              { value: 'warn', label: 'WARN' },
              { value: 'error', label: 'ERROR' },
            ]}
            onChange={change('logLevel')}
          />
        </div>
        <Toggle
          label="Sample successful requests"
          checked={setup.sampleSuccess}
          onChange={change('sampleSuccess')}
          description="Keep 1 in 10 successful requests. Every failing request is kept."
        />
      </div>
    );
  if (setup.panel === 'metrics')
    return (
      <div className="space-y-4">
        <p className="label">Metrics</p>
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-muted">Aggregation window</p>
          <SegmentedControl<string>
            size="sm"
            className="w-full"
            value={String(setup.windowS)}
            options={[
              { value: '10', label: '10 s' },
              { value: '60', label: '1 min' },
              { value: '300', label: '5 min' },
            ]}
            onChange={(value) => change('windowS')(Number(value))}
          />
          <p className="text-[11px] text-faint">Every point on the graphs sums the requests of this window.</p>
        </div>
        <Toggle
          label="Add a user_id label"
          checked={setup.userIdLabel}
          onChange={change('userIdLabel')}
          description="Slice request metrics per user. Watch the series count."
        />
      </div>
    );
  if (setup.panel === 'dashboard')
    return (
      <div className="space-y-4">
        <p className="label">Dashboard</p>
        <Toggle
          label="Synthetic probe (black box)"
          checked={setup.probe}
          onChange={change('probe')}
          description="Loads the site from outside every 10 s, the way a user would."
        />
      </div>
    );
  const signal = SIGNALS[setup.alertSignal];
  return (
    <div className="space-y-4">
      <p className="label">Alert rule</p>
      <div className="space-y-1.5">
        {(Object.keys(SIGNALS) as AlertSignal[]).map((key) => (
          <button
            key={key}
            type="button"
            aria-pressed={setup.alertSignal === key}
            onClick={() => chooseSignal(key)}
            className={cn(
              'w-full rounded-lg border px-3 py-2 text-left text-xs font-medium transition-colors',
              setup.alertSignal === key ? 'border-brand bg-brand/10 text-brand' : 'border-line text-muted hover:border-brand/50 hover:text-ink',
            )}
          >
            {SIGNALS[key].label}
          </button>
        ))}
      </div>
      <Slider
        label="Threshold"
        value={setup.threshold}
        min={signal.min}
        max={signal.max}
        step={signal.step}
        onChange={change('threshold')}
        format={(value) => (signal.unit === 'ms' ? `${value} ms` : `${value}%`)}
        tone="warn"
      />
      <Slider
        label="For (must hold this long)"
        value={setup.forS}
        min={0}
        max={300}
        step={30}
        onChange={change('forS')}
        format={(value) => (value === 0 ? '0 s - fire at once' : durationText(value))}
        hint="Simulated time. A short blip must outlast this before anyone is paged."
      />
    </div>
  );
}

interface InsightData {
  alert: AlertState;
  aggregates: Record<ServiceId, ReturnType<typeof aggregate>>;
  windowed: ReturnType<typeof aggregate>;
  probeResult: 'pass' | 'fail' | null;
  volume: { linesPerSecond: number; bytesPerDay: number };
}

function insightFor(setup: Setup, data: InsightData): ReactNode {
  const { alert, aggregates, windowed, probeResult, volume } = data;
  const gw = aggregates.gateway;
  switch (setup.panel) {
    case 'logs':
      if (setup.fault === 'none' || setup.fault === 'slow-db' || setup.fault === 'unreachable')
        return 'Pick "Payments failing" to make requests fail, then follow one failing request through its log lines.';
      if (setup.logFormat === 'text')
        return `Plain text lines have no trace_id and no service name. The ERROR line says a card processor returned 503, but it cannot be joined to the request it broke - it is one of about ${formatNumber(volume.linesPerSecond)} lines a second. Switch the format to JSON + trace_id.`;
      if (setup.logLevel === 'error')
        return 'At ERROR only, the failure is written but the request around it is not: you know payments failed, not which route, which status went back or how long it took. INFO is where one line per step belongs.';
      if (setup.logLevel === 'debug')
        return `DEBUG adds the cart and query details to every request - useful while you hunt a bug, and ${formatBytes(volume.bytesPerDay)} a day while you do not. Try sampling successful requests: failing ones are always kept.`;
      return `One query on trace_id = "..." rebuilds the request across three services, in order. Structured fields and a shared trace_id turn logs from text to grep into data to query. Turn on sampling: the volume drops to ${formatBytes(volume.bytesPerDay)} a day and the failing request is still there, because errors are never sampled.`;
    case 'metrics':
      if (setup.userIdLabel)
        return 'A user_id label makes every user their own time series - millions of them, each stored and indexed. Request metrics stay cheap only while every label has a small, fixed set of values. Per-user detail belongs in logs and traces.';
      if (setup.fault === 'slow-db')
        return `${Math.round(setup.faultSize * 100)}% of product queries take about 2 s. The average is ${formatLatency(windowed.avgMs)} and looks fine; p99 is ${formatLatency(windowed.p99)}, because the slow requests are more than 1 in 100. Averages hide the tail - read percentiles from a histogram. Then change the window: 10 s is jumpy, 5 min is smooth but slow to react.`;
      return 'Pick "Slow database queries" and compare the average with p99. Then change the aggregation window and watch the same data get smoother and slower to react.';
    case 'dashboard':
      if (setup.fault === 'unreachable')
        return probeResult === 'fail'
          ? 'Every internal signal is green - no errors, fast responses - because broken DNS stops users before they reach us. Only two things show it: traffic falling far below what users send, and the black-box probe failing from outside.'
          : 'Every internal signal is green because the requests never arrive. Without the probe, the only clue is traffic falling. Turn the synthetic probe on.';
      if (setup.fault === 'none')
        return 'All four golden signals are calm. Inject a fault and see which part turns red first - that row tells you where to look.';
      return `The four golden signals per part answer "is it healthy, and where not?" at a glance: errors at the gateway are ${formatPercent(gw.errorRatio, 1)}, and the Payments row shows where they come from. Now try "Users cannot reach us" - the kind of outage internal graphs cannot see.`;
    case 'alerts': {
      if (setup.alertSignal === 'cpu')
        return 'CPU is a cause, not a symptom. Raise traffic and the rule fires at every daily peak while users are fine (noisy pages); inject a payment fault and CPU stays calm while checkouts fail (missed pain). Page on what users feel.';
      if (alert.noisyPages > 0 && setup.fault === 'blips')
        return `The blips heal alone in 20 s, but a rule with for: ${setup.forS} s pages anyway - ${alert.noisyPages} noisy page${alert.noisyPages === 1 ? '' : 's'} so far. Raise For to 2 min: the blips stop paging. Then pick "Payments failing": a lasting fault still pages, a little later.`;
      if (alert.missedS > 0 && alert.phase !== 'firing')
        return `Users have been hurting for ${durationText(alert.missedS)} with nothing firing. Either the threshold is above what the fault produces, or the rule watches a signal this failure does not move - "Users cannot reach us" has no errors at all.`;
      if (alert.phase === 'firing')
        return 'Firing on a symptom users feel. The For duration delays the page, so a real fault waits that long before a human hears about it - short enough to act, long enough to skip blips.';
      return 'Inject a fault and watch the rule go from Inactive to Pending to Firing. Try to get zero noisy pages and zero missed pain across all the faults.';
    }
  }
}

export default MonitoringLab;
