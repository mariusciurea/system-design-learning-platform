import { useCallback, useRef } from 'react';
import { ShieldAlert, ShieldCheck } from 'lucide-react';
import { ArchNode, DiagramCanvas, NodeStatRow, ParticleLegend, type DiagramEdge, type Layout, type ParticleView } from '@/components/architecture';
import { Insight, LabShell, MetricsPanel, SIMULATED_HINT } from '@/components/learning';
import { Badge, Button, Meter, Slider, Toggle } from '@/components/ui';
import {
  advanceParticles,
  MetricWindow,
  nextParticleId,
  useEventLog,
  useTicker,
  type Particle,
} from '@/simulations/engine';
import { useLabSetup } from '@/hooks/useLabSetup';
import { useRerender } from '@/hooks/useRerender';
import { sampleArrivals } from '@/utils/math';
import { LATENCY_TEXT, formatLatency, formatNumber, formatPercent, latencyTone } from '@/utils/format';
import { cn } from '@/utils/cn';
import { useLabRunning } from '@/hooks/useLabRunning';

type BreakerState = 'closed' | 'open' | 'half-open';

const STATE_META: Record<BreakerState, { label: string; tone: 'ok' | 'danger' | 'warn'; note: string }> = {
  closed: {
    label: 'CLOSED',
    tone: 'ok',
    note: 'Calls pass through to the dependency while failures are counted over a rolling window.',
  },
  open: {
    label: 'OPEN',
    tone: 'danger',
    note: 'The threshold was crossed. Calls fail immediately with the fallback - no network call is made, so the caller keeps its threads and the dependency gets room to recover.',
  },
  'half-open': {
    label: 'HALF-OPEN',
    tone: 'warn',
    note: 'The cooldown elapsed. A limited number of trial calls are allowed through to test whether the dependency recovered.',
  },
};

interface CallRecord {
  id: number;
  result: 'ok' | 'fail' | 'short-circuit';
}

interface State {
  breaker: BreakerState;
  window: boolean[];
  openedAt: number;
  trials: number;
  trialSuccesses: number;
  particles: Particle[];
  calls: CallRecord[];
  passed: number;
  failed: number;
  shortCircuited: number;
  /**
   * Rolling. The whole point is that opening the breaker replaces a `timeout`
   * wait with a 2 ms fallback, and a lifetime average hides that for minutes.
   */
  latency: MetricWindow;
  transitions: number;
  /**
   * Bumped on every entry to HALF-OPEN. A trial call carries the epoch it was
   * sent in, so a trial still in flight after the breaker moved on is counted
   * but can no longer flip the state.
   */
  halfOpenEpoch: number;
  /**
   * Trial calls in flight, keyed by particle id. The result is applied when the
   * particle reaches the dependency, so it is kept here rather than on the particle.
   */
  trialCalls: Map<number, TrialCall>;
}

interface TrialCall {
  failed: boolean;
  /** The `halfOpenEpoch` the trial was sent in. */
  epoch: number;
}

/** Newest-first call history shown under the diagram. */
const CALL_HISTORY = 40;

const recordCall = (state: State, result: CallRecord['result']) => {
  state.calls.unshift({ id: nextParticleId(), result });
  if (state.calls.length > CALL_HISTORY) state.calls.length = CALL_HISTORY;
};

const createState = (): State => ({
  breaker: 'closed',
  window: [],
  openedAt: 0,
  trials: 0,
  trialSuccesses: 0,
  particles: [],
  calls: [],
  passed: 0,
  failed: 0,
  shortCircuited: 0,
  latency: new MetricWindow(300),
  transitions: 0,
  halfOpenEpoch: 0,
  trialCalls: new Map(),
});

/**
 * The right column is 195 wide, so "cached / default response" fits under Fallback, and
 * sits 70px from the breaker, so the "blocked" and "fallback" edge labels land between
 * the boxes instead of behind them.
 */
const LAYOUT: Layout = {
  client: { x: 20, y: 200, w: 160, h: 84 },
  api: { x: 220, y: 190, w: 180, h: 104 },
  breaker: { x: 435, y: 173, w: 250, h: 138 },
  payment: { x: 755, y: 90, w: 195, h: 128 },
  fallback: { x: 755, y: 300, w: 195, h: 96 },
};

const WINDOW_SIZE = 20;
const TRIAL_CALLS = 3;

interface Setup {
  /** Share of calls the payment service fails, 0..1. */
  failureRate: number;
  /** Failure ratio over the window, in percent, that opens the circuit. */
  threshold: number;
  /** Seconds the circuit stays open before it probes. */
  cooldown: number;
  /** Milliseconds a failing call costs when nothing short-circuits it. */
  timeout: number;
  breakerEnabled: boolean;
  /** Calls per second from the client. */
  requestRate: number;
}

/** What the Lab opens on, and what Reset goes back to. */
const DEFAULT_SETUP: Setup = {
  failureRate: 0.1,
  threshold: 50,
  cooldown: 6,
  timeout: 2000,
  breakerEnabled: true,
  requestRate: 10,
};

export function CircuitBreakerLab() {
  // Every control lives in one object, so Reset cannot miss one.
  const { setup, setSetup, change } = useLabSetup(DEFAULT_SETUP);
  const { failureRate, threshold, cooldown, timeout, breakerEnabled, requestRate } = setup;
  const [running, setRunning] = useLabRunning();

  const state = useRef<State>(createState());
  const rerender = useRerender(30);
  const { events, log, clear } = useEventLog(50);

  const reset = useCallback(() => {
    setSetup(DEFAULT_SETUP);
    state.current = createState();
    clear();
  }, [clear, setSetup]);

  const transition = useCallback(
    (next: BreakerState, reason: string) => {
      const current = state.current;
      if (current.breaker === next) return;
      current.breaker = next;
      current.transitions += 1;
      if (next === 'open') {
        current.openedAt = performance.now();
        current.window = [];
      }
      if (next === 'half-open') {
        current.halfOpenEpoch += 1;
        current.trials = 0;
        current.trialSuccesses = 0;
      }
      if (next === 'closed') current.window = [];
      log(`Circuit ${STATE_META[next].label}: ${reason}`, next === 'closed' ? 'ok' : next === 'open' ? 'danger' : 'warn');
    },
    [log],
  );

  useTicker(running, (dt) => {
    const current = state.current;
    const now = performance.now();

    /** Counts one call that reached the dependency. */
    const record = (failed: boolean) => {
      if (failed) {
        current.failed += 1;
        current.latency.push(timeout, now);
        recordCall(current, 'fail');
      } else {
        current.passed += 1;
        current.latency.push(60, now);
        recordCall(current, 'ok');
      }
      current.window.push(!failed);
      if (current.window.length > WINDOW_SIZE) current.window.shift();
    };

    if (breakerEnabled && current.breaker === 'open' && now - current.openedAt >= cooldown * 1000) {
      transition('half-open', `cooldown of ${cooldown}s elapsed, sending ${TRIAL_CALLS} trial calls`);
    }

    const arrivals = sampleArrivals(requestRate, dt);
    for (let index = 0; index < arrivals; index += 1) {
      const shortCircuit = breakerEnabled && current.breaker === 'open';

      if (shortCircuit) {
        current.shortCircuited += 1;
        current.latency.push(2, now);
        recordCall(current, 'short-circuit');
        current.particles.push({
          id: nextParticleId(),
          route: ['client', 'api', 'breaker', 'fallback'],
          leg: 0,
          t: 0,
          speed: 1.6,
          outcome: 'warning',
        });
        continue;
      }

      if (breakerEnabled && current.breaker === 'half-open' && current.trials >= TRIAL_CALLS) {
        current.shortCircuited += 1;
        current.latency.push(2, now);
        recordCall(current, 'short-circuit');
        current.particles.push({
          id: nextParticleId(),
          route: ['client', 'api', 'breaker', 'fallback'],
          leg: 0,
          t: 0,
          speed: 1.6,
          outcome: 'warning',
        });
        continue;
      }

      const failed = Math.random() < failureRate;

      if (breakerEnabled && current.breaker === 'half-open') {
        // A trial call. Its result is applied when its particle reaches the
        // Payment Service, so HALF-OPEN stays on screen while the probe travels.
        current.trials += 1;
        const id = nextParticleId();
        current.trialCalls.set(id, { failed, epoch: current.halfOpenEpoch });
        current.particles.push({
          id,
          route: ['client', 'api', 'breaker', 'payment'],
          leg: 0,
          t: 0,
          speed: 1.2,
          outcome: failed ? 'failure' : 'success',
        });
        continue;
      }

      record(failed);

      current.particles.push({
        id: nextParticleId(),
        route: ['client', 'api', 'breaker', 'payment'],
        leg: 0,
        t: 0,
        speed: 1.2,
        outcome: failed ? 'failure' : 'success',
      });

      if (breakerEnabled) {
        if (current.breaker === 'closed' && current.window.length >= 10) {
          const failures = current.window.filter((ok) => !ok).length;
          const ratio = failures / current.window.length;
          if (ratio * 100 >= threshold) {
            transition('open', `${failures}/${current.window.length} calls failed (${Math.round(ratio * 100)}% >= ${threshold}%)`);
          }
        }
      }
    }

    const { alive, finished } = advanceParticles(current.particles, dt);
    for (const particle of finished) {
      const trial = current.trialCalls.get(particle.id);
      if (!trial) continue;
      current.trialCalls.delete(particle.id);
      record(trial.failed);
      if (!breakerEnabled || current.breaker !== 'half-open' || trial.epoch !== current.halfOpenEpoch) continue;
      if (trial.failed) {
        transition('open', 'trial call failed - back to open, cooldown restarts');
      } else {
        current.trialSuccesses += 1;
        if (current.trialSuccesses >= TRIAL_CALLS) transition('closed', `${TRIAL_CALLS} trial calls succeeded`);
      }
    }
    // Trial calls are never evicted by the particle cap: the state machine waits for them.
    const isTrial = (particle: Particle) => current.trialCalls.has(particle.id);
    const trials = alive.filter(isTrial);
    const others = alive.filter((particle) => !isTrial(particle));
    current.particles = [...others.slice(-Math.max(0, 60 - trials.length)), ...trials];
    rerender();
  });

  const current = state.current;
  const total = current.passed + current.failed + current.shortCircuited;
  // Null when no call landed in the MetricWindow horizon (lab paused, or traffic at 0): shown as a dash.
  const avgLatency = current.latency.snapshot(performance.now()).avg;
  const windowFailures = current.window.filter((ok) => !ok).length;
  const windowRatio = current.window.length ? windowFailures / current.window.length : 0;
  const meta = STATE_META[breakerEnabled ? current.breaker : 'closed'];
  const cooldownLeft = current.breaker === 'open' ? Math.max(0, cooldown * 1000 - (performance.now() - current.openedAt)) : 0;

  const edges: DiagramEdge[] = [
    { from: 'client', to: 'api', tone: 'brand', width: 2 },
    { from: 'api', to: 'breaker', tone: 'brand' },
    {
      from: 'breaker',
      to: 'payment',
      tone: current.breaker === 'open' && breakerEnabled ? 'muted' : 'ok',
      dashed: current.breaker === 'open' && breakerEnabled,
      label: current.breaker === 'open' && breakerEnabled ? 'blocked' : undefined,
    },
    {
      from: 'breaker',
      to: 'fallback',
      tone: current.breaker === 'closed' || !breakerEnabled ? 'muted' : 'warn',
      dashed: current.breaker === 'closed' || !breakerEnabled,
      label: 'fallback',
    },
  ];

  const particleViews: ParticleView[] = current.particles.map((particle) => ({
    id: particle.id,
    from: particle.route[particle.leg],
    to: particle.route[particle.leg + 1],
    t: particle.t,
    outcome: particle.outcome ?? 'success',
  }));

  return (
    <LabShell
      title="Circuit Breaker Lab"
      description="Raise the downstream failure rate and watch the breaker trip, cool down, probe with trial calls, and either close or reopen."
      running={running}
      onRunningChange={setRunning}
      onReset={reset}
      legend={
        <ParticleLegend
          outcomes={[
            { outcome: 'success', label: 'Successful call' },
            { outcome: 'failure', label: 'Failed call' },
            { outcome: 'warning', label: 'Short-circuited to the fallback' },
          ]}
        />
      }
      events={events}
      actions={
        <>
          <Button
            variant="danger"
            onClick={() => {
              change('failureRate')(0.9);
              log('Injected an outage in the payment service (90% failures)', 'danger');
            }}
          >
            <ShieldAlert className="h-4 w-4" />
            Break the dependency
          </Button>
          <Button
            variant="success"
            onClick={() => {
              change('failureRate')(0.02);
              log('Payment service recovered (2% failures)', 'ok');
            }}
          >
            <ShieldCheck className="h-4 w-4" />
            Recover it
          </Button>
        </>
      }
      insight={
        <Insight title={`Circuit ${meta.label}`}>
          {meta.note}{' '}
          {!breakerEnabled && failureRate > 0.5 ? (
            <>
              With the breaker disabled, every call waits the full {formatLatency(timeout)} timeout before failing.
              Threads and connections pile up in the caller - this is how one broken dependency takes down a healthy
              service.
            </>
          ) : current.breaker === 'open' ? (
            <>Cooldown remaining: {(cooldownLeft / 1000).toFixed(1)}s. Failing here costs about 2 ms instead of {formatLatency(timeout)}.</>
          ) : null}
        </Insight>
      }
      metrics={
        <>
          <MetricsPanel
            items={[
              { key: 'state', label: 'Breaker state', value: meta.label, tone: meta.tone, hint: 'Closed passes calls, open rejects them, half-open probes.' },
              { key: 'passed', label: 'Succeeded', value: formatNumber(current.passed), tone: 'ok' },
              { key: 'failed', label: 'Failed calls', value: formatNumber(current.failed), tone: current.failed > 0 ? 'danger' : 'neutral' },
              {
                key: 'shortCircuited',
                label: 'Short-circuited',
                value: formatNumber(current.shortCircuited),
                tone: 'warn',
                hint: 'Calls rejected instantly by the breaker, without touching the dependency.',
              },
              {
                key: 'latency',
                label: 'Avg latency',
                value: formatLatency(avgLatency),
                tone: latencyTone(avgLatency, 800),
                hint: 'A success costs 60 ms, a failure the full call timeout, a short-circuit 2 ms. Failing fast is what keeps this number low during an outage.',
                simulated: true,
              },
              { key: 'transitions', label: 'State changes', value: formatNumber(current.transitions) },
            ]}
          />

          <div className="card p-4">
            <p className="label mb-3">State machine</p>
            <div className="flex flex-wrap items-center gap-2 font-mono text-[11px]">
              {(['closed', 'open', 'half-open'] as BreakerState[]).map((value, index) => (
                <span key={value} className="flex items-center gap-2">
                  <span
                    className={cn(
                      'rounded-lg border px-3 py-1.5',
                      current.breaker === value && breakerEnabled
                        ? value === 'closed'
                          ? 'border-ok bg-ok/10 text-ok'
                          : value === 'open'
                            ? 'border-danger bg-danger/10 text-danger'
                            : 'border-warn bg-warn/10 text-warn'
                        : 'border-line text-faint',
                    )}
                  >
                    {STATE_META[value].label}
                  </span>
                  {index < 2 ? <span className="text-faint">{'->'}</span> : null}
                </span>
              ))}
            </div>
            <p className="mt-3 text-xs text-muted">
              CLOSED {'->'} OPEN when the failure ratio crosses {threshold}%. OPEN {'->'} HALF-OPEN after {cooldown}s.
              HALF-OPEN {'->'} CLOSED after {TRIAL_CALLS} successful trials, or straight back to OPEN on a single failure.
            </p>

            <p className="label mb-2 mt-4">Recent calls (newest first)</p>
            <div className="flex flex-wrap gap-1">
              {current.calls.length === 0 ? (
                <span className="text-xs text-faint">No calls yet.</span>
              ) : (
                current.calls.map((call) => <CallGlyph key={call.id} result={call.result} />)
              )}
            </div>
            <div className="mt-2 flex gap-4 text-[11px] text-faint">
              <span className="flex items-center gap-1">
                <CallGlyph result="ok" /> success
              </span>
              <span className="flex items-center gap-1">
                <CallGlyph result="fail" /> failure
              </span>
              <span className="flex items-center gap-1">
                <CallGlyph result="short-circuit" /> short-circuited
              </span>
            </div>
          </div>
        </>
      }
      controls={
        <>
          <Toggle
            label="Circuit breaker"
            checked={breakerEnabled}
            onChange={(value) => {
              change('breakerEnabled')(value);
              if (!value) {
                // A disabled breaker has no state. Without this an OPEN breaker kept
                // its cooldown running in the background and came back OPEN.
                const current = state.current;
                current.breaker = 'closed';
                current.window = [];
                current.trials = 0;
                current.trialSuccesses = 0;
                current.halfOpenEpoch += 1;
              }
              log(
                value ? 'Circuit breaker enabled - starts CLOSED' : 'Circuit breaker disabled - every call goes to the dependency',
                'info',
              );
            }}
            description="Off: every failing call waits for the timeout"
          />
          <Slider
            label="Downstream failure rate"
            value={failureRate}
            min={0}
            max={1}
            step={0.01}
            onChange={change('failureRate')}
            format={(value) => formatPercent(value)}
            tone={failureRate > 0.5 ? 'danger' : 'warn'}
            hint="How often the payment service currently fails."
          />
          <Slider
            label="Trip threshold"
            value={threshold}
            min={10}
            max={90}
            step={5}
            onChange={change('threshold')}
            format={(value) => `${value}% failures`}
            hint="Failure ratio over the last 20 calls that opens the circuit."
          />
          <Slider
            label="Cooldown"
            value={cooldown}
            min={1}
            max={30}
            onChange={change('cooldown')}
            format={(value) => `${value} s`}
            hint="How long the circuit stays open before probing."
          />
          <Slider
            label="Call timeout"
            value={timeout}
            min={200}
            max={10000}
            step={100}
            onChange={change('timeout')}
            format={(value) => formatLatency(value)}
            hint="What a failing call costs when the breaker is not protecting you."
          />
          <Slider
            label="Request rate"
            value={requestRate}
            min={1}
            max={60}
            onChange={change('requestRate')}
            format={(value) => `${value} req/sec`}
          />
          <div className="border-t border-line pt-4">
            <p className="label mb-2">Rolling window</p>
            <Meter
              value={windowRatio}
              threshold={threshold / 100}
              label={`${windowFailures}/${current.window.length} failed`}
              tone={windowRatio * 100 >= threshold ? 'danger' : 'ok'}
            />
            {current.breaker === 'open' ? (
              <p className="mt-2 font-mono text-[11px] text-warn">
                cooldown {(cooldownLeft / 1000).toFixed(1)}s remaining
              </p>
            ) : null}
          </div>
        </>
      }
    >
      <DiagramCanvas layout={LAYOUT} edges={edges} particles={particleViews} height={480} className="bg-canvas">
        <ArchNode kind="client" title="Client" subtitle={`${requestRate} req/sec`} placed={LAYOUT.client} compact />
        <ArchNode kind="server" title="API Service" subtitle="the caller" placed={LAYOUT.api} compact>
          <NodeStatRow label="Avg latency" value={formatLatency(avgLatency)} tone={LATENCY_TEXT[latencyTone(avgLatency, 800)]} />
        </ArchNode>
        <ArchNode
          kind="api-gateway"
          title="Circuit Breaker"
          subtitle={breakerEnabled ? `threshold ${threshold}%` : 'disabled'}
          placed={LAYOUT.breaker}
          status={!breakerEnabled ? 'down' : current.breaker === 'open' ? 'degraded' : 'healthy'}
          alert={current.breaker === 'half-open'}
          badge={<Badge tone={meta.tone}>{meta.label}</Badge>}
        >
          <NodeStatRow label="Window" value={`${windowFailures}/${current.window.length}`} />
          <NodeStatRow label="Short-circuit" value={formatNumber(current.shortCircuited)} tone="text-warn" />
        </ArchNode>
        <ArchNode
          kind="service"
          title="Payment Service"
          subtitle="the dependency"
          placed={LAYOUT.payment}
          status={failureRate > 0.5 ? 'down' : failureRate > 0.15 ? 'degraded' : 'healthy'}
        >
          <NodeStatRow label="Failing" value={formatPercent(failureRate)} tone={failureRate > 0.3 ? 'text-danger' : 'text-ok'} />
          <NodeStatRow label="Timeout" value={formatLatency(timeout)} />
        </ArchNode>
        <ArchNode kind="cache" title="Fallback" subtitle="cached / default response" placed={LAYOUT.fallback} compact>
          <NodeStatRow label="Served" value={formatNumber(current.shortCircuited)} />
        </ArchNode>
      </DiagramCanvas>
      <p className="px-4 pb-3 pt-1 text-[11px] text-faint">
        Total calls: {formatNumber(total)} - a breaker without a meaningful fallback only moves the error, it does not
        remove it. {SIMULATED_HINT}
      </p>
    </LabShell>
  );
}

/** The words for a call result, as the legend under the strip spells them. */
const CALL_NAME: Record<CallRecord['result'], string> = {
  ok: 'success',
  fail: 'failure',
  'short-circuit': 'short-circuited',
};

/**
 * One call in the recent-calls strip. The shapes match the particle legend
 * (circle, cross, triangle), so the result is never carried by colour alone.
 */
function CallGlyph({ result }: { result: CallRecord['result'] }) {
  return (
    <svg
      width={12}
      height={12}
      viewBox="-6 -6 12 12"
      role="img"
      aria-label={CALL_NAME[result]}
      className={cn(result === 'ok' ? 'text-ok' : result === 'fail' ? 'text-danger' : 'text-warn')}
    >
      <title>{CALL_NAME[result]}</title>
      {result === 'ok' ? (
        <circle r={4.5} fill="currentColor" />
      ) : result === 'fail' ? (
        <g stroke="currentColor" strokeWidth={2.2} strokeLinecap="round">
          <line x1={-4} y1={-4} x2={4} y2={4} />
          <line x1={-4} y1={4} x2={4} y2={-4} />
        </g>
      ) : (
        <polygon points="0,-5 5,4 -5,4" fill="currentColor" />
      )}
    </svg>
  );
}

export default CircuitBreakerLab;
