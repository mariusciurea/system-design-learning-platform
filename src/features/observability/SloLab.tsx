import { useCallback, useRef, type ReactNode } from 'react';
import { Zap } from 'lucide-react';
import { ArchNode, DiagramCanvas, NodeStatRow, ParticleLegend, type DiagramEdge, type Layout, type ParticleView } from '@/components/architecture';
import { LiveChart } from '@/components/charts';
import { Insight, LabShell, MetricsPanel, SIMULATED_HINT } from '@/components/learning';
import { Button, Meter, SegmentedControl, Slider, Toggle } from '@/components/ui';
import { advanceParticles, nextParticleId, useEventLog, useTicker, type Particle } from '@/simulations/engine';
import { useLabSetup } from '@/hooks/useLabSetup';
import { useRerender } from '@/hooks/useRerender';
import { formatHours, formatNumber } from '@/utils/format';
import type { LabFocus, LabProps, RequestOutcome } from '@/types';
import {
  INCIDENT_ERROR,
  INCIDENT_MIN,
  LATENCY_THRESHOLD_MS,
  MONTHLY_FEE,
  MONTH_MIN,
  SYNTHETIC_RPS,
  USER_RPS,
  advance,
  alertState,
  burnRate,
  createSloState,
  creditPct,
  currentErrorRate,
  incidentActive,
  monthElapsed,
  ratio,
  spentMinutes,
  type GoodDefinition,
  type MeasurementPoint,
  type SloState,
} from './sloModel';
import { useLabRunning } from '@/hooks/useLabRunning';

interface Setup {
  good: GoodDefinition;
  point: MeasurementPoint;
  countSynthetic: boolean;
  slo: number;
  sla: number;
  errorRate: number;
  slowRate: number;
  dropRate: number;
  /** Simulated hours per real second. */
  speed: number;
}

/**
 * What the lab opens on at /labs/slo, with no Lab focus: an honest SLI, a
 * 99.9% SLO burning at half the sustainable rate, and an SLA below the SLO.
 */
const DEFAULT_SETUP: Setup = {
  good: 'status-latency',
  point: 'load-balancer',
  countSynthetic: false,
  slo: 0.999,
  sla: 0.995,
  errorRate: 0.0003,
  slowRate: 0.0002,
  dropRate: 0,
  speed: 6,
};

/**
 * The Lab focus of each Concept that hosts this lab.
 * SLI opens on a flattering indicator: measured at the server, counting only
 * 5xx, with bots and probes counted - users feel far worse than it reports.
 * SLO opens on the honest indicator and a budget that is being spent slowly.
 * SLA opens on a steady 2x burn: the SLO will be missed while the SLA holds,
 * and one more push breaks the contract.
 */
const FOCUS_SETUPS: Record<LabFocus<'slo'>, Setup> = {
  sli: {
    ...DEFAULT_SETUP,
    good: 'status',
    point: 'server',
    countSynthetic: true,
    errorRate: 0.001,
    slowRate: 0.01,
    dropRate: 0.003,
  },
  // The same as the default today, on purpose: spelled out so it stays the budget view if the default moves.
  slo: { ...DEFAULT_SETUP },
  sla: { ...DEFAULT_SETUP, errorRate: 0.002, slowRate: 0, speed: 12 },
};

const SLO_OPTIONS = [0.99, 0.995, 0.999, 0.9995, 0.9999];
const SLA_OPTIONS = [0.99, 0.995, 0.999, 0.9995];
const SPEEDS = [2, 6, 12, 24];

const LAYOUT: Layout = {
  users: { x: 20, y: 24, w: 180, h: 96 },
  bots: { x: 20, y: 160, w: 180, h: 90 },
  lb: { x: 260, y: 60, w: 190, h: 110 },
  api: { x: 500, y: 60, w: 190, h: 110 },
  db: { x: 750, y: 60, w: 190, h: 100 },
  sli: { x: 240, y: 300, w: 256, h: 136 },
  slo: { x: 530, y: 262, w: 200, h: 130 },
  sla: { x: 530, y: 420, w: 200, h: 112 },
  oncall: { x: 780, y: 262, w: 160, h: 100 },
  customer: { x: 780, y: 420, w: 160, h: 100 },
};

/** Particles a second, for the animation only: the counters use every request. */
const USER_DOTS_PER_SEC = 5;
const BOT_DOTS_PER_SEC = 1.2;
/**
 * Faults of 0.1% would almost never show as a dot, so the animation draws a
 * faulty request this many times more often than it happens (the legend says so).
 * The counters, the SLI and every number on the page use the real shares.
 */
const DOT_FAULT_BOOST = 10;
const boosted = (share: number) => Math.min(share * DOT_FAULT_BOOST, 0.9);

const pct = (value: number, digits = 2) => `${(value * 100).toFixed(digits)}%`;
const target = (value: number) => `${+(value * 100).toFixed(2)}%`;
/** A target without the percent sign, for the narrow option chips. */
const chip = (value: number) => `${+(value * 100).toFixed(2)}`;

interface Sim {
  model: SloState;
  particles: Particle[];
  userDebt: number;
  botDebt: number;
  flowDebt: number;
}

const createSim = (): Sim => ({ model: createSloState(), particles: [], userDebt: 0, botDebt: 0, flowDebt: 0 });

export function SloLab({ focus }: LabProps<'slo'>) {
  // The page keys this lab by Concept, so the focus never changes under a mounted lab.
  const start = focus ? FOCUS_SETUPS[focus] : DEFAULT_SETUP;
  // Every control lives in one object, so Reset cannot miss one.
  const { setup, setSetup, change } = useLabSetup(start);
  const { good, point, countSynthetic, slo, sla, errorRate, slowRate, dropRate, speed } = setup;

  const [running, setRunning] = useLabRunning();
  const sim = useRef<Sim>(createSim());
  const rerender = useRerender(30);
  const { events, log, clear } = useEventLog();

  const sliDef = { good, point, countSynthetic };
  const faults = { errorRate, slowRate, dropRate };
  const targets = { slo, sla };

  useTicker(running, (dt) => {
    const state = sim.current;
    const model = state.model;
    advance(model, dt * speed * 60, sliDef, faults, targets, log);

    // Animation: a sample of the traffic, with faults drawn DOT_FAULT_BOOST times more often.
    const err = currentErrorRate(model, faults);
    state.userDebt += dt * USER_DOTS_PER_SEC;
    while (state.userDebt >= 1) {
      state.userDebt -= 1;
      const roll = Math.random();
      let route = ['users', 'lb', 'api', 'db'];
      let outcome: RequestOutcome = 'success';
      let fate: 'dropped' | 'failed' | 'slow' | 'ok' = 'ok';
      if (roll < boosted(dropRate)) {
        route = ['users', 'lb'];
        outcome = 'failure';
        fate = 'dropped';
      } else if (Math.random() < boosted(err)) {
        route = ['users', 'lb', 'api'];
        outcome = 'failure';
        fate = 'failed';
      } else if (Math.random() < boosted(slowRate)) {
        outcome = 'warning';
        fate = 'slow';
      }
      state.particles.push({ id: nextParticleId(), route, leg: 0, t: 0, speed: 1.5, outcome, meta: { fate } });
    }
    state.botDebt += dt * BOT_DOTS_PER_SEC;
    while (state.botDebt >= 1) {
      state.botDebt -= 1;
      state.particles.push({
        id: nextParticleId(),
        route: ['bots', 'lb', 'api'],
        leg: 0,
        t: 0,
        speed: 1.5,
        outcome: 'success',
        meta: { fate: 'bot' },
      });
    }

    // The counters downstream of the SLI: a steady trickle, plus alert and credit dots while they apply.
    state.flowDebt += dt * 1.2;
    const alerts = alertState(model, slo);
    const creditOwed = creditPct(1 - spentMinutes(model) / MONTH_MIN, sla) > 0;
    while (state.flowDebt >= 1) {
      state.flowDebt -= 1;
      state.particles.push({ id: nextParticleId(), route: ['sli', 'slo'], leg: 0, t: 0, speed: 1.2, outcome: 'success' });
      state.particles.push({ id: nextParticleId(), route: ['sli', 'sla'], leg: 0, t: 0, speed: 1.2, outcome: 'success' });
      if (alerts.page || alerts.ticket) {
        state.particles.push({
          id: nextParticleId(),
          route: ['slo', 'oncall'],
          leg: 0,
          t: 0,
          speed: 1.2,
          outcome: alerts.page ? 'failure' : 'warning',
        });
      }
      if (creditOwed) {
        state.particles.push({ id: nextParticleId(), route: ['sla', 'customer'], leg: 0, t: 0, speed: 1.2, outcome: 'failure' });
      }
    }

    const { alive, finished } = advanceParticles(state.particles, dt);
    // Each request that finishes is counted by the SLI - if the SLI can see it.
    for (const particle of finished) {
      const fate = particle.meta?.fate as string | undefined;
      if (!fate) continue;
      if (fate === 'bot' && !countSynthetic) continue;
      if (fate === 'dropped' && point === 'server') continue;
      const bad = fate === 'dropped' || fate === 'failed' || (fate === 'slow' && good === 'status-latency');
      alive.push({
        id: nextParticleId(),
        route: [point === 'server' ? 'api' : 'lb', 'sli'],
        leg: 0,
        t: 0,
        speed: 1.4,
        outcome: bad ? 'failure' : 'success',
      });
    }
    state.particles = alive.slice(-110);
    rerender();
  });

  const badDeploy = useCallback(() => {
    const model = sim.current.model;
    model.incidentUntil = model.clock + INCIDENT_MIN;
    log(
      `Bad deploy: ${pct(INCIDENT_ERROR, 0)} of requests fail with a 5xx for ${INCIDENT_MIN / 60} simulated hours`,
      'danger',
    );
  }, [log]);

  const reset = () => {
    // Back to this Concept's starting setup, not the lab's global default.
    setSetup(start);
    sim.current = createSim();
    clear();
  };

  // Everything below is derived from the model on each (throttled) render.
  const model = sim.current.model;
  const elapsed = monthElapsed(model);
  const day = elapsed / 1440;
  const measured = 1 - ratio(model.monthBad, model.monthValid);
  const felt = 1 - ratio(model.userBad, model.userValid);
  const spent = spentMinutes(model);
  const budget = (1 - slo) * MONTH_MIN;
  const budgetLeft = budget - spent;
  const allowance = (1 - sla) * MONTH_MIN;
  const burn1h = burnRate(model, 60, slo);
  const alerts = alertState(model, slo);
  const credit = creditPct(1 - spent / MONTH_MIN, sla);
  const creditEuro = (MONTHLY_FEE * credit) / 100;
  const incident = incidentActive(model);
  const err = currentErrorRate(model, faults);
  const hasData = model.monthValid > 0;
  // The SLI flatters the service when users felt more than 0.1 points worse than it reports.
  const flattering = hasData && measured - felt > 0.001;

  const particleViews: ParticleView[] = sim.current.particles.map((particle) => ({
    id: particle.id,
    from: particle.route[particle.leg],
    to: particle.route[particle.leg + 1],
    t: particle.t,
    outcome: particle.outcome ?? 'success',
  }));

  const edges: DiagramEdge[] = [
    { from: 'users', to: 'lb', tone: 'brand', width: 2 },
    { from: 'bots', to: 'lb', tone: 'default' },
    { from: 'lb', to: 'api', tone: dropRate > 0 ? 'warn' : 'brand', width: 2 },
    { from: 'api', to: 'db', tone: slowRate > 0 ? 'warn' : 'default' },
    // The two places the SLI could be measured; only the chosen one feeds it.
    { from: 'lb', to: 'sli', tone: 'info', dashed: point !== 'load-balancer', faded: point !== 'load-balancer' },
    { from: 'api', to: 'sli', tone: 'info', dashed: point !== 'server', faded: point !== 'server' },
    { from: 'sli', to: 'slo', tone: 'brand' },
    { from: 'sli', to: 'sla', tone: 'violet' },
    { from: 'slo', to: 'oncall', tone: alerts.page ? 'danger' : alerts.ticket ? 'warn' : 'muted' },
    { from: 'sla', to: 'customer', tone: credit > 0 ? 'danger' : 'muted' },
  ];

  const sliSubtitle = `${good === 'status' ? 'non-5xx' : `non-5xx, < ${LATENCY_THRESHOLD_MS} ms`} at ${
    point === 'server' ? 'server' : 'load balancer'
  }`;

  return (
    <LabShell
      title="SLO Lab"
      description="Measure an SLI, set an SLO, spend its error budget and keep the SLA. A 30-day month runs in a couple of minutes."
      running={running}
      onRunningChange={setRunning}
      onReset={reset}
      events={events}
      legend={
        <div className="space-y-1.5">
          <ParticleLegend
            outcomes={[
              { outcome: 'success', label: 'Good request' },
              { outcome: 'warning', label: 'Slow request or ticket' },
              { outcome: 'failure', label: 'Failed request, page or credit' },
            ]}
          />
          <p className="text-[11px] text-faint">
            Dots are a sample of the traffic, with faulty requests drawn {DOT_FAULT_BOOST}x more often so you can see
            them. Dots into the SLI are what it counts: a request it cannot see sends none.
          </p>
        </div>
      }
      actions={
        <Button variant="primary" onClick={badDeploy} disabled={incident}>
          <Zap className="h-4 w-4" />
          Bad deploy
        </Button>
      }
      insight={<Insight>{insightText()}</Insight>}
      metrics={
        <>
          <MetricsPanel
            items={[
              {
                key: 'day',
                label: 'Month',
                value: `Day ${day.toFixed(1)}`,
                unit: `/ 30 (month ${model.month})`,
                hint: `A 30-day month at ${speed} simulated hours per real second.`,
              },
              {
                key: 'sli',
                label: 'SLI this month',
                value: hasData ? pct(measured, 3) : '-',
                tone: measured >= slo ? 'ok' : measured >= sla ? 'warn' : 'danger',
                hint: 'Good events over valid events, as the SLI defines them.',
                simulated: true,
              },
              {
                key: 'felt',
                label: 'What users felt',
                value: hasData ? pct(felt, 3) : '-',
                tone: flattering ? 'danger' : 'neutral',
                hint: `Real user requests that arrived, succeeded and took under ${LATENCY_THRESHOLD_MS} ms. No real system knows this number exactly - the lab does.`,
                simulated: true,
              },
              {
                key: 'budget',
                label: 'Error budget left',
                value: `${Math.max(budgetLeft, 0).toFixed(1)}`,
                unit: `of ${budget.toFixed(1)} min`,
                tone: budgetLeft <= 0 ? 'danger' : budgetLeft < budget * 0.25 ? 'warn' : 'ok',
                hint: '(1 - SLO) x 30 days, in minutes of full outage. Spent = bad share so far x minutes elapsed.',
                simulated: true,
              },
              {
                key: 'burn',
                label: 'Burn rate (1 h)',
                value: `${burn1h.toFixed(1)}x`,
                tone: burn1h >= 14.4 ? 'danger' : burn1h >= 1 ? 'warn' : 'ok',
                hint: 'Bad share over the last hour divided by the share the SLO allows. 1x spends the budget exactly by the end of the month.',
                simulated: true,
              },
              {
                key: 'credit',
                label: 'SLA credit owed',
                value: `${formatNumber(creditEuro)} euro`,
                unit: credit ? `${credit}% of fee` : undefined,
                tone: credit > 0 ? 'danger' : 'ok',
                hint: `Of a ${formatNumber(MONTHLY_FEE)} euro monthly fee. Tiers modelled on the Amazon EC2 SLA (10%, 30%, 100%), simplified.`,
                simulated: true,
              },
            ]}
          />
          <div className="card p-4">
            <p className="label mb-3">This month: budget left against time left</p>
            <LiveChart
              data={model.series}
              series={[
                { key: 'budget', label: 'Error budget left %', color: 'brand' },
                { key: 'sla', label: 'SLA allowance left %', color: 'violet' },
                { key: 'month', label: 'Month left %', color: 'faint', dashed: true },
              ]}
              variant="line"
              height={170}
              yDomain={[0, 100]}
            />
            <p className="mt-2 text-xs text-faint">
              While the budget line stays above the dashed line you are burning slower than 1x and will meet the SLO.
              Below it, the budget runs out before the month does. {SIMULATED_HINT} Constant traffic
              of {USER_RPS} user and {SYNTHETIC_RPS} bot requests a second, faults as fixed shares.
            </p>
          </div>
          {model.history.length ? (
            <div className="card p-4">
              <p className="label mb-3">Closed months</p>
              <ul className="space-y-1.5 font-mono text-[11px]">
                {model.history.map((result) => (
                  <li key={result.month} className="flex flex-wrap gap-x-3">
                    <span className="text-faint">Month {result.month}</span>
                    <span className="text-ink">SLI {pct(result.sli, 3)}</span>
                    <span className={result.sloMet ? 'text-ok' : 'text-warn'}>SLO {result.sloMet ? 'met' : 'missed'}</span>
                    <span className={result.slaMet ? 'text-ok' : 'text-danger'}>
                      SLA {result.slaMet ? 'met' : `broken, ${result.creditPct}% credit`}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      }
      controls={
        <>
          <Group title="Indicator (SLI)">
            <p className="text-xs font-medium text-muted">A good request is</p>
            <SegmentedControl
              size="sm"
              className="w-full"
              value={good}
              options={[
                { value: 'status', label: 'Non-5xx' },
                { value: 'status-latency', label: `Non-5xx, < ${LATENCY_THRESHOLD_MS} ms` },
              ]}
              onChange={change('good')}
            />
            <p className="text-xs font-medium text-muted">Measured at</p>
            <SegmentedControl
              size="sm"
              className="w-full"
              value={point}
              options={[
                { value: 'server', label: 'API server' },
                { value: 'load-balancer', label: 'Load balancer' },
              ]}
              onChange={change('point')}
            />
            <Toggle
              label="Count bots and probes as valid"
              checked={countSynthetic}
              onChange={change('countSynthetic')}
              description={`${SYNTHETIC_RPS} req/s that always get a fast 200`}
            />
          </Group>
          <Group title="Target (SLO, %)">
            <SegmentedControl
              size="sm"
              className="w-full"
              value={String(slo)}
              options={SLO_OPTIONS.map((value) => ({ value: String(value), label: chip(value) }))}
              onChange={(value) => change('slo')(Number(value))}
            />
            <p className="text-[11px] text-faint">
              Error budget: {budget.toFixed(1)} min of full outage per 30 days.
            </p>
          </Group>
          <Group title="Contract (SLA, %)">
            <SegmentedControl
              size="sm"
              className="w-full"
              value={String(sla)}
              options={SLA_OPTIONS.map((value) => ({ value: String(value), label: chip(value) }))}
              onChange={(value) => change('sla')(Number(value))}
            />
            <p className="text-[11px] text-faint">
              Allowance: {allowance.toFixed(1)} min per 30 days, judged on the same SLI. Credit below it.
            </p>
          </Group>
          <Group title="Faults">
            <Slider
              label="5xx errors at the server"
              value={errorRate}
              min={0}
              max={0.02}
              step={0.0001}
              onChange={change('errorRate')}
              format={(value) => pct(value)}
              tone="danger"
            />
            <Slider
              label={`Slow requests (> ${LATENCY_THRESHOLD_MS} ms)`}
              value={slowRate}
              min={0}
              max={0.03}
              step={0.0001}
              onChange={change('slowRate')}
              format={(value) => pct(value)}
              tone="warn"
            />
            <Slider
              label="Dropped by the load balancer"
              value={dropRate}
              min={0}
              max={0.01}
              step={0.0001}
              onChange={change('dropRate')}
              format={(value) => pct(value)}
              tone="warn"
              hint="The load balancer answers 502 and the server never sees the request."
            />
          </Group>
          <div className="space-y-2 border-t border-line pt-3">
            <p className="text-xs font-medium text-muted">Simulated hours per second</p>
            <SegmentedControl
              size="sm"
              className="w-full"
              value={String(speed)}
              options={SPEEDS.map((value) => ({ value: String(value), label: `${value} h` }))}
              onChange={(value) => change('speed')(Number(value))}
            />
          </div>
        </>
      }
    >
      <DiagramCanvas layout={LAYOUT} edges={edges} particles={particleViews} height={550} className="bg-canvas">
        <ArchNode kind="client" title="Users" subtitle={`${USER_RPS} req/s`} placed={LAYOUT.users} compact>
          <NodeStatRow label="Felt good" value={hasData ? pct(felt, 2) : '-'} tone={flattering ? 'text-danger' : 'text-ink'} />
        </ArchNode>
        <ArchNode
          kind="client"
          title="Bots + probes"
          subtitle={`${SYNTHETIC_RPS} req/s, always 200`}
          placed={LAYOUT.bots}
          status={countSynthetic ? 'healthy' : 'starting'}
          statusLabel={countSynthetic ? 'Counted' : 'Excluded'}
          compact
        />
        <ArchNode
          kind="load-balancer"
          title="Load balancer"
          subtitle={point === 'load-balancer' ? 'SLI measured here' : 'access log'}
          placed={LAYOUT.lb}
          status={dropRate > 0 ? 'degraded' : 'healthy'}
          selected={point === 'load-balancer'}
          compact
        >
          <NodeStatRow label="Dropped (502)" value={pct(dropRate)} tone={dropRate > 0 ? 'text-warn' : 'text-ok'} />
        </ArchNode>
        <ArchNode
          kind="server"
          title="API service"
          subtitle={point === 'server' ? 'SLI measured here' : 'application log'}
          placed={LAYOUT.api}
          status={err > 0.01 ? 'degraded' : 'healthy'}
          alert={incident}
          selected={point === 'server'}
          compact
        >
          <NodeStatRow label={incident ? '5xx (bad deploy)' : '5xx'} value={pct(err)} tone={err > 0 ? 'text-danger' : 'text-ok'} />
        </ArchNode>
        <ArchNode kind="sql" title="Database" subtitle="behind every request" placed={LAYOUT.db} compact>
          <NodeStatRow label={`Over ${LATENCY_THRESHOLD_MS} ms`} value={pct(slowRate)} tone={slowRate > 0 ? 'text-warn' : 'text-ok'} />
        </ArchNode>
        <ArchNode kind="monitoring" title="SLI" subtitle={sliSubtitle} placed={LAYOUT.sli} compact>
          <NodeStatRow label="Good / valid" value={hasData ? pct(measured, 3) : '-'} tone={flattering ? 'text-warn' : 'text-ink'} />
          <NodeStatRow label="Users felt" value={hasData ? pct(felt, 3) : '-'} />
        </ArchNode>
        <ArchNode
          kind="monitoring"
          title={`SLO ${target(slo)}`}
          subtitle="30-day error budget"
          placed={LAYOUT.slo}
          status={budgetLeft <= 0 ? 'down' : budgetLeft < budget * 0.25 ? 'degraded' : 'healthy'}
          statusLabel={budgetLeft <= 0 ? 'Budget spent' : undefined}
          compact
        >
          <Meter label="Budget left" value={Math.max(budgetLeft, 0) / budget} tone={budgetLeft < budget * 0.25 ? 'danger' : 'ok'} />
          <NodeStatRow label="Burn (1 h)" value={`${burn1h.toFixed(1)}x`} tone={burn1h >= 14.4 ? 'text-danger' : 'text-ink'} />
        </ArchNode>
        <ArchNode
          kind="api-gateway"
          title={`SLA ${target(sla)}`}
          subtitle="contract, judged monthly"
          placed={LAYOUT.sla}
          status={credit > 0 ? 'down' : spent > allowance * 0.5 ? 'degraded' : 'healthy'}
          statusLabel={credit > 0 ? 'Breached' : 'Met so far'}
          compact
        >
          <NodeStatRow label="Allowance used" value={`${spent.toFixed(0)} / ${allowance.toFixed(0)} min`} />
        </ArchNode>
        <ArchNode
          kind="client"
          title="On-call"
          subtitle="burn-rate alerts"
          placed={LAYOUT.oncall}
          status={alerts.page ? 'down' : alerts.ticket ? 'degraded' : 'healthy'}
          statusLabel={alerts.page ? 'Paged' : alerts.ticket ? 'Ticket' : 'Quiet'}
          alert={alerts.page}
          compact
        />
        <ArchNode
          kind="client"
          title="Customer"
          subtitle={`${formatNumber(MONTHLY_FEE)} euro / month`}
          placed={LAYOUT.customer}
          status={credit > 0 ? 'degraded' : 'healthy'}
          statusLabel={credit > 0 ? `${credit}% credit` : 'No credit'}
          compact
        />
      </DiagramCanvas>
    </LabShell>
  );

  function insightText(): ReactNode {
    const slaHint = `The SLA allows ${allowance.toFixed(0)} minutes, so the contract is safe for now: raise the 5xx rate above ${pct(
      1 - sla,
      1,
    )} and it breaks too.`;
    if (!hasData) return 'Press Run simulation to start the month.';
    if (flattering) {
      const causes: string[] = [];
      if (point === 'server' && dropRate > 0)
        causes.push(`the load balancer drops ${pct(dropRate)} of requests before they reach the server, so the server never counts them`);
      if (good === 'status' && slowRate > 0)
        causes.push(`${pct(slowRate)} of requests take over ${LATENCY_THRESHOLD_MS} ms and still count as good, because only the status is checked`);
      if (countSynthetic) causes.push(`${SYNTHETIC_RPS} bot and probe requests a second always succeed and pad the valid count`);
      return (
        <>
          The SLI reads {pct(measured, 3)}, but users felt {pct(felt, 3)}: {causes.join('; ')}. The SLO, the alerts and
          the SLA all read this one number, so all three are wrong in the same direction. Change what counts as good,
          where it is measured, and what counts as valid, until the two numbers meet.
        </>
      );
    }
    if (sla >= slo) {
      return (
        <>
          The SLA ({target(sla)}) is {sla === slo ? 'equal to' : 'stricter than'} the SLO ({target(slo)}). There is no
          gap between the internal alarm and the contract, so the first missed target is also the first service credit.
          Keep the SLA below the SLO - that gap is your reaction time.
        </>
      );
    }
    if (alerts.page) {
      return (
        <>
          Paged: the budget is burning at {burn1h.toFixed(0)}x over the last hour (rule {alerts.rule?.label}). At that
          speed a whole month of budget lasts {formatHours((30 * 24) / Math.max(burn1h, 1e-6))}. A brief blip would not
          page - both the long and the short window must burn fast, so the alert means a real, ongoing problem.
        </>
      );
    }
    if (credit > 0) {
      return (
        <>
          The SLA is broken: {spent.toFixed(0)} minutes of the {allowance.toFixed(0)} the contract allows are gone, so the
          customer is owed {credit}% of the fee, {formatNumber(creditEuro)} euro. Compare that to the real cost of the
          outage to the customer - a credit is a signal, not insurance.
        </>
      );
    }
    if (budgetLeft <= 0) {
      return (
        <>
          The error budget is spent on day {day.toFixed(1)}: the SLO of {target(slo)} will be missed this month. By the
          budget policy, risky launches stop and reliability work comes first. The SLA still holds ({spent.toFixed(0)} of{' '}
          {allowance.toFixed(0)} minutes used) - that buffer is why the contract sits below the internal target.{' '}
          {slaHint}
        </>
      );
    }
    if (alerts.ticket) {
      return (
        <>
          A ticket, not a page: the budget has burned at more than 1x over three days, so it will run out before the month
          ends, but slowly enough for working hours. {budgetLeft.toFixed(1)} of {budget.toFixed(1)} minutes are left.{' '}
          {slaHint}
        </>
      );
    }
    if (focus === 'sli') {
      return (
        <>
          The SLI now agrees with what users felt ({pct(felt, 3)}). Most arguments about reliability are about this
          definition: what counts as good, what counts as valid, and where it is measured.
        </>
      );
    }
    if (focus === 'sla') {
      return (
        <>
          The SLO of {target(slo)} allows {budget.toFixed(1)} minutes a month and the SLA of {target(sla)} allows{' '}
          {allowance.toFixed(0)}. At a steady {burn1h.toFixed(1)}x burn the SLO will be missed while the SLA holds. Raise
          the 5xx rate above {pct(1 - sla, 1)} and the contract breaks too - or set the SLA equal to the SLO and watch
          the first internal miss become a credit.
        </>
      );
    }
    return (
      <>
        {target(slo)} over 30 days leaves {budget.toFixed(1)} minutes of failure to spend; {budgetLeft.toFixed(1)} are
        left, burning at {burn1h.toFixed(1)}x. Press Bad deploy to spend a chunk of it at once and watch the page fire, or
        move the SLO to see how fast each extra nine shrinks the budget.
      </>
    );
  }
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-2 border-t border-line pt-3 first:border-t-0 first:pt-0">
      <p className="label">{title}</p>
      {children}
    </div>
  );
}

export default SloLab;
