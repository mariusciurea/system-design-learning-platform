import { useCallback, useRef } from 'react';
import { ArchNode, DiagramCanvas, NodeStatRow, ParticleLegend, type DiagramEdge, type Layout, type ParticleView } from '@/components/architecture';
import { LiveChart } from '@/components/charts';
import { Insight, LabShell, MetricsPanel, SIMULATED_HINT } from '@/components/learning';
import { Slider, Toggle } from '@/components/ui';
import {
  MetricWindow,
  RateCounter,
  advanceParticles,
  nextParticleId,
  useEventLog,
  useSeries,
  useTicker,
  visualShare,
  type Particle,
} from '@/simulations/engine';
import { useLabSetup } from '@/hooks/useLabSetup';
import { useRerender } from '@/hooks/useRerender';
import { sampleArrivals } from '@/utils/math';
import { formatLatency, formatNumber, formatPercent } from '@/utils/format';
import { cn } from '@/utils/cn';
import { useLabRunning } from '@/hooks/useLabRunning';

/*
 * Simplified model - chosen to teach, not measured:
 *
 * - One API process with 40 request threads. Every request makes one blocking
 *   call to one dependency and holds its thread until the answer arrives or the
 *   call timeout fires. Threads in use = rate x hold time (Little's Law).
 * - Payments answers checkout calls in about 100 ms. Recommendations answers
 *   in whatever the learner sets. Both vary by +-20% per call.
 * - A request that finds no free thread in its pool is rejected at once, like a
 *   Resilience4j bulkhead with maxWaitDuration 0 or a full Hystrix pool. A real
 *   server may queue it briefly first; that only delays the same outcome.
 * - A failed recommendations call has a fallback (the page shows without
 *   recommendations). A failed checkout call has none: the order fails.
 */
const TOTAL_THREADS = 40;
const CHECKOUT_MS = 100;
const JITTER = 0.2;
/** Simulation sub-step in ms. */
const SUBSTEP_MS = 5;

type Dep = 'pay' | 'recs';

interface Setup {
  bulkheads: boolean;
  recsLatency: number;
  timeoutMs: number;
  /** Threads reserved for recommendations when bulkheads are on. Checkout gets the rest. */
  recsPool: number;
  checkoutRate: number;
  recsRate: number;
}

/** Healthy start with one shared pool: the learner makes Recommendations slow. */
const DEFAULT_SETUP: Setup = {
  bulkheads: false,
  recsLatency: 50,
  timeoutMs: 10000,
  recsPool: 10,
  checkoutRate: 40,
  recsRate: 20,
};

interface Call {
  dep: Dep;
  start: number;
  endAt: number;
  timedOut: boolean;
}

interface SimState {
  now: number;
  calls: Call[];
  particles: Particle[];
  checkoutOk: RateCounter;
  checkoutFailed: RateCounter;
  recsOk: RateCounter;
  recsFallback: RateCounter;
  checkoutLatency: MetricWindow;
  flags: { exhausted: boolean; checkoutFailing: boolean; recsFull: boolean };
  nextCheck: number;
}

const createState = (): SimState => ({
  now: 0,
  calls: [],
  particles: [],
  checkoutOk: new RateCounter(2000),
  checkoutFailed: new RateCounter(2000),
  recsOk: new RateCounter(2000),
  recsFallback: new RateCounter(2000),
  checkoutLatency: new MetricWindow(600),
  flags: { exhausted: false, checkoutFailing: false, recsFull: false },
  nextCheck: 500,
});

const jitter = (ms: number) => ms * (1 - JITTER + Math.random() * 2 * JITTER);

const LAYOUT: Layout = {
  users: { x: 16, y: 147, w: 120, h: 80 },
  api: { x: 180, y: 127, w: 188, h: 120 },
  pool: { x: 420, y: 77, w: 256, h: 220 },
  poolPay: { x: 420, y: 10, w: 256, h: 170 },
  poolRecs: { x: 420, y: 194, w: 256, h: 170 },
  pay: { x: 740, y: 35, w: 204, h: 120 },
  recs: { x: 740, y: 219, w: 204, h: 120 },
};

/** One square per thread: who holds it, or free. Shape-free, so a stat row always states the numbers too. */
function ThreadGrid({ size, pay, recs, label }: { size: number; pay: number; recs: number; label: string }) {
  return (
    <div className="flex flex-wrap gap-[3px]" aria-label={label}>
      {Array.from({ length: size }, (_, index) => (
        <span
          key={index}
          className={cn(
            'h-2.5 w-2.5 rounded-[2px]',
            index < pay ? 'bg-brand' : index < pay + recs ? 'bg-violet' : 'border border-line bg-elevated',
          )}
        />
      ))}
    </div>
  );
}

export function BulkheadLab() {
  // Every control lives in one object, so Reset cannot miss one.
  const { setup, setSetup, change } = useLabSetup(DEFAULT_SETUP);
  const { bulkheads, recsLatency, timeoutMs, recsPool, checkoutRate, recsRate } = setup;

  const [running, setRunning] = useLabRunning();
  const state = useRef<SimState>(createState());
  const rerender = useRerender(30);
  const { events, log, clear } = useEventLog();
  const { points, push, reset: resetSeries } = useSeries(60, 400);

  const payPool = TOTAL_THREADS - recsPool;
  const poolOf = (dep: Dep) => (bulkheads ? (dep === 'pay' ? 'poolPay' : 'poolRecs') : 'pool');

  const reset = useCallback(() => {
    state.current = createState();
    setSetup(DEFAULT_SETUP);
    clear();
    resetSeries();
  }, [clear, resetSeries, setSetup]);

  useTicker(running, (dt) => {
    const sim = state.current;
    const share = visualShare(checkoutRate + recsRate, 14);
    const emit = (route: string[], outcome: Particle['outcome']) => {
      if (Math.random() >= share) return;
      sim.particles.push({ id: nextParticleId(), route, leg: 0, t: 0, speed: 1.6 + Math.random() * 0.4, outcome });
    };

    const steps = Math.max(1, Math.round((dt * 1000) / SUBSTEP_MS));
    const h = (dt * 1000) / steps;
    for (let step = 0; step < steps; step += 1) {
      sim.now += h;
      const now = sim.now;

      // 1. Calls that answered or hit the timeout give their thread back.
      const still: Call[] = [];
      for (const call of sim.calls) {
        if (call.endAt > now) {
          still.push(call);
          continue;
        }
        if (call.dep === 'pay') {
          if (call.timedOut) {
            sim.checkoutFailed.add(1, now);
          } else {
            sim.checkoutOk.add(1, now);
            sim.checkoutLatency.push(now - call.start, now);
          }
        } else if (call.timedOut) {
          sim.recsFallback.add(1, now);
        } else {
          sim.recsOk.add(1, now);
        }
      }
      sim.calls = still;

      // 2. New requests take a thread from their pool, or are rejected at once.
      let heldPay = 0;
      let heldRecs = 0;
      for (const call of sim.calls) {
        if (call.dep === 'pay') heldPay += 1;
        else heldRecs += 1;
      }
      const arrive = (dep: Dep, rate: number, serviceMs: number) => {
        const count = sampleArrivals(rate, h / 1000);
        for (let index = 0; index < count; index += 1) {
          const held = dep === 'pay' ? heldPay : heldRecs;
          const free = bulkheads
            ? held < (dep === 'pay' ? payPool : recsPool)
            : heldPay + heldRecs < TOTAL_THREADS;
          const pool = poolOf(dep);
          if (!free) {
            if (dep === 'pay') sim.checkoutFailed.add(1, now);
            else sim.recsFallback.add(1, now);
            emit(['users', 'api', pool], dep === 'pay' ? 'failure' : 'warning');
            continue;
          }
          const answer = jitter(serviceMs);
          const timedOut = answer > timeoutMs;
          sim.calls.push({ dep, start: now, endAt: now + Math.min(answer, timeoutMs), timedOut });
          if (dep === 'pay') heldPay += 1;
          else heldRecs += 1;
          emit(['users', 'api', pool, dep], timedOut ? (dep === 'pay' ? 'failure' : 'warning') : 'success');
        }
      };
      arrive('pay', checkoutRate, CHECKOUT_MS);
      arrive('recs', recsRate, recsLatency);
    }

    const { alive } = advanceParticles(sim.particles, dt);
    sim.particles = alive.slice(-80);

    const now = sim.now;
    let heldPay = 0;
    let heldRecs = 0;
    for (const call of sim.calls) {
      if (call.dep === 'pay') heldPay += 1;
      else heldRecs += 1;
    }
    if (now >= sim.nextCheck) {
      sim.nextCheck = now + 500;
      const next = {
        exhausted: !bulkheads && heldPay + heldRecs >= TOTAL_THREADS,
        checkoutFailing: sim.checkoutFailed.rate(now) > 0,
        recsFull: bulkheads && heldRecs >= recsPool,
      };
      const flags = sim.flags;
      if (next.exhausted && !flags.exhausted)
        log(`Shared pool exhausted: all ${TOTAL_THREADS} threads are busy, ${heldRecs} of them waiting on Recommendations`, 'danger');
      if (!next.exhausted && flags.exhausted) log('The shared pool has free threads again', 'ok');
      if (next.recsFull && !flags.recsFull)
        log(`Recommendations pool full (${recsPool} threads): extra recs calls fail fast, the page shows without them`, 'warn');
      if (!next.recsFull && flags.recsFull) log('Recommendations pool has free threads again', 'ok');
      if (next.checkoutFailing && !flags.checkoutFailing)
        log(
          bulkheads
            ? `Checkout requests rejected: its pool of ${payPool} threads is too small for its own load`
            : 'Checkout requests rejected, although Payments is healthy',
          'danger',
        );
      if (!next.checkoutFailing && flags.checkoutFailing) log('Checkout completes again', 'ok');
      sim.flags = next;
    }

    push(
      {
        checkoutOk: sim.checkoutOk.rate(now),
        checkoutFailed: sim.checkoutFailed.rate(now),
        heldPay,
        heldRecs,
      },
      now,
    );
    rerender();
  });

  // Read straight from the simulation ref: the ticker re-renders at a capped rate.
  const sim = state.current;
  const now = sim.now;
  let heldPay = 0;
  let heldRecs = 0;
  for (const call of sim.calls) {
    if (call.dep === 'pay') heldPay += 1;
    else heldRecs += 1;
  }
  const checkoutOk = sim.checkoutOk.rate(now);
  const checkoutFailed = sim.checkoutFailed.rate(now);
  const recsOk = sim.recsOk.rate(now);
  const recsFallback = sim.recsFallback.rate(now);
  const checkoutTotal = checkoutOk + checkoutFailed;
  const checkoutSuccess = checkoutTotal > 0 ? checkoutOk / checkoutTotal : 1;
  const checkoutP95 = sim.checkoutLatency.snapshot(now).p95;

  // Little's Law: threads a dependency wants = calls per second x seconds each call holds a thread.
  const recsHoldMs = Math.min(recsLatency, timeoutMs);
  const recsWanted = (recsRate * recsHoldMs) / 1000;
  const payWanted = (checkoutRate * CHECKOUT_MS) / 1000;
  const recsSlow = recsLatency > 1000;

  const particleViews: ParticleView[] = sim.particles.map((particle) => ({
    id: particle.id,
    from: particle.route[particle.leg],
    to: particle.route[particle.leg + 1],
    t: particle.t,
    outcome: particle.outcome ?? 'success',
  }));

  const recsTone: DiagramEdge['tone'] = recsSlow ? 'danger' : 'ok';
  const edges: DiagramEdge[] = bulkheads
    ? [
        { from: 'users', to: 'api', tone: 'brand' },
        { from: 'api', to: 'poolPay', tone: checkoutFailed > 0 ? 'danger' : 'brand' },
        { from: 'api', to: 'poolRecs', tone: heldRecs >= recsPool ? 'warn' : 'brand' },
        { from: 'poolPay', to: 'pay', tone: 'ok' },
        { from: 'poolRecs', to: 'recs', tone: recsTone },
      ]
    : [
        { from: 'users', to: 'api', tone: 'brand' },
        { from: 'api', to: 'pool', tone: checkoutFailed > 0 ? 'danger' : 'brand' },
        { from: 'pool', to: 'pay', tone: 'ok' },
        { from: 'pool', to: 'recs', tone: recsTone },
      ];
  const layout: Layout = bulkheads
    ? { users: LAYOUT.users, api: LAYOUT.api, poolPay: LAYOUT.poolPay, poolRecs: LAYOUT.poolRecs, pay: LAYOUT.pay, recs: LAYOUT.recs }
    : { users: LAYOUT.users, api: LAYOUT.api, pool: LAYOUT.pool, pay: LAYOUT.pay, recs: LAYOUT.recs };

  const heldRows = (
    <>
      <NodeStatRow label="Held by checkout" value={formatNumber(heldPay)} tone="text-brand" />
      <NodeStatRow label="Held by recs" value={formatNumber(heldRecs)} tone={heldRecs > 0 && recsSlow ? 'text-warn' : 'text-ink'} />
    </>
  );

  return (
    <LabShell
      title="Bulkhead Lab"
      description="One API calls two dependencies: Payments for checkout and Recommendations for the product page. Make Recommendations slow and watch its calls take every thread - then give each dependency its own pool."
      running={running}
      onRunningChange={setRunning}
      onReset={reset}
      events={events}
      legend={
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
          <ParticleLegend
            outcomes={[
              { outcome: 'success', label: 'Call answered' },
              { outcome: 'warning', label: 'Recs failed, page without them' },
              { outcome: 'failure', label: 'Checkout failed' },
            ]}
          />
          <span className="text-[11px] text-faint">Squares: blue held by checkout, violet held by recs, empty free.</span>
        </div>
      }
      insight={
        <Insight>
          {!bulkheads && checkoutFailed > 0 ? (
            <>
              Recommendations answers in {formatLatency(recsLatency)}, so each recs call holds a thread for{' '}
              {formatLatency(recsHoldMs)}. {recsRate} calls/s x {formatLatency(recsHoldMs)} wants about{' '}
              {formatNumber(recsWanted)} threads, and the pool has {TOTAL_THREADS} in total, shared. Recs now holds{' '}
              {heldRecs} of them, so checkout requests find no free thread and fail - although Payments is healthy. Turn
              on bulkheads.
            </>
          ) : bulkheads && checkoutFailed > 0 ? (
            <>
              Checkout needs about {checkoutRate}/s x {CHECKOUT_MS} ms = {formatNumber(payWanted)} threads, but its pool
              has only {payPool}. A bulkhead sized too small rejects healthy traffic. Size each pool from its measured
              concurrency plus headroom, not by an even split.
            </>
          ) : bulkheads && heldRecs >= recsPool ? (
            <>
              Recommendations holds all {recsPool} of its threads, and extra recs calls fail fast: the product page shows
              without recommendations. Checkout has its own {payPool} threads, uses about {formatNumber(payWanted)}, and
              keeps completing. The failure stayed in its compartment.
            </>
          ) : bulkheads ? (
            <>
              Checkout has {payPool} threads and uses about {formatNumber(payWanted)}; recs has {recsPool} and uses about{' '}
              {formatNumber(recsWanted)}. Drag Recommendations latency to 5 s: only the recs pool fills.
            </>
          ) : recsSlow ? (
            <>
              Recommendations is slow, but{' '}
              {recsLatency > timeoutMs
                ? `the ${formatLatency(timeoutMs)} timeout caps how long each call holds a thread, so`
                : 'at this load'}{' '}
              about {formatNumber(recsWanted)} threads are enough and the pool still has room for checkout. A timeout
              bounds how long; only a bulkhead bounds how many. Raise the product page load and see.
            </>
          ) : (
            <>
              Both dependencies are fast: checkout holds about {formatNumber(payWanted)} threads and recs about{' '}
              {formatNumber(recsWanted)} of {TOTAL_THREADS}. Drag Recommendations latency to 5 s and watch who takes the
              threads.
            </>
          )}
        </Insight>
      }
      metrics={
        <>
          <MetricsPanel
            items={[
              {
                key: 'checkout',
                label: 'Checkout success',
                value: formatPercent(checkoutSuccess),
                tone: checkoutSuccess < 0.99 ? 'danger' : 'ok',
                hint: 'Share of checkout requests that got a thread and an answer from Payments.',
                simulated: true,
              },
              {
                key: 'checkout-failed',
                label: 'Checkout failures',
                value: formatNumber(checkoutFailed),
                unit: 'req/s',
                tone: checkoutFailed > 0 ? 'danger' : 'ok',
                hint: 'Checkout requests rejected for lack of a thread. They have no fallback.',
                simulated: true,
              },
              {
                key: 'recs',
                label: 'Recs fallbacks',
                value: formatNumber(recsFallback),
                unit: 'req/s',
                tone: recsFallback > 0 ? 'warn' : 'ok',
                hint: `Recommendations calls that timed out or were rejected. The page is shown without recommendations. ${formatNumber(recsOk)}/s answered.`,
                simulated: true,
              },
              {
                key: 'p95',
                label: 'Checkout p95',
                value: formatLatency(checkoutP95),
                hint: 'Latency of checkout requests that completed.',
                simulated: true,
              },
              {
                key: 'threads',
                label: 'Threads busy',
                value: `${heldPay + heldRecs} / ${TOTAL_THREADS}`,
                tone: heldPay + heldRecs >= TOTAL_THREADS ? 'danger' : 'neutral',
                hint: `Checkout holds ${heldPay}, recs holds ${heldRecs}.`,
                simulated: true,
              },
            ]}
          />
          <div className="card p-4">
            <p className="label mb-3">Checkout, and who holds the threads</p>
            <LiveChart
              data={points}
              series={[
                { key: 'checkoutOk', label: 'Checkout ok/s', color: 'ok' },
                { key: 'checkoutFailed', label: 'Checkout failed/s', color: 'danger' },
              ]}
              height={140}
            />
            <LiveChart
              data={points}
              series={[
                { key: 'heldPay', label: 'Threads: checkout', color: 'brand' },
                { key: 'heldRecs', label: 'Threads: recs', color: 'violet' },
              ]}
              variant="line"
              height={140}
            />
            <p className="mt-2 text-xs text-faint">
              {SIMULATED_HINT} One API process with {TOTAL_THREADS} threads, one blocking call per
              request, Payments answering in about {CHECKOUT_MS} ms, and a request that finds its pool full rejected at
              once (a real server may queue it briefly first).
            </p>
          </div>
        </>
      }
      controls={
        <>
          <Toggle
            label="Bulkheads"
            checked={bulkheads}
            onChange={(value) => {
              change('bulkheads')(value);
              log(
                value
                  ? `Bulkheads on: checkout gets ${payPool} threads, recs gets ${recsPool}`
                  : `Bulkheads off: one shared pool of ${TOTAL_THREADS} threads`,
                'info',
              );
            }}
            description="Off: both dependencies share one pool of 40 threads"
          />
          <Slider
            label="Recommendations latency"
            value={recsLatency}
            min={50}
            max={10000}
            step={50}
            onChange={change('recsLatency')}
            tone={recsSlow ? 'danger' : 'brand'}
            format={(value) => formatLatency(value)}
            hint="How long Recommendations takes to answer. Payments stays at about 100 ms."
          />
          <Slider
            label="Threads for recommendations"
            value={recsPool}
            min={2}
            max={TOTAL_THREADS - 2}
            onChange={change('recsPool')}
            disabled={!bulkheads}
            tone={bulkheads && payPool < payWanted ? 'danger' : 'brand'}
            format={(value) => `${value} of ${TOTAL_THREADS}`}
            hint={`With bulkheads on, checkout gets the other ${payPool}.`}
          />
          <Slider
            label="Call timeout"
            value={timeoutMs}
            min={250}
            max={10000}
            step={250}
            onChange={change('timeoutMs')}
            format={(value) => formatLatency(value)}
            hint="The longest one call may hold its thread, on both dependencies."
          />
          <Slider
            label="Checkout load"
            value={checkoutRate}
            min={10}
            max={300}
            step={10}
            onChange={change('checkoutRate')}
            format={(value) => `${value} req/s`}
            hint="Checkout requests per second. Each one calls Payments."
          />
          <Slider
            label="Product page load"
            value={recsRate}
            min={5}
            max={100}
            step={5}
            onChange={change('recsRate')}
            format={(value) => `${value} req/s`}
            hint="Product page requests per second. Each one calls Recommendations."
          />
        </>
      }
    >
      <DiagramCanvas layout={layout} edges={edges} particles={particleViews} height={376} className="bg-canvas">
        <ArchNode kind="client" title="Users" subtitle={`${checkoutRate + recsRate} req/s`} placed={LAYOUT.users} compact />
        <ArchNode kind="server" title="API" subtitle={`one process, ${TOTAL_THREADS} threads`} placed={LAYOUT.api} compact>
          <NodeStatRow label="Checkout" value={`${checkoutRate}/s`} />
          <NodeStatRow label="Product page" value={`${recsRate}/s`} />
        </ArchNode>
        {bulkheads ? (
          <>
            <ArchNode
              kind="worker"
              title="Checkout pool"
              subtitle={`inside the API: ${payPool} threads`}
              placed={LAYOUT.poolPay}
              alert={checkoutFailed > 0}
              status={checkoutFailed > 0 ? 'degraded' : 'healthy'}
            >
              <ThreadGrid size={payPool} pay={heldPay} recs={0} label={`${heldPay} of ${payPool} checkout threads busy`} />
              <NodeStatRow label="Busy" value={`${heldPay} / ${payPool}`} tone={heldPay >= payPool ? 'text-danger' : 'text-ink'} />
              <NodeStatRow label="Rejected" value={`${formatNumber(checkoutFailed)}/s`} tone={checkoutFailed > 0 ? 'text-danger' : 'text-ok'} />
            </ArchNode>
            <ArchNode
              kind="worker"
              title="Recs pool"
              subtitle={`inside the API: ${recsPool} threads`}
              placed={LAYOUT.poolRecs}
              alert={heldRecs >= recsPool}
              status={heldRecs >= recsPool ? 'degraded' : 'healthy'}
              statusLabel={heldRecs >= recsPool ? 'Full' : undefined}
            >
              <ThreadGrid size={recsPool} pay={0} recs={heldRecs} label={`${heldRecs} of ${recsPool} recs threads busy`} />
              <NodeStatRow label="Busy" value={`${heldRecs} / ${recsPool}`} tone={heldRecs >= recsPool ? 'text-warn' : 'text-ink'} />
              <NodeStatRow label="Fallbacks" value={`${formatNumber(recsFallback)}/s`} tone={recsFallback > 0 ? 'text-warn' : 'text-ok'} />
            </ArchNode>
          </>
        ) : (
          <ArchNode
            kind="worker"
            title="Shared thread pool"
            subtitle={`inside the API: ${TOTAL_THREADS} threads`}
            placed={LAYOUT.pool}
            alert={heldPay + heldRecs >= TOTAL_THREADS}
            status={heldPay + heldRecs >= TOTAL_THREADS ? 'degraded' : 'healthy'}
            statusLabel={heldPay + heldRecs >= TOTAL_THREADS ? 'Exhausted' : undefined}
          >
            <ThreadGrid
              size={TOTAL_THREADS}
              pay={heldPay}
              recs={heldRecs}
              label={`${heldPay} threads held by checkout, ${heldRecs} by recs, of ${TOTAL_THREADS}`}
            />
            {heldRows}
            <NodeStatRow label="Rejected" value={`${formatNumber(checkoutFailed + recsFallback)}/s`} tone={checkoutFailed > 0 ? 'text-danger' : 'text-ok'} />
          </ArchNode>
        )}
        <ArchNode kind="service" title="Payments" subtitle="answers in ~100 ms" placed={LAYOUT.pay} compact>
          <NodeStatRow label="Answered" value={`${formatNumber(checkoutOk)}/s`} tone="text-ok" />
          <NodeStatRow label="Status" value="healthy" tone="text-ok" />
        </ArchNode>
        <ArchNode
          kind="service"
          title="Recommendations"
          subtitle={`answers in ~${formatLatency(recsLatency)}`}
          placed={LAYOUT.recs}
          status={recsSlow ? 'degraded' : 'healthy'}
          statusLabel={recsSlow ? 'Slow' : undefined}
          compact
        >
          <NodeStatRow label="Answered" value={`${formatNumber(recsOk)}/s`} />
          <NodeStatRow label="Calls waiting" value={formatNumber(heldRecs)} tone={recsSlow ? 'text-warn' : 'text-ink'} />
        </ArchNode>
      </DiagramCanvas>
    </LabShell>
  );
}

export default BulkheadLab;
