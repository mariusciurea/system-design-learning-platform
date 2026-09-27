import { useCallback, useRef } from 'react';
import { Zap } from 'lucide-react';
import {
  ArchNode,
  DiagramCanvas,
  NodeStatRow,
  ParticleLegend,
  spread,
  type DiagramEdge,
  type Layout,
  type ParticleView,
} from '@/components/architecture';
import { LiveChart } from '@/components/charts';
import { Insight, LabShell, MetricsPanel, SIMULATED_HINT, type MetricItem } from '@/components/learning';
import { Button, Meter, Slider, Stepper, Toggle } from '@/components/ui';
import { advanceParticles, nextParticleId, useEventLog, useSeries, useTicker, visualShare, type Particle } from '@/simulations/engine';
import { useLabSetup } from '@/hooks/useLabSetup';
import { useRerender } from '@/hooks/useRerender';
import { clamp, sampleArrivals } from '@/utils/math';
import { formatLatency, formatNumber, formatPercent } from '@/utils/format';
import type { LabFocus, LabProps, RequestOutcome } from '@/types';
import { useLabRunning } from '@/hooks/useLabRunning';

/*
 * Simplified model - chosen to teach, not measured:
 *
 * - Users send requests to the API at the producer rate (Poisson-ish arrivals).
 * - With the queue on, the API only validates and enqueues, and answers the
 *   user in a fixed ACK_MS. Workers pull from the queue at workers x speed.
 *   A job takes 1 / speed seconds in a worker.
 * - With the queue off (request/response), the API calls a worker and the user
 *   waits for the result. Requests that find every worker busy wait on their
 *   open connection. A caller gives up at the timeout: while still waiting it
 *   is dropped (the server honours the cancellation), and a job picked up too
 *   late to finish in time is still done by the worker - wasted work.
 * - Task retries: every attempt fails with the chosen probability. A failed
 *   task waits in the delayed set (base delay, doubled per attempt, no jitter)
 *   and re-enters the queue; after the last attempt it goes to the dead-letter
 *   queue. Retries re-enter even a full bounded queue - the broker already
 *   accepted them; only new publishes are refused.
 */
const ACK_MS = 20;
const BURST_RATE = 200;
const BURST_SECONDS = 2;
/** Particles emitted per second on each path, so the canvas stays readable at any rate. */
const PARTICLES_PER_SECOND = 12;

interface Setup {
  /** Off: no queue, the API calls a worker and the user waits (request/response). */
  queueOn: boolean;
  producerRate: number;
  workers: number;
  /** Jobs per second one worker finishes; a job takes 1 / workerRate seconds. */
  workerRate: number;
  bounded: boolean;
  maxDepth: number;
  /** How long a caller waits for an answer when there is no queue. */
  timeoutMs: number;
  /** Task failures, retries with backoff, and a dead-letter queue. */
  retries: boolean;
  failureRate: number;
  maxAttempts: number;
  /** First retry delay in seconds; it doubles on every further attempt. */
  retryDelay: number;
}

/** What the lab opens on at /labs/queue, with no Lab focus: 100 in, 60 out, a bounded queue. */
const DEFAULT_SETUP: Setup = {
  queueOn: true,
  producerRate: 100,
  workers: 3,
  workerRate: 20,
  bounded: true,
  maxDepth: 500,
  timeoutMs: 2000,
  retries: false,
  failureRate: 0.3,
  maxAttempts: 3,
  retryDelay: 2,
};

/**
 * The Lab focus of each Concept that hosts this lab - the setup that shows its
 * main idea first.
 */
const FOCUS_SETUPS: Record<LabFocus<'queue'>, Setup> = {
  // Producers, the queue and consumers: the same 100 in / 60 out as its Diagram.
  'message-queues': { ...DEFAULT_SETUP },
  // Slow jobs (1 s each) off the request path: users get 202 in 20 ms.
  'background-workers': { ...DEFAULT_SETUP, producerRate: 3, workers: 4, workerRate: 1, bounded: false },
  // Retries with backoff through the delayed set, and a dead-letter queue.
  'task-queues': { ...DEFAULT_SETUP, producerRate: 40, workers: 3, workerRate: 20, retries: true },
  // A fast producer, a slow consumer and a bounded queue that fills in seconds.
  backpressure: { ...DEFAULT_SETUP, producerRate: 300, workers: 2, workerRate: 40, maxDepth: 1000 },
  // Balanced rates: 100 produced, 3 x 40 = 120 consumed, as in its Diagram.
  'producer-consumer': { ...DEFAULT_SETUP, producerRate: 100, workers: 3, workerRate: 40 },
  // No queue: callers wait for slow workers (333 ms each, 9/sec for 12/sec) and time out.
  'request-response': { ...DEFAULT_SETUP, queueOn: false, producerRate: 12, workers: 3, workerRate: 3 },
};

/** Messages that entered the queue in the same tick, with the attempt they are on. */
interface Batch {
  t: number;
  n: number;
  attempt: number;
}

interface DelayedTask {
  readyAt: number;
  attempt: number;
}

interface State {
  /** Simulated seconds - stops while paused, so messages do not age. */
  now: number;
  fifo: Batch[];
  head: number;
  depth: number;
  delayed: DelayedTask[];
  produced: number;
  consumed: number;
  rejected: number;
  timedOut: number;
  wasted: number;
  retried: number;
  deadLettered: number;
  particles: Particle[];
  /** Fractional message carried between frames so slow rates still work. */
  carry: number;
  burstLeft: number;
  /** Smoothed user-visible response time with no queue, in ms. */
  responseMs: number;
  /** Smoothed share of callers that timed out with no queue. */
  timeoutShare: number;
  /** Smoothed worker utilisation, 0..1. */
  busy: number;
  nextWorker: number;
  flags: { full: boolean; overBound: boolean; timeout: boolean; dlq: boolean };
}

const createState = (): State => ({
  now: 0,
  fifo: [],
  head: 0,
  depth: 0,
  delayed: [],
  produced: 0,
  consumed: 0,
  rejected: 0,
  timedOut: 0,
  wasted: 0,
  retried: 0,
  deadLettered: 0,
  particles: [],
  carry: 0,
  burstLeft: 0,
  responseMs: 0,
  timeoutShare: 0,
  busy: 0,
  nextWorker: 0,
  flags: { full: false, overBound: false, timeout: false, dlq: false },
});

function pushBatch(state: State, t: number, n: number, attempt: number) {
  if (n <= 0) return;
  state.fifo.push({ t, n, attempt });
  state.depth += n;
}

/** Takes `count` messages from the front, oldest first, and reports each slice. */
function takeFront(state: State, count: number, visit: (t: number, attempt: number, n: number) => void) {
  let left = count;
  while (left > 0 && state.head < state.fifo.length) {
    const batch = state.fifo[state.head];
    const take = Math.min(left, batch.n);
    visit(batch.t, batch.attempt, take);
    batch.n -= take;
    state.depth -= take;
    left -= take;
    if (batch.n === 0) state.head += 1;
  }
  if (state.head > 512) {
    state.fifo = state.fifo.slice(state.head);
    state.head = 0;
  }
}

const oldestAge = (state: State) => (state.head < state.fifo.length ? state.now - state.fifo[state.head].t : 0);

export function QueueLab({ focus }: LabProps<'queue'>) {
  // The page keys this lab by Concept, so the focus never changes under a mounted lab.
  const start = focus ? FOCUS_SETUPS[focus] : DEFAULT_SETUP;
  // Every control lives in one object, so Reset cannot miss one.
  const { setup, setSetup, change } = useLabSetup(start);
  const { queueOn, producerRate, workers, workerRate, bounded, maxDepth, timeoutMs, retries, failureRate, maxAttempts, retryDelay } =
    setup;

  const [running, setRunning] = useLabRunning();
  const state = useRef<State>(createState());
  const rerender = useRerender(30);
  const { events, log, clear } = useEventLog();
  const { points, push, reset: resetSeries } = useSeries(60, 400);

  const resetSimulation = useCallback(() => {
    state.current = createState();
    clear();
    resetSeries();
  }, [clear, resetSeries]);

  const consumerRate = workers * workerRate;
  const jobMs = 1000 / workerRate;
  const retriesOn = queueOn && retries;

  useTicker(running, (dt) => {
    const current = state.current;
    current.now += dt;
    const now = current.now;
    const timeoutS = timeoutMs / 1000;
    const jobS = 1 / workerRate;

    const emit = (route: string[], outcome: RequestOutcome, share: number, speed = 1.6) => {
      if (Math.random() < share) {
        current.particles.push({ id: nextParticleId(), route, leg: 0, t: 0, speed, outcome });
      }
    };
    const pickWorker = () => {
      current.nextWorker = (current.nextWorker + 1) % workers;
      return `w${current.nextWorker}`;
    };

    // A bound lowered under the current depth (or retries re-entering a full queue)
    // keeps the excess - a broker refuses new publishes, it does not delete
    // accepted messages - and says so once.
    if (queueOn && bounded && current.depth > maxDepth) {
      if (!current.flags.overBound) {
        current.flags.overBound = true;
        current.flags.full = true;
        log(
          `Queue is over its bound (${formatNumber(current.depth)} > ${formatNumber(maxDepth)}) - refusing new messages until it drains`,
          'warn',
        );
      }
    } else {
      current.flags.overBound = false;
    }

    // Produce
    const burst = current.burstLeft > 0 ? BURST_RATE : 0;
    current.burstLeft = Math.max(0, current.burstLeft - dt);
    const arrivalRate = producerRate + burst;
    const arrivals = sampleArrivals(arrivalRate, dt);
    const space = queueOn && bounded ? Math.max(0, maxDepth - current.depth) : Infinity;
    const accepted = Math.min(arrivals, space);
    const refused = arrivals - accepted;
    pushBatch(current, now, accepted, 1);
    current.produced += accepted;
    const arrivalShare = visualShare(arrivalRate, PARTICLES_PER_SECOND);
    for (let index = 0; index < accepted; index += 1) {
      emit(queueOn ? ['users', 'api', 'queue'] : ['users', 'api'], 'success', arrivalShare);
    }
    if (refused > 0) {
      current.rejected += refused;
      for (let index = 0; index < refused; index += 1) emit(['queue', 'api', 'users'], 'failure', arrivalShare);
      if (!current.flags.full) {
        current.flags.full = true;
        log(`Queue full at ${formatNumber(maxDepth)} - the API refuses new work and users get 429 (backpressure)`, 'danger');
      }
    }

    // Delayed tasks whose backoff has passed go back into the queue (also after
    // retries are switched off, so no accepted task is stranded there).
    if (queueOn && current.delayed.length) {
      const waiting: DelayedTask[] = [];
      for (const task of current.delayed) {
        if (task.readyAt <= now) {
          pushBatch(current, now, 1, task.attempt);
          emit(['delayed', 'queue'], 'warning', 0.5);
        } else {
          waiting.push(task);
        }
      }
      current.delayed = waiting;
    }

    // With no queue, a caller still waiting at its timeout gives up.
    let timedOutNow = 0;
    if (!queueOn) {
      while (current.head < current.fifo.length && now - current.fifo[current.head].t >= timeoutS) {
        const batch = current.fifo[current.head];
        timedOutNow += batch.n;
        current.depth -= batch.n;
        current.head += 1;
      }
    }

    // Consume
    const capacity = consumerRate * dt + current.carry;
    const whole = Math.floor(capacity);
    current.carry = capacity - whole;
    const taken = Math.min(whole, current.depth);
    const workShare = visualShare(consumerRate, PARTICLES_PER_SECOND);
    let answeredNow = 0;

    takeFront(current, taken, (t, attempt, n) => {
      if (!queueOn) {
        const age = now - t;
        if (age + jobS > timeoutS) {
          // Picked up too late: the caller is gone before the answer is ready.
          timedOutNow += n;
          current.wasted += n;
          for (let index = 0; index < n; index += 1) emit(['api', pickWorker(), 'api', 'users'], 'failure', workShare, 2);
          return;
        }
        answeredNow += n;
        current.consumed += n;
        const sample = ACK_MS + (age + jobS) * 1000;
        current.responseMs += (sample - current.responseMs) * Math.min(1, 0.08 * n);
        for (let index = 0; index < n; index += 1) emit(['api', pickWorker(), 'api', 'users'], 'success', workShare, 2);
        return;
      }
      for (let index = 0; index < n; index += 1) {
        const worker = pickWorker();
        if (retriesOn && Math.random() < failureRate) {
          if (attempt < maxAttempts) {
            current.retried += 1;
            current.delayed.push({ readyAt: now + retryDelay * 2 ** (attempt - 1), attempt: attempt + 1 });
            emit(['queue', worker, 'queue', 'delayed'], 'warning', workShare, 2.2);
          } else {
            current.deadLettered += 1;
            emit(['queue', worker, 'queue', 'dlq'], 'failure', Math.max(workShare, 0.5), 2.2);
            if (!current.flags.dlq) {
              current.flags.dlq = true;
              log(`A task failed all ${maxAttempts} attempts and moved to the dead-letter queue - a person has to look at it`, 'warn');
            }
          }
        } else {
          current.consumed += 1;
          emit(['queue', worker], 'success', workShare);
        }
      }
    });

    if (!queueOn) {
      current.timedOut += timedOutNow;
      for (let index = 0; index < Math.min(timedOutNow, 3); index += 1) emit(['api', 'users'], 'failure', 0.6);
      const outcomes = timedOutNow + answeredNow;
      if (outcomes > 0) {
        current.timeoutShare += (timedOutNow / outcomes - current.timeoutShare) * Math.min(1, 0.05 * outcomes);
      }
      if (timedOutNow > 0 && !current.flags.timeout) {
        current.flags.timeout = true;
        log(`Callers time out after ${formatLatency(timeoutMs)} - users see an error while the workers stay busy`, 'danger');
      }
      if (current.timeoutShare < 0.01 && current.depth === 0) current.flags.timeout = false;
    }

    if (current.depth < maxDepth * 0.8) current.flags.full = false;

    const utilisation = consumerRate * dt > 0 ? clamp(taken / (consumerRate * dt), 0, 1) : 0;
    current.busy += (utilisation - current.busy) * Math.min(1, dt * 1.5);

    const { alive } = advanceParticles(current.particles, dt);
    current.particles = alive.slice(-80);

    push({ depth: current.depth, producerRate: arrivalRate, consumerRate }, performance.now());
    rerender();
  });

  const current = state.current;
  // With retries, every task costs 1 + f + f^2 + ... attempts, up to the cap.
  const attemptsPerTask =
    retriesOn && failureRate > 0 ? (1 - failureRate ** maxAttempts) / (1 - failureRate) : 1;
  const loadRate = producerRate * attemptsPerTask;
  const deficit = loadRate - consumerRate;
  // Waiting time for a message entering now = depth / consumption rate.
  const waitSeconds = consumerRate > 0 ? current.depth / consumerRate : Infinity;
  const oldest = oldestAge(current);
  const workerBusy = current.busy;

  // At 8 workers a 106px box clipped "Worker 8" to "Worke...", and the subtitle
  // "10 ms a job" needs about 114px. At 8 workers a tighter 4px gap keeps the
  // row of 8 x 114px inside the 960px canvas.
  const workerGap = workers >= 8 ? 4 : 8;
  const workerWidth = Math.max(114, Math.min(150, (920 - (workers - 1) * workerGap) / workers));
  const xs = spread(workers, 480, workerWidth, workerGap);
  // Every box is placed at the height its content renders at (measured), so none grows
  // past its box and the wires meet each card in the middle.
  const layout: Layout = {
    users: { x: 60, y: 10, w: 170, h: 116 },
    api: { x: 370, y: 10, w: 220, h: 116 },
  };
  if (queueOn) layout.queue = { x: 300, y: 158, w: 360, h: 155 };
  if (retriesOn) {
    layout.delayed = { x: 20, y: 174, w: 230, h: 116 };
    layout.dlq = { x: 710, y: 174, w: 230, h: 116 };
  }
  for (let index = 0; index < workers; index += 1) {
    layout[`w${index}`] = { x: xs[index], y: 356, w: workerWidth, h: 124 };
  }

  const workerIds = Array.from({ length: workers }, (_, index) => `w${index}`);
  const edges: DiagramEdge[] = [
    { from: 'users', to: 'api', tone: 'brand', width: 2 },
    ...(queueOn
      ? [
          { from: 'api', to: 'queue', tone: 'brand' as const, width: 2 },
          ...workerIds.map((id) => ({ from: 'queue', to: id, tone: 'ok' as const })),
        ]
      : workerIds.map((id) => ({ from: 'api', to: id, tone: 'warn' as const }))),
    ...(retriesOn
      ? [
          { from: 'queue', to: 'delayed', tone: 'warn' as const, dashed: true },
          { from: 'queue', to: 'dlq', tone: 'danger' as const },
        ]
      : []),
  ];

  const particleViews: ParticleView[] = current.particles
    .filter((particle) => layout[particle.route[particle.leg]] && layout[particle.route[particle.leg + 1]])
    .map((particle) => ({
      id: particle.id,
      from: particle.route[particle.leg],
      to: particle.route[particle.leg + 1],
      t: particle.t,
      outcome: particle.outcome ?? 'success',
    }));

  // Visual queue: one dot per ~2.5% of the bound (or of 500 when unbounded), capped so the row stays readable.
  const dotScale = bounded ? Math.max(maxDepth, 1) : 500;
  const dots = clamp(Math.round((current.depth / dotScale) * 40), 0, 40);

  const userWaitMs = queueOn ? ACK_MS : current.responseMs;
  const recentlyTimingOut = !queueOn && (current.timeoutShare > 0.02 || current.flags.timeout);

  const metricItems: MetricItem[] = queueOn
    ? [
        {
          key: 'queueDepth',
          label: 'Queue depth',
          value: formatNumber(current.depth),
          tone: bounded && current.depth > maxDepth * 0.7 ? 'danger' : current.depth > 10 ? 'warn' : 'ok',
        },
        {
          key: 'oldest',
          label: 'Oldest message',
          value: formatLatency(oldest * 1000),
          tone: oldest > 5 ? 'danger' : oldest > 1 ? 'warn' : 'ok',
          hint: 'How long the message at the front has waited. It says how far behind the workers are, which depth alone does not.',
          simulated: true,
        },
        {
          key: 'userWait',
          label: 'User waits',
          value: formatLatency(ACK_MS),
          tone: 'ok',
          hint: 'The API only validates and enqueues, then answers 202 Accepted. The slow work happens later, in a worker.',
          simulated: true,
        },
        {
          key: 'jobDone',
          label: 'Job done after',
          value: Number.isFinite(waitSeconds) ? formatLatency((waitSeconds + 1 / workerRate) * 1000) : 'never',
          tone: waitSeconds > 5 ? 'danger' : 'neutral',
          hint: 'For a message entering now: the wait in the queue (depth divided by capacity) plus one job in a worker.',
          simulated: true,
        },
        {
          key: 'consumerRate',
          label: 'Capacity',
          value: consumerRate,
          unit: 'msg/sec',
          tone: consumerRate >= loadRate ? 'ok' : 'danger',
          hint: 'Total processing capacity: workers x per-worker rate.',
        },
        {
          key: 'rejected',
          label: 'Rejected',
          value: formatNumber(current.rejected),
          tone: current.rejected > 0 ? 'danger' : 'ok',
          hint: 'Messages refused because the bounded queue was full - this is backpressure.',
        },
        { key: 'consumedTotal', label: 'Processed', value: formatNumber(current.consumed), hint: 'Total messages successfully processed.' },
        ...(retriesOn
          ? [
              {
                key: 'retried',
                label: 'Retries',
                value: formatNumber(current.retried),
                tone: 'warn' as const,
                hint: 'Failed attempts sent to the delayed set to run again after a backoff.',
              },
              {
                key: 'dlq',
                label: 'Dead-lettered',
                value: formatNumber(current.deadLettered),
                tone: current.deadLettered > 0 ? ('danger' as const) : ('ok' as const),
                hint: 'Tasks that failed every attempt. They wait in the dead-letter queue for a person, not for another retry.',
              },
            ]
          : []),
      ]
    : [
        {
          key: 'waiting',
          label: 'Callers waiting',
          value: formatNumber(current.depth),
          tone: current.depth > workers ? 'warn' : 'ok',
          hint: 'Requests holding an open connection while they wait for a free worker.',
        },
        {
          key: 'response',
          label: 'User waits',
          value: current.consumed > 0 ? formatLatency(current.responseMs) : '-',
          tone: current.responseMs > timeoutMs * 0.7 ? 'danger' : current.responseMs > 1000 ? 'warn' : 'neutral',
          hint: 'Recent response time of answered requests: the API, any wait for a free worker, and the whole job.',
          simulated: true,
        },
        {
          key: 'timedOut',
          label: 'Timed out',
          value: formatNumber(current.timedOut),
          tone: current.timedOut > 0 ? 'danger' : 'ok',
          hint: `Callers that gave up after ${formatLatency(timeoutMs)} and saw an error.`,
        },
        {
          key: 'wasted',
          label: 'Wasted work',
          value: formatNumber(current.wasted),
          tone: current.wasted > 0 ? 'warn' : 'ok',
          hint: 'Jobs a worker finished after the caller had already timed out. Nobody reads the answer.',
        },
        {
          key: 'consumerRate',
          label: 'Capacity',
          value: consumerRate,
          unit: 'req/sec',
          tone: consumerRate >= producerRate ? 'ok' : 'danger',
          hint: 'Total processing capacity: workers x per-worker rate.',
        },
        { key: 'consumedTotal', label: 'Answered', value: formatNumber(current.consumed), hint: 'Requests answered within the timeout.' },
      ];

  const insight = !queueOn ? (
    recentlyTimingOut ? (
      <>
        No queue, so every user waits for a worker. {formatNumber(current.depth)} callers hold a connection right now, and
        a caller that is not answered within {formatLatency(timeoutMs)} gets an error ({formatNumber(current.timedOut)} so
        far). Workers still finish some of those jobs for nobody - {formatNumber(current.wasted)} wasted results. Add
        workers, make them faster, or turn the queue on: the API then answers in {ACK_MS} ms and the backlog becomes a
        delay instead of errors.
      </>
    ) : (
      <>
        No queue: each user waits for the whole job - about {formatLatency(userWaitMs)} here, the{' '}
        {formatLatency(jobMs)} of work plus the API and any wait for a free worker. The answer is immediate and simple to
        handle, but the user now waits on the slowest part. Lower Worker speed and watch the wait grow until callers time
        out.
      </>
    )
  ) : retriesOn ? (
    <>
      {formatPercent(failureRate)} of attempts fail. A failed task waits in Delayed tasks - {retryDelay} s, then{' '}
      {retryDelay * 2} s - and runs again; after {maxAttempts} failed attempts it moves to the dead-letter queue (
      {formatNumber(current.deadLettered)} so far, about {formatPercent(failureRate ** maxAttempts, 1)} of tasks).
      Retries are extra load: workers handle about {formatNumber(loadRate)} attempts/sec for {producerRate} new tasks/sec
      {deficit > 0 ? `, more than the ${consumerRate} they can do, so the queue grows.` : '.'}
    </>
  ) : deficit > 0 ? (
    <>
      Producers send {producerRate} msg/sec, {workers} workers consume {consumerRate} msg/sec. The queue grows by{' '}
      {formatNumber(deficit)} msg/sec and a message entering now waits about{' '}
      {Number.isFinite(waitSeconds) ? `${Math.round(waitSeconds)}s` : 'forever'}.{' '}
      {bounded
        ? `At ${formatNumber(maxDepth)} messages the queue refuses new work and the API answers 429 - backpressure.`
        : 'Unbounded, it only grows until memory runs out.'}{' '}
      Add workers, make each worker faster, or produce less - a bigger queue only delays the problem.
    </>
  ) : current.depth > workers * 2 ? (
    <>
      Consumption ({consumerRate} msg/sec) exceeds production ({producerRate} msg/sec), so the backlog is draining. This
      is what a queue is for: it turned a spike into a delay instead of dropped work.
    </>
  ) : (
    <>
      Workers keep up: {consumerRate} msg/sec of capacity for {producerRate} msg/sec produced. Users get their answer in{' '}
      {ACK_MS} ms while each job takes {formatLatency(jobMs)} in a worker - the slow work is off the request path. Send a
      burst to see the queue absorb it, or turn the queue off to make users wait for the job.
    </>
  );

  return (
    <LabShell
      title="Message Queue Lab"
      description="Users, an API that produces work, a queue, and workers that consume it. Turn the queue off to make users wait for the workers."
      running={running}
      onRunningChange={setRunning}
      onReset={() => {
        // Back to this Concept's starting setup, not the lab's global default.
        setSetup(start);
        resetSimulation();
      }}
      actions={
        <Button
          variant="secondary"
          onClick={() => {
            state.current.burstLeft = BURST_SECONDS;
            log(`Burst: ${formatNumber(BURST_RATE * BURST_SECONDS)} extra requests over ${BURST_SECONDS} s`, 'info');
          }}
        >
          <Zap className="h-4 w-4" />
          Send a burst
        </Button>
      }
      events={events}
      legend={
        <div className="flex flex-wrap items-center justify-between gap-2">
          <ParticleLegend
            outcomes={[
              { outcome: 'success', label: 'Message or request' },
              { outcome: 'warning', label: 'Failed task, retried later' },
              { outcome: 'failure', label: 'Refused, timed out or dead-lettered' },
            ]}
          />
          <span className="text-[11px] text-faint">
            Dots are a sample of the traffic, not every message. {SIMULATED_HINT}
          </span>
        </div>
      }
      insight={<Insight>{insight}</Insight>}
      metrics={
        <>
          <MetricsPanel items={metricItems} />
          <div className="card p-4">
            <p className="label mb-3">{queueOn ? 'Queue depth over time' : 'Callers waiting over time'}</p>
            <LiveChart
              data={points}
              series={[{ key: 'depth', label: queueOn ? 'Depth' : 'Waiting', color: 'warn' }]}
              height={150}
            />
            <p className="label mb-2 mt-4">Production vs worker capacity</p>
            <LiveChart
              data={points}
              series={[
                { key: 'producerRate', label: 'Produced/sec', color: 'brand' },
                { key: 'consumerRate', label: 'Capacity/sec', color: 'ok', dashed: true },
              ]}
              variant="line"
              height={140}
            />
          </div>
        </>
      }
      controls={
        <>
          <Toggle
            label="Queue"
            checked={queueOn}
            onChange={(value) => {
              change('queueOn')(value);
              resetSimulation();
            }}
            description="Off: the API calls a worker and the user waits for the result (request/response)"
          />
          <Slider
            label="Producer rate"
            value={producerRate}
            min={0}
            max={500}
            step={1}
            onChange={change('producerRate')}
            format={(value) => `${value} msg/sec`}
            tone={deficit > 0 ? 'danger' : 'brand'}
          />
          <Stepper
            label="Workers"
            value={workers}
            min={1}
            max={8}
            onChange={change('workers')}
            hint="Consumers pulling from the queue."
          />
          <Slider
            label="Worker speed"
            value={workerRate}
            min={1}
            max={100}
            onChange={change('workerRate')}
            format={(value) => `${value} msg/sec each (${formatLatency(1000 / value)} a job)`}
            hint="How fast one worker processes messages. A job takes 1 / speed seconds."
          />
          {queueOn ? (
            <>
              <Toggle
                label="Bounded queue"
                checked={bounded}
                onChange={change('bounded')}
                description="Off: unbounded buffering - a memory leak with a timer"
              />
              <Slider
                label="Max depth"
                value={maxDepth}
                min={50}
                max={5000}
                step={50}
                onChange={change('maxDepth')}
                disabled={!bounded}
                format={(value) => `${formatNumber(value)} messages`}
                hint="When the queue is full, producers are rejected instead of buffered."
              />
              <Toggle
                label="Task failures and retries"
                checked={retries}
                onChange={change('retries')}
                description="Failed tasks retry after a backoff, then go to a dead-letter queue"
              />
              {retries ? (
                <>
                  <Slider
                    label="Failure rate"
                    value={failureRate}
                    min={0}
                    max={0.9}
                    step={0.05}
                    onChange={change('failureRate')}
                    format={(value) => `${Math.round(value * 100)}% of attempts`}
                    tone="danger"
                  />
                  <Stepper
                    label="Max attempts"
                    value={maxAttempts}
                    min={1}
                    max={6}
                    onChange={change('maxAttempts')}
                    hint="After the last failed attempt the task goes to the dead-letter queue."
                  />
                  <Slider
                    label="Retry delay"
                    value={retryDelay}
                    min={1}
                    max={10}
                    onChange={change('retryDelay')}
                    format={(value) => `${value} s, then doubling`}
                    hint="A delayed task becomes visible again after this wait. Exponential backoff doubles it per attempt (this Lab adds no jitter)."
                  />
                </>
              ) : null}
            </>
          ) : (
            <Slider
              label="Caller timeout"
              value={timeoutMs}
              min={500}
              max={10000}
              step={500}
              onChange={change('timeoutMs')}
              format={(value) => formatLatency(value)}
              hint="How long a user waits for the answer before giving up with an error."
            />
          )}
          <div className="border-t border-line pt-4">
            <p className="label mb-2">Capacity balance</p>
            <Meter
              value={consumerRate > 0 ? clamp(loadRate / consumerRate, 0, 1.4) : 1}
              label={`${formatNumber(loadRate)} in / ${consumerRate} out`}
              tone={deficit > 0 ? 'danger' : 'ok'}
            />
            <p className="mt-2 text-[11px] text-faint">
              Stable when consumption is at least production{retriesOn ? ' plus retries' : ''}. Everything else is a
              backlog with a start time.
            </p>
          </div>
        </>
      }
    >
      <DiagramCanvas layout={layout} edges={edges} particles={particleViews} height={490} className="bg-canvas">
        <ArchNode kind="client" title="Users" subtitle={`${producerRate} req/sec`} placed={layout.users} compact>
          <NodeStatRow
            label="Wait"
            value={queueOn || current.consumed > 0 ? formatLatency(userWaitMs) : '-'}
            tone={userWaitMs > 1000 ? 'text-danger' : 'text-ok'}
          />
          <NodeStatRow
            label={queueOn ? '429s' : 'Timeouts'}
            value={formatNumber(queueOn ? current.rejected : current.timedOut)}
            tone={(queueOn ? current.rejected : current.timedOut) ? 'text-danger' : 'text-ok'}
          />
        </ArchNode>

        <ArchNode
          kind="server"
          title="API"
          subtitle={queueOn ? 'producer: enqueue, 202' : 'calls a worker, waits'}
          placed={layout.api}
          alert={recentlyTimingOut}
          compact
        >
          {queueOn ? (
            <NodeStatRow label="Answers in" value={formatLatency(ACK_MS)} tone="text-ok" />
          ) : (
            <NodeStatRow
              label="Callers waiting"
              value={formatNumber(current.depth)}
              tone={current.depth > workers ? 'text-warn' : 'text-ink'}
            />
          )}
          <NodeStatRow label="Produced" value={formatNumber(current.produced)} />
        </ArchNode>

        {queueOn ? (
          <ArchNode
            kind="queue"
            title="Message Queue"
            subtitle={bounded ? `bounded at ${formatNumber(maxDepth)}` : 'unbounded'}
            placed={layout.queue}
            alert={bounded && current.depth > maxDepth * 0.8}
            status={bounded && current.depth >= maxDepth ? 'degraded' : 'healthy'}
          >
            <NodeStatRow label="Depth" value={formatNumber(current.depth)} tone={current.depth > 100 ? 'text-warn' : 'text-ink'} />
            <NodeStatRow label="Oldest" value={formatLatency(oldest * 1000)} tone={oldest > 5 ? 'text-danger' : 'text-ink'} />
            <div className="flex flex-wrap gap-1 pt-1" aria-hidden>
              {Array.from({ length: dots }, (_, index) => (
                <span
                  key={index}
                  className={`h-2 w-2 rounded-full ${index > 32 ? 'bg-danger' : index > 24 ? 'bg-warn' : 'bg-brand'}`}
                />
              ))}
              {dots === 0 ? <span className="text-[11px] text-faint">empty</span> : null}
            </div>
          </ArchNode>
        ) : null}

        {retriesOn ? (
          <>
            <ArchNode kind="queue" title="Delayed tasks" subtitle={`retry in ${retryDelay} s, ${retryDelay * 2} s...`} placed={layout.delayed} compact>
              <NodeStatRow label="Waiting" value={formatNumber(current.delayed.length)} tone={current.delayed.length ? 'text-warn' : 'text-ink'} />
              <NodeStatRow label="Retries" value={formatNumber(current.retried)} />
            </ArchNode>
            <ArchNode
              kind="queue"
              title="Dead-letter queue"
              subtitle={`after ${maxAttempts} failed attempts`}
              placed={layout.dlq}
              alert={current.deadLettered > 0}
              compact
            >
              <NodeStatRow label="Messages" value={formatNumber(current.deadLettered)} tone={current.deadLettered ? 'text-danger' : 'text-ok'} />
              <NodeStatRow label="Retried" value="never" tone="text-muted" />
            </ArchNode>
          </>
        ) : null}

        {workerIds.map((id, index) => (
          <ArchNode key={id} kind="worker" title={`Worker ${index + 1}`} subtitle={`${formatLatency(jobMs)} a job`} placed={layout[id]} compact>
            <NodeStatRow label="Rate" value={`${workerRate}/sec`} />
            <Meter label="Busy" value={workerBusy} size="xs" showValue={false} />
          </ArchNode>
        ))}
      </DiagramCanvas>
    </LabShell>
  );
}

export default QueueLab;
