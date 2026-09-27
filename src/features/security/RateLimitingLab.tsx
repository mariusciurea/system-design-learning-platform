import { useCallback, useRef } from 'react';
import { ArchNode, DiagramCanvas, NodeStatRow, ParticleLegend, type DiagramEdge, type Layout, type ParticleView } from '@/components/architecture';
import { LiveChart } from '@/components/charts';
import { Insight, LabShell, MetricsPanel } from '@/components/learning';
import { Button, Slider } from '@/components/ui';
import { advanceParticles, nextParticleId, RateCounter, useEventLog, useSeries, useTicker, type Particle } from '@/simulations/engine';
import { useLabSetup } from '@/hooks/useLabSetup';
import { useRerender } from '@/hooks/useRerender';
import { clamp, sampleArrivals } from '@/utils/math';
import { formatNumber, formatPercent } from '@/utils/format';
import { useLabRunning } from '@/hooks/useLabRunning';

type Algorithm = 'fixed-window' | 'sliding-window' | 'token-bucket' | 'leaky-bucket';

const ALGORITHMS: { value: Algorithm; label: string }[] = [
  { value: 'fixed-window', label: 'Fixed Window' },
  { value: 'sliding-window', label: 'Sliding Window' },
  { value: 'token-bucket', label: 'Token Bucket' },
  { value: 'leaky-bucket', label: 'Leaky Bucket' },
];

interface Setup {
  algorithm: Algorithm;
  /** Allowance per window, or the bucket capacity. */
  limit: number;
  windowSeconds: number;
  /** Requests per second the client sends. */
  requestRate: number;
}

/** What the lab opens on, and what Reset returns to: a token bucket with the client sending above the limit. */
const DEFAULT_SETUP: Setup = { algorithm: 'token-bucket', limit: 10, windowSeconds: 1, requestRate: 14 };

const NOTES: Record<Algorithm, string> = {
  'fixed-window':
    'A counter per calendar window, reset at the boundary. Simple - but a client can send a full limit at the end of one window and another full limit at the start of the next, producing twice the intended rate in a moment.',
  'sliding-window':
    'Sliding window counter: the previous window count is weighted by how much of it still overlaps the trailing window. No 2x boundary spike, for one more counter and a little arithmetic per request. It assumes the previous window was evenly spread, so it is an approximation.',
  'token-bucket':
    'Tokens refill at a steady rate up to a capacity. A request spends one token. An idle client accumulates tokens and may burst - which is usually what you want for real API clients.',
  'leaky-bucket':
    'Requests enter a queue that drains at a constant rate. Output is perfectly smooth, which protects a fragile downstream - but bursts wait instead of passing, and a full queue rejects.',
};

interface State {
  particles: Particle[];
  allowed: number;
  rejected: number;
  allowedRate: RateCounter;
  rejectedRate: RateCounter;
  /** Token bucket. */
  tokens: number;
  /** Leaky bucket queue length. */
  queue: number;
  leakCarry: number;
  /** Window counters. */
  windowStart: number;
  windowCount: number;
  previousWindowCount: number;
  /** "Burst across a window edge": armed until 100 ms before the edge, then fired twice 200 ms apart. */
  edgeBurst: { stage: 'armed' | 'first-sent'; firstAt: number; allowed: number } | null;
}

/** Half of the edge burst goes 100 ms before a window edge, the other half 100 ms after it. */
const EDGE_OFFSET_MS = 100;

const createState = (limit: number): State => ({
  particles: [],
  allowed: 0,
  rejected: 0,
  allowedRate: new RateCounter(2000),
  rejectedRate: new RateCounter(2000),
  tokens: limit,
  queue: 0,
  leakCarry: 0,
  windowStart: performance.now(),
  windowCount: 0,
  previousWindowCount: 0,
  edgeBurst: null,
});

const LAYOUT: Layout = {
  client: { x: 60, y: 200, w: 170, h: 88 },
  limiter: { x: 350, y: 170, w: 230, h: 150 },
  api: { x: 720, y: 108, w: 180, h: 95 },
  rejected: { x: 720, y: 318, w: 180, h: 95 },
};

const EDGES: DiagramEdge[] = [
  { from: 'client', to: 'limiter', tone: 'brand', width: 2 },
  { from: 'limiter', to: 'api', tone: 'ok', label: 'allowed' },
  { from: 'limiter', to: 'rejected', tone: 'danger', label: '429' },
];

export function RateLimitingLab() {
  const [running, setRunning] = useLabRunning();
  // Every control lives in one object, so Reset cannot miss one.
  const { setup, setSetup, change } = useLabSetup(DEFAULT_SETUP);
  const { algorithm, limit, windowSeconds, requestRate } = setup;

  const state = useRef<State>(createState(DEFAULT_SETUP.limit));
  const rerender = useRerender(30);
  const { events, log, clear } = useEventLog();
  const { points, push, reset: resetSeries } = useSeries(60, 400);

  const reset = useCallback(() => {
    setSetup(DEFAULT_SETUP);
    state.current = createState(DEFAULT_SETUP.limit);
    clear();
    resetSeries();
  }, [setSetup, clear, resetSeries]);

  const burst = useCallback(() => {
    const size = limit * 2;
    const allowed = sendBurst(state.current, algorithm, limit, windowSeconds, performance.now(), size);
    log(
      `Burst of ${size} requests: ${allowed} ${algorithm === 'leaky-bucket' ? 'queued' : 'allowed'}, ${size - allowed} rejected with 429`,
      'warn',
    );
    rerender();
  }, [algorithm, limit, windowSeconds, log, rerender]);

  const edgeBurst = useCallback(() => {
    state.current.edgeBurst = { stage: 'armed', firstAt: 0, allowed: 0 };
    setRunning(true);
    log(`Armed: ${limit} requests 0.1 s before the next window edge, ${limit} more 0.1 s after it`, 'info');
  }, [limit, log, setRunning]);

  useTicker(running, (dt) => {
    const current = state.current;
    const now = performance.now();

    // Refill / drain
    if (algorithm === 'token-bucket') {
      current.tokens = Math.min(limit, current.tokens + (limit / windowSeconds) * dt);
    }
    if (algorithm === 'leaky-bucket') {
      const drain = (limit / windowSeconds) * dt + current.leakCarry;
      const whole = Math.floor(drain);
      current.leakCarry = drain - whole;
      const leaked = Math.min(whole, current.queue);
      current.queue -= leaked;
      if (leaked > 0) {
        // Count every drained message. Only the first few are animated, so a
        // frame that drains more than the canvas shows is still counted in full.
        current.allowed += leaked;
        current.allowedRate.add(leaked, now);
        for (let index = 0; index < Math.min(leaked, 4); index += 1) {
          current.particles.push({
            id: nextParticleId(),
            route: ['limiter', 'api'],
            leg: 0,
            t: 0,
            speed: 1.5,
            outcome: 'success',
          });
        }
      }
    }

    // Window roll. Windows sit on a fixed clock (like calendar minutes), so a pause or a slow frame
    // cannot stretch one; a window that saw no ticks at all leaves an empty previous window.
    const windowMs = windowSeconds * 1000;
    const passed = Math.floor((now - current.windowStart) / windowMs);
    if (passed >= 1) {
      current.previousWindowCount = passed === 1 ? current.windowCount : 0;
      current.windowCount = 0;
      current.windowStart += passed * windowMs;
    }

    // Burst across a window edge: half just before the edge, half just after it, 0.2 s apart.
    const edge = current.edgeBurst;
    if (edge?.stage === 'armed' && now >= current.windowStart + windowMs - EDGE_OFFSET_MS) {
      edge.allowed = sendBurst(current, algorithm, limit, windowSeconds, now, limit);
      edge.firstAt = now;
      edge.stage = 'first-sent';
    } else if (edge?.stage === 'first-sent' && now >= edge.firstAt + 2 * EDGE_OFFSET_MS) {
      const total = edge.allowed + sendBurst(current, algorithm, limit, windowSeconds, now, limit);
      current.edgeBurst = null;
      const verb = algorithm === 'leaky-bucket' ? 'queued' : 'allowed';
      log(
        `Across the edge: ${total} of ${limit * 2} ${verb} within 0.2 s - the limit is ${limit} per ${windowSeconds} s`,
        total >= limit * 1.5 && algorithm !== 'leaky-bucket' ? 'danger' : 'ok',
      );
    }

    const arrivals = sampleArrivals(requestRate, dt);
    const arrivalSpeed = algorithm === 'leaky-bucket' ? 1.4 : 1.3;
    for (let index = 0; index < arrivals; index += 1) {
      const { particle } = admitOne(current, algorithm, limit, windowSeconds, now, { t: 0, speed: arrivalSpeed });
      current.particles.push(particle);
    }

    const { alive } = advanceParticles(current.particles, dt);
    current.particles = alive.slice(-70);

    push(
      {
        allowed: current.allowedRate.rate(now),
        rejected: current.rejectedRate.rate(now),
        limit: limit / windowSeconds,
      },
      now,
    );
    rerender();
  });

  const current = state.current;
  const now = performance.now();
  // Rolling, not cumulative: a lifetime ratio keeps the history of whichever
  // algorithm and limit were selected before, so changing either looked inert.
  const rejectedQps = current.rejectedRate.rate(now);
  const servedQps = current.allowedRate.rate(now) + rejectedQps;
  const rejectShare = servedQps ? rejectedQps / servedQps : 0;
  const windowElapsed = clamp((now - current.windowStart) / (windowSeconds * 1000), 0, 1);

  const particleViews: ParticleView[] = current.particles.map((particle) => ({
    id: particle.id,
    from: particle.route[particle.leg],
    to: particle.route[particle.leg + 1],
    t: particle.t,
    outcome: particle.outcome ?? 'success',
  }));

  return (
    <LabShell
      title="Rate Limiting Lab"
      description="Four algorithms, one traffic source. Watch tokens refill, windows roll and buckets leak - and see which one lets a burst through. Simplified: one client and one limiter instance; with several instances the counters live in a shared store such as Redis."
      running={running}
      onRunningChange={setRunning}
      onReset={reset}
      legend={
        <ParticleLegend
          outcomes={[
            { outcome: 'success', label: 'Allowed or queued request' },
            { outcome: 'failure', label: 'Rejected with 429' },
          ]}
        />
      }
      events={events}
      actions={
        <>
          <Button variant="secondary" onClick={burst}>
            Send a burst of {limit * 2}
          </Button>
          <Button
            variant="secondary"
            onClick={edgeBurst}
            disabled={current.edgeBurst !== null}
            title="Lower the client request rate first, so the window is not already used up"
          >
            Burst across a window edge
          </Button>
        </>
      }
      insight={<Insight title={ALGORITHMS.find((item) => item.value === algorithm)?.label}>{NOTES[algorithm]}</Insight>}
      metrics={
        <>
          <MetricsPanel
            items={[
              { key: 'allowed', label: 'Allowed', value: formatNumber(current.allowed), tone: 'ok' },
              { key: 'rejected', label: 'Rejected (429)', value: formatNumber(current.rejected), tone: current.rejected > 0 ? 'danger' : 'neutral' },
              { key: 'rejectShare', label: 'Reject rate', value: formatPercent(rejectShare, 1), tone: rejectShare > 0.3 ? 'danger' : rejectShare > 0 ? 'warn' : 'neutral', hint: 'Share of requests refused by the limiter.' },
              { key: 'limit', label: 'Configured limit', value: `${limit} / ${windowSeconds}s`, hint: 'Allowance per client per window.' },
              {
                key: 'state',
                label: algorithm === 'token-bucket' ? 'Tokens left' : algorithm === 'leaky-bucket' ? 'Queued' : 'Window count',
                value:
                  algorithm === 'token-bucket'
                    ? current.tokens.toFixed(1)
                    : algorithm === 'leaky-bucket'
                      ? formatNumber(current.queue)
                      : formatNumber(current.windowCount),
                tone: 'brand',
                hint: 'Internal state the algorithm keeps per client.',
              },
              { key: 'rps', label: 'Incoming', value: requestRate, unit: 'req/s', tone: 'brand' },
            ]}
          />
          <div className="card p-4">
            <p className="label mb-3">Allowed vs rejected over time</p>
            <LiveChart
              data={points}
              series={[
                { key: 'allowed', label: 'Allowed/sec', color: 'ok' },
                { key: 'rejected', label: 'Rejected/sec', color: 'danger' },
                { key: 'limit', label: 'Configured rate', color: 'faint', dashed: true },
              ]}
              variant="line"
              height={170}
            />
          </div>
        </>
      }
      controls={
        <>
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted">Algorithm</p>
            <div className="grid grid-cols-2 gap-1.5">
              {ALGORITHMS.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  aria-pressed={algorithm === item.value}
                  onClick={() => {
                    change('algorithm')(item.value);
                    state.current = createState(limit);
                    log(`Algorithm: ${item.label}`, 'info');
                  }}
                  className={`rounded-lg border px-2.5 py-2 text-xs font-medium transition-colors ${
                    algorithm === item.value
                      ? 'border-brand bg-brand/10 text-brand'
                      : 'border-line text-muted hover:border-brand/50 hover:text-ink'
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>
          <Slider
            label="Limit"
            value={limit}
            min={1}
            max={50}
            onChange={(value) => {
              change('limit')(value);
              state.current = createState(value);
            }}
            format={(value) => `${value} requests`}
            hint="Allowance per window (or bucket capacity)."
          />
          <Slider
            label="Window"
            value={windowSeconds}
            min={1}
            max={10}
            onChange={change('windowSeconds')}
            format={(value) => `${value} s`}
            hint="Window length, or the time in which the bucket fully refills."
          />
          <Slider
            label="Client request rate"
            value={requestRate}
            min={1}
            max={80}
            onChange={change('requestRate')}
            format={(value) => `${value} req/s`}
            tone={requestRate > limit / windowSeconds ? 'danger' : 'brand'}
          />
          <div className="border-t border-line pt-4">
            <p className="label mb-2">Limiter state</p>
            {algorithm === 'token-bucket' ? (
              <TokenBucket tokens={current.tokens} capacity={limit} />
            ) : algorithm === 'leaky-bucket' ? (
              <LeakyBucket queued={current.queue} capacity={limit * 3} />
            ) : (
              <WindowView
                count={current.windowCount}
                previous={current.previousWindowCount}
                limit={limit}
                elapsed={windowElapsed}
                sliding={algorithm === 'sliding-window'}
              />
            )}
          </div>
        </>
      }
    >
      <DiagramCanvas layout={LAYOUT} edges={EDGES} particles={particleViews} height={490} className="bg-canvas">
        <ArchNode kind="client" title="Client" subtitle={`${requestRate} req/s`} placed={LAYOUT.client} compact />
        <ArchNode
          kind="api-gateway"
          title="Rate Limiter"
          subtitle={ALGORITHMS.find((item) => item.value === algorithm)?.label}
          placed={LAYOUT.limiter}
        >
          <NodeStatRow label="Limit" value={`${limit} / ${windowSeconds}s`} />
          {algorithm === 'token-bucket' ? (
            <div className="flex flex-wrap gap-1 pt-1" role="img" aria-label={`${Math.floor(current.tokens)} tokens available`}>
              {Array.from({ length: Math.min(limit, 20) }, (_, index) => (
                <span
                  key={index}
                  className={`h-2.5 w-2.5 rounded-full transition-colors ${
                    index < Math.floor(current.tokens) ? 'bg-ok' : 'bg-line'
                  }`}
                />
              ))}
            </div>
          ) : null}
          {algorithm === 'leaky-bucket' ? <NodeStatRow label="Queued" value={formatNumber(current.queue)} /> : null}
          {algorithm !== 'token-bucket' && algorithm !== 'leaky-bucket' ? (
            <NodeStatRow label="Window" value={`${current.windowCount}/${limit}`} />
          ) : null}
        </ArchNode>
        <ArchNode kind="server" title="API" subtitle="protected service" placed={LAYOUT.api} compact>
          <NodeStatRow label="Allowed" value={formatNumber(current.allowed)} tone="text-ok" />
        </ArchNode>
        <ArchNode kind="client" title="HTTP 429" subtitle="Too Many Requests" placed={LAYOUT.rejected} compact>
          <NodeStatRow label="Rejected" value={formatNumber(current.rejected)} tone="text-danger" />
        </ArchNode>
      </DiagramCanvas>
    </LabShell>
  );
}

/**
 * Sends `size` requests at the same instant through the limiter. Every one is counted like any other
 * traffic; only the first 12 are animated, staggered, so a large burst does not flood the canvas.
 * Returns how many were admitted (for a leaky bucket: queued).
 */
function sendBurst(state: State, algorithm: Algorithm, limit: number, windowSeconds: number, now: number, size: number) {
  let allowed = 0;
  for (let index = 0; index < size; index += 1) {
    const { ok, particle } = admitOne(state, algorithm, limit, windowSeconds, now, { t: -index * 0.08, speed: 1.3 });
    if (ok) allowed += 1;
    if (index < 12) state.particles.push(particle);
  }
  return allowed;
}

/** Applies the selected algorithm. Returns true when the request is admitted. */
function admit(state: State, algorithm: Algorithm, limit: number, windowSeconds: number, now: number) {
  switch (algorithm) {
    case 'token-bucket': {
      if (state.tokens >= 1) {
        state.tokens -= 1;
        return true;
      }
      return false;
    }
    case 'leaky-bucket': {
      if (state.queue < limit * 3) {
        state.queue += 1;
        return true;
      }
      return false;
    }
    case 'sliding-window': {
      const elapsed = clamp((now - state.windowStart) / (windowSeconds * 1000), 0, 1);
      const weighted = state.previousWindowCount * (1 - elapsed) + state.windowCount;
      if (weighted < limit) {
        state.windowCount += 1;
        return true;
      }
      return false;
    }
    default: {
      if (state.windowCount < limit) {
        state.windowCount += 1;
        return true;
      }
      return false;
    }
  }
}

/**
 * Admits one request at the limiter, counts it, and returns the particle that should animate it.
 * The burst button and the tick loop both go through here, so the metrics, the chart and the
 * diagram agree however the traffic arrived. A leaky bucket only enqueues an admitted request:
 * its drain loop counts it as allowed and animates the limiter -> api hop, so the particle made
 * here stops at the limiter. A rejection happens at the limiter, so it travels the 429 edge.
 */
function admitOne(
  state: State,
  algorithm: Algorithm,
  limit: number,
  windowSeconds: number,
  now: number,
  motion: { t: number; speed: number },
): { ok: boolean; particle: Particle } {
  const ok = admit(state, algorithm, limit, windowSeconds, now);
  let route: string[];
  if (!ok) {
    state.rejected += 1;
    state.rejectedRate.add(1, now);
    route = ['client', 'limiter', 'rejected'];
  } else if (algorithm === 'leaky-bucket') {
    route = ['client', 'limiter'];
  } else {
    state.allowed += 1;
    state.allowedRate.add(1, now);
    route = ['client', 'limiter', 'api'];
  }
  return {
    ok,
    particle: { id: nextParticleId(), route, leg: 0, ...motion, outcome: ok ? 'success' : 'failure' },
  };
}

function TokenBucket({ tokens, capacity }: { tokens: number; capacity: number }) {
  return (
    <div>
      <div className="flex flex-wrap gap-1" aria-hidden>
        {Array.from({ length: Math.min(capacity, 30) }, (_, index) => (
          <span
            key={index}
            className={`h-3 w-3 rounded-full ${index < Math.floor(tokens) ? 'bg-ok' : 'border border-line bg-transparent'}`}
          />
        ))}
      </div>
      <p className="mt-2 font-mono text-[11px] text-muted">
        {tokens.toFixed(1)} / {capacity} tokens
      </p>
      <p className="mt-1 text-[11px] text-faint">
        Idle clients accumulate tokens up to the capacity, then may spend them in one burst.
      </p>
    </div>
  );
}

function LeakyBucket({ queued, capacity }: { queued: number; capacity: number }) {
  return (
    <div>
      <div className="h-24 w-full overflow-hidden rounded-lg border border-line bg-canvas" aria-hidden>
        <div
          className="mt-auto h-full w-full origin-bottom bg-brand/40 transition-transform"
          style={{ transform: `scaleY(${clamp(queued / capacity, 0, 1)})`, transformOrigin: 'bottom' }}
        />
      </div>
      <p className="mt-2 font-mono text-[11px] text-muted">
        {queued} queued / {capacity} capacity
      </p>
      <p className="mt-1 text-[11px] text-faint">
        Output drains at a constant rate; overflow is rejected. The queue holds 3x the limit - a choice of this Lab.
      </p>
    </div>
  );
}

function WindowView({
  count,
  previous,
  limit,
  elapsed,
  sliding,
}: {
  count: number;
  previous: number;
  limit: number;
  elapsed: number;
  sliding: boolean;
}) {
  const weighted = sliding ? previous * (1 - elapsed) + count : count;
  return (
    <div>
      <div className="flex gap-1">
        <div className="flex-1">
          <p className="text-[11px] text-faint">previous</p>
          <div className="mt-1 h-10 rounded bg-line/60" aria-hidden>
            <div
              className="h-full rounded bg-faint/50"
              style={{ width: `${clamp(previous / limit, 0, 1) * 100}%` }}
            />
          </div>
        </div>
        <div className="flex-1">
          <p className="text-[11px] text-faint">current ({Math.round(elapsed * 100)}%)</p>
          <div className="mt-1 h-10 rounded bg-line/60" aria-hidden>
            <div
              className={`h-full rounded ${count >= limit ? 'bg-danger' : 'bg-brand'}`}
              style={{ width: `${clamp(count / limit, 0, 1) * 100}%` }}
            />
          </div>
        </div>
      </div>
      <p className="mt-2 font-mono text-[11px] text-muted">
        {sliding ? `weighted ${weighted.toFixed(1)}` : `count ${count}`} / {limit}
      </p>
      <p className="mt-1 text-[11px] text-faint">
        {sliding
          ? 'The previous window still counts, fading out as the current one progresses.'
          : 'The counter resets instantly at the boundary - that is the 2x burst hole.'}
      </p>
    </div>
  );
}

export default RateLimitingLab;
