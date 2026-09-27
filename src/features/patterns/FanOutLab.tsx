import { useReducer, useRef, useState } from 'react';
import { Send } from 'lucide-react';
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
import { Button, Meter, SegmentedControl, Slider } from '@/components/ui';
import { advanceParticles, nextParticleId, useEventLog, useTicker, type Particle } from '@/simulations/engine';
import { useRerender } from '@/hooks/useRerender';
import { formatCompact, formatLatency, formatNumber, formatSecondsMinSec } from '@/utils/format';
import { useLabRunning } from '@/hooks/useLabRunning';

type Strategy = 'write' | 'read' | 'hybrid';

interface Setup {
  strategy: Strategy;
  /** Index into FOLLOWER_STEPS. */
  followerStep: number;
  /** Accounts each reader follows. */
  following: number;
}

/** Follower counts the slider moves through: from the median account up to a celebrity. */
const FOLLOWER_STEPS = [150, 1_000, 5_000, 50_000, 1_000_000, 10_000_000, 50_000_000];

/** What the lab opens on: fan-out on write for an account with 5,000 followers, as in the Diagram. */
const DEFAULT_SETUP: Setup = { strategy: 'write', followerStep: 2, following: 200 };

const STRATEGIES: { value: Strategy; label: string }[] = [
  { value: 'write', label: 'On write' },
  { value: 'read', label: 'On read' },
  { value: 'hybrid', label: 'Hybrid' },
];

// Simplified numbers, not measurements. They are picked to land near what Twitter
// reported publicly in 2013: an account with 1 million followers took "a couple of
// seconds" to fan out, and the largest accounts took minutes.
/** Timeline writes the fan-out workers finish per simulated second, all posts together. */
const WRITE_RATE = 300_000;
/** One real second of the lab stands for ten simulated seconds. */
const TIME_SCALE = 10;
/** The author publishes a post every two simulated minutes. */
const POST_EVERY_SIM_S = 120;
/** Hybrid: accounts with this many followers or more are pulled at read time. */
const HYBRID_THRESHOLD = 10_000;
/** Feed read latency model: one cache or index lookup, plus a cost per followed account merged. */
const LOOKUP_MS = 2;
const PER_SOURCE_MS = 0.1;
const CELEBRITY_FETCH_MS = 3;
/** Timelines keep only their newest entries (Twitter kept 800 per home timeline). */
const TIMELINE_CAP = 800;

interface Job {
  post: number;
  total: number;
  done: number;
  /** Simulated clock when the post was published. */
  queuedAt: number;
}

interface State {
  particles: Particle[];
  jobs: Job[];
  /** Simulated seconds since the lab started. */
  clock: number;
  /** Simulated seconds until the author posts again. */
  untilPost: number;
  posts: number;
  timelineWrites: number;
  /** Seconds the last pushed post took to reach its last follower. */
  lastDelay: number | null;
  writeEmit: number;
  readEmit: number;
}

const createState = (): State => ({
  particles: [],
  jobs: [],
  clock: 0,
  untilPost: 20,
  posts: 0,
  timelineWrites: 0,
  lastDelay: null,
  writeEmit: 0,
  readEmit: 0,
});

/** Whether a post by this author is pushed into follower timelines. */
const pushes = (strategy: Strategy, followers: number) =>
  strategy === 'write' || (strategy === 'hybrid' && followers < HYBRID_THRESHOLD);

const LAYOUT: Layout = {
  author: { x: 20, y: 20, w: 170, h: 96 },
  postsvc: { x: 240, y: 20, w: 190, h: 96 },
  queue: { x: 480, y: 20, w: 190, h: 96 },
  worker: { x: 720, y: 20, w: 220, h: 116 },
  posts: { x: 240, y: 200, w: 190, h: 116 },
  graph: { x: 480, y: 200, w: 190, h: 96 },
  timelines: { x: 720, y: 200, w: 220, h: 116 },
  followers: { x: 20, y: 386, w: 170, h: 96 },
  feed: { x: 480, y: 386, w: 190, h: 116 },
};

const PARTICLE_BUDGET = 110;

export function FanOutLab() {
  const [setup, setSetup] = useState<Setup>(DEFAULT_SETUP);
  const { strategy, followerStep, following } = setup;
  const followers = FOLLOWER_STEPS[followerStep];
  const [running, setRunning] = useLabRunning();
  const state = useRef<State>(createState());
  const rerender = useRerender(30);
  // Button actions must repaint even when the throttled rerender skips a frame.
  const [, bump] = useReducer((value: number) => value + 1, 0);
  const { events, log, clear } = useEventLog();

  const push = pushes(strategy, followers);
  const celebrity = followers >= HYBRID_THRESHOLD;
  /** How a follower's feed read is assembled. */
  const readPlan: 'timeline' | 'merge' | 'timeline+pull' =
    strategy === 'write' ? 'timeline' : strategy === 'read' ? 'merge' : celebrity ? 'timeline+pull' : 'timeline';

  const writesPerPost = push ? followers : 0;
  const queriesPerRead = readPlan === 'timeline' ? 1 : readPlan === 'merge' ? 1 + following : 2;
  const readLatencyMs =
    readPlan === 'timeline'
      ? LOOKUP_MS
      : readPlan === 'merge'
        ? LOOKUP_MS + PER_SOURCE_MS * following
        : LOOKUP_MS + CELEBRITY_FETCH_MS;

  const publish = (sim: State, manual: boolean) => {
    sim.posts += 1;
    const post = sim.posts;
    sim.particles.push({
      id: nextParticleId(),
      route: ['author', 'postsvc', 'posts'],
      leg: 0,
      t: 0,
      speed: 1.6,
      outcome: 'success',
    });
    if (push) {
      sim.jobs.push({ post, total: followers, done: 0, queuedAt: sim.clock });
      sim.particles.push({
        id: nextParticleId(),
        route: ['author', 'postsvc', 'queue', 'worker', 'graph'],
        leg: 0,
        t: 0,
        speed: 1.6,
        outcome: 'success',
      });
      const backlog = sim.jobs.reduce((sum, job) => sum + job.total - job.done, 0);
      log(
        `Post #${post}${manual ? '' : ' (every 2 min)'}: stored once, then ${formatNumber(followers)} timeline writes queued - ${formatCompact(
          backlog,
        )} waiting in total`,
        backlog / WRITE_RATE > POST_EVERY_SIM_S ? 'warn' : 'info',
      );
    } else {
      log(
        `Post #${post}: stored once, 0 timeline writes - followers ${
          strategy === 'read' ? 'merge it in when they read' : 'pull it in at read time (celebrity)'
        }`,
        'ok',
      );
    }
  };

  useTicker(running, (dt) => {
    const sim = state.current;
    const simDt = dt * TIME_SCALE;
    sim.clock += simDt;

    sim.untilPost -= simDt;
    if (sim.untilPost <= 0) {
      sim.untilPost += POST_EVERY_SIM_S;
      publish(sim, false);
    }

    // Fan-out workers drain the queue in order: an old post blocks the ones behind it.
    let capacity = WRITE_RATE * simDt;
    let wrote = 0;
    while (capacity > 0 && sim.jobs.length) {
      const job = sim.jobs[0];
      const step = Math.min(capacity, job.total - job.done);
      job.done += step;
      capacity -= step;
      wrote += step;
      if (job.done >= job.total) {
        sim.jobs.shift();
        sim.lastDelay = sim.clock - job.queuedAt;
        log(
          `Post #${job.post} reached all ${formatNumber(job.total)} timelines after ${formatSecondsMinSec(sim.lastDelay)}`,
          sim.lastDelay > 60 ? 'warn' : 'ok',
        );
      }
    }
    sim.timelineWrites += wrote;

    // Particles are a sample: one dot stands for many timeline writes.
    if (sim.jobs.length) {
      sim.writeEmit += dt;
      const late = (sim.clock - sim.jobs[0].queuedAt) > 60;
      while (sim.writeEmit > 0.09) {
        sim.writeEmit -= 0.09;
        sim.particles.push({
          id: nextParticleId(),
          route: ['worker', 'timelines'],
          leg: 0,
          t: 0,
          speed: 1.5 + Math.random() * 0.4,
          outcome: late ? 'warning' : 'success',
        });
      }
    }

    // Followers open their feeds all the time; the dots are a sample of those reads.
    sim.readEmit += dt;
    while (sim.readEmit > 0.45) {
      sim.readEmit -= 0.45;
      const route =
        readPlan === 'timeline'
          ? ['followers', 'feed', 'timelines', 'feed', 'followers']
          : readPlan === 'merge'
            ? ['followers', 'feed', 'graph', 'feed', 'posts', 'feed', 'followers']
            : ['followers', 'feed', 'timelines', 'feed', 'posts', 'feed', 'followers'];
      sim.particles.push({ id: nextParticleId(), route, leg: 0, t: 0, speed: 1.7, outcome: 'success' });
      if (readPlan === 'merge') {
        // One query per followed account: show a burst, more dots for more accounts.
        const burst = Math.min(8, Math.max(2, Math.round(following / 150)));
        for (let index = 0; index < burst; index += 1) {
          sim.particles.push({
            id: nextParticleId(),
            route: ['feed', 'posts', 'feed'],
            leg: 0,
            t: -3 - 0.2 * index,
            speed: 1.7,
            outcome: following > 1000 ? 'warning' : 'success',
          });
        }
      }
    }

    const { alive } = advanceParticles(sim.particles, dt);
    sim.particles = alive.length > PARTICLE_BUDGET ? alive.slice(-PARTICLE_BUDGET) : alive;
    rerender();
  });

  const restart = (next: Setup, message: string) => {
    setSetup(next);
    state.current = createState();
    log(message, 'info');
  };

  const reset = () => {
    setSetup(DEFAULT_SETUP);
    state.current = createState();
    clear();
    bump();
  };

  const current = state.current;
  const backlog = current.jobs.reduce((sum, job) => sum + job.total - job.done, 0);
  const backlogSeconds = backlog / WRITE_RATE;
  /** A post published now reaches its last follower after the queue ahead of it, plus its own writes. */
  const feedDelay = push ? (backlog + followers) / WRITE_RATE : 0;
  const falling = push && followers / WRITE_RATE > POST_EVERY_SIM_S;
  const head = current.jobs[0];

  const edge = (from: string, to: string, used: boolean, tone: DiagramEdge['tone'] = 'brand'): DiagramEdge =>
    used ? { from, to, tone, width: 2 } : { from, to, tone: 'muted', dashed: true };

  const edges: DiagramEdge[] = [
    edge('author', 'postsvc', true),
    edge('postsvc', 'posts', true),
    edge('postsvc', 'queue', push),
    edge('queue', 'worker', push),
    edge('worker', 'graph', push, 'info'),
    edge('worker', 'timelines', push, falling ? 'danger' : backlogSeconds > 60 ? 'warn' : 'ok'),
    edge('followers', 'feed', true, 'info'),
    edge('feed', 'timelines', readPlan !== 'merge', 'ok'),
    edge('feed', 'graph', readPlan === 'merge', 'info'),
    edge('feed', 'posts', readPlan !== 'timeline', following > 1000 && readPlan === 'merge' ? 'warn' : 'info'),
  ];

  const particles: ParticleView[] = current.particles
    .filter((particle) => particle.t >= 0)
    .map((particle) => ({
      id: particle.id,
      from: particle.route[particle.leg],
      to: particle.route[particle.leg + 1],
      t: particle.t,
      outcome: particle.outcome ?? 'success',
    }));

  const insight = (() => {
    if (strategy === 'read')
      return (
        <>
          The post is written once and nothing else happens: no queue, no workers, no delay. The bill arrives on every
          read instead - each feed asks the follow graph for {formatNumber(following)} accounts, queries each of them
          and merges the results, {formatNumber(queriesPerRead)} queries for one screen. Raise the accounts followed and
          watch the read latency climb; the follower count no longer matters at all.
        </>
      );
    if (strategy === 'hybrid' && celebrity)
      return (
        <>
          This account has {formatCompact(followers)} followers, at or above the {formatCompact(HYBRID_THRESHOLD)}{' '}
          threshold, so its posts are not pushed. Each follower reads the prebuilt timeline and pulls this one
          account's recent posts, 2 queries instead of {formatNumber(1 + following)}. Everyone below the threshold
          is still pushed, so most reads stay a single lookup.
        </>
      );
    if (falling)
      return (
        <>
          {formatCompact(followers)} timeline writes per post take {formatSecondsMinSec(followers / WRITE_RATE)}, but the author
          posts every {POST_EVERY_SIM_S / 60} minutes. The queue never drains, so the feed delay keeps growing - for
          this author and for every post queued behind it. This is the celebrity problem: switch to Hybrid.
        </>
      );
    return (
      <>
        Each post becomes {formatNumber(followers)} timeline writes, and each feed read is one lookup of a list that is
        already built ({formatLatency(LOOKUP_MS)}). The cost is paid once at write time, proportional to followers. Now
        drag the follower count toward a celebrity and watch the write cost and the feed delay.
      </>
    );
  })();

  return (
    <LabShell
      title="Fan-out Lab"
      description="An author posts and followers read their feeds. Pick where the work happens - on write, on read, or a hybrid - and how many followers the author has."
      running={running}
      onRunningChange={setRunning}
      onReset={reset}
      legend={
        <ParticleLegend
          outcomes={[
            { outcome: 'success', label: 'Post, write or read' },
            { outcome: 'warning', label: 'Late write or heavy merge' },
          ]}
        />
      }
      events={events}
      insight={<Insight>{insight}</Insight>}
      metrics={
        <MetricsPanel
          items={[
            {
              key: 'write-cost',
              label: 'Timeline writes per post',
              value: formatNumber(writesPerPost),
              tone: writesPerPost >= 1_000_000 ? 'danger' : writesPerPost >= 50_000 ? 'warn' : 'ok',
              hint: 'Write amplification: one post becomes one timeline entry per follower when it is pushed.',
            },
            {
              key: 'read-cost',
              label: 'Queries per feed read',
              value: formatNumber(queriesPerRead),
              tone: queriesPerRead > 500 ? 'danger' : queriesPerRead > 2 ? 'warn' : 'ok',
              hint: 'On read: one follow graph lookup plus one query per followed account. On write: one timeline lookup.',
            },
            {
              key: 'feed-delay',
              label: 'Feed delay',
              value: push ? formatSecondsMinSec(feedDelay) : 'none',
              sub: push ? 'until the last follower sees a new post' : 'the next read sees it',
              tone: feedDelay > 60 ? 'danger' : feedDelay > 5 ? 'warn' : 'ok',
              hint: `Pushed posts wait for the queue ahead of them, then take followers / ${formatCompact(WRITE_RATE)} writes a second.`,
              simulated: true,
            },
            {
              key: 'read-latency',
              label: 'Feed read latency',
              value: formatLatency(readLatencyMs),
              tone: readLatencyMs > 100 ? 'danger' : readLatencyMs > 20 ? 'warn' : 'ok',
              hint: `${LOOKUP_MS} ms for a lookup, plus ${PER_SOURCE_MS} ms per followed account merged, or ${CELEBRITY_FETCH_MS} ms to pull a cached celebrity.`,
              simulated: true,
            },
            {
              key: 'copies',
              label: 'Copies of each post',
              value: formatNumber(1 + writesPerPost),
              sub: push ? '1 row + a timeline entry per follower' : 'one row in the posts table',
              tone: writesPerPost > 50_000 ? 'warn' : 'neutral',
              hint: 'Every pushed copy also has to be removed again if the post is deleted.',
            },
            {
              key: 'backlog',
              label: 'Fan-out backlog',
              value: formatCompact(backlog),
              sub: backlog ? `${formatSecondsMinSec(backlogSeconds)} of work` : undefined,
              tone: falling ? 'danger' : backlogSeconds > 60 ? 'warn' : 'ok',
              hint: 'Timeline writes queued and not yet done, for all posts.',
              simulated: true,
            },
          ]}
        />
      }
      controls={
        <>
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted">Fan-out</p>
            <SegmentedControl
              value={strategy}
              options={STRATEGIES}
              onChange={(value) =>
                restart(
                  { ...setup, strategy: value },
                  value === 'write'
                    ? 'Fan-out on write: every post is pushed into every follower timeline'
                    : value === 'read'
                      ? 'Fan-out on read: posts are stored once and merged when a follower reads'
                      : `Hybrid: push for accounts under ${formatCompact(HYBRID_THRESHOLD)} followers, pull the rest at read time`,
                )
              }
              size="sm"
            />
            <p className="text-[11px] text-faint">
              {strategy === 'write'
                ? 'Work at post time, reads are one lookup.'
                : strategy === 'read'
                  ? 'Posts are cheap, every read merges all followed accounts.'
                  : `Accounts with ${formatCompact(HYBRID_THRESHOLD)}+ followers are pulled, the rest pushed.`}
            </p>
          </div>
          <Slider
            label="Followers of the author"
            value={followerStep}
            min={0}
            max={FOLLOWER_STEPS.length - 1}
            step={1}
            onChange={(value) =>
              restart({ ...setup, followerStep: value }, `The author now has ${formatNumber(FOLLOWER_STEPS[value])} followers`)
            }
            format={(value) => formatCompact(FOLLOWER_STEPS[value])}
            scale={['150', '50M (celebrity)']}
            tone={followers >= 1_000_000 ? 'danger' : 'brand'}
          />
          <Slider
            label="Accounts each reader follows"
            value={following}
            min={50}
            max={2000}
            step={50}
            onChange={(value) => setSetup((prev) => ({ ...prev, following: value }))}
            format={(value) => formatNumber(value)}
            hint="What a feed read has to merge under fan-out on read."
          />
          <Button
            className="w-full"
            variant="primary"
            size="sm"
            onClick={() => {
              publish(state.current, true);
              bump();
            }}
          >
            <Send className="h-3.5 w-3.5" />
            Publish a post now
          </Button>
          {head ? (
            <Meter
              label={`Post #${head.post}: ${formatCompact(head.done)} of ${formatCompact(head.total)} timelines`}
              value={head.done / head.total}
              // Progress, not load: without a tone the Meter would turn red as the job nears done.
              tone="brand"
              size="xs"
            />
          ) : null}
          <p className="text-[11px] text-faint">
            Simplified: the workers finish {formatCompact(WRITE_RATE)} timeline writes a second, one lab second stands for{' '}
            {TIME_SCALE} seconds, and the author posts every {POST_EVERY_SIM_S / 60} minutes. Hybrid assumes the other
            accounts a reader follows are under the threshold. Timelines keep only the newest {TIMELINE_CAP} entries.
          </p>
        </>
      }
    >
      <DiagramCanvas layout={LAYOUT} edges={edges} particles={particles} height={510} className="bg-canvas">
        <ArchNode
          kind="client"
          title="Author"
          subtitle={`${formatCompact(followers)} followers`}
          placed={LAYOUT.author}
          status="idle"
          statusLabel={`Posts every ${POST_EVERY_SIM_S / 60} min`}
          compact
        >
          <NodeStatRow label={`${formatCompact(HYBRID_THRESHOLD)} threshold`} value={celebrity ? 'at or over' : 'under'} />
        </ArchNode>
        <ArchNode kind="server" title="Post service" subtitle="stores, then fans out" placed={LAYOUT.postsvc} compact />
        <ArchNode
          kind="queue"
          title="Fan-out queue"
          subtitle={push ? 'one job per post' : 'not used'}
          placed={LAYOUT.queue}
          className={push ? undefined : 'opacity-60'}
          compact
        />
        <ArchNode
          kind="worker"
          title="Fan-out workers"
          subtitle={push ? `${formatCompact(WRITE_RATE)} writes/s` : 'idle'}
          placed={LAYOUT.worker}
          status={falling ? 'degraded' : 'healthy'}
          statusLabel={falling ? 'Falling behind' : undefined}
          alert={falling}
          className={push || backlog ? undefined : 'opacity-60'}
          compact
        >
          <NodeStatRow label="Backlog" value={formatCompact(backlog)} tone={falling ? 'text-danger' : 'text-ink'} />
          <NodeStatRow label="Writes done" value={formatCompact(current.timelineWrites)} />
        </ArchNode>
        <ArchNode kind="sql" title="Posts table" subtitle="each post stored once" placed={LAYOUT.posts} compact>
          <NodeStatRow label="Posts" value={formatNumber(current.posts)} />
          <NodeStatRow
            label="Read by feeds"
            value={readPlan === 'timeline' ? 'no' : readPlan === 'merge' ? `${formatNumber(following)} q/read` : '1 q/read'}
            tone={readPlan === 'merge' && following > 1000 ? 'text-warn' : 'text-ink'}
          />
        </ArchNode>
        <ArchNode kind="nosql" title="Follow graph" subtitle="who follows whom" placed={LAYOUT.graph} compact />
        <ArchNode
          kind="cache"
          title="Timeline cache"
          subtitle="one list per follower"
          placed={LAYOUT.timelines}
          className={readPlan === 'merge' && !backlog ? 'opacity-60' : undefined}
          compact
        >
          <NodeStatRow label="Entries per post" value={formatNumber(writesPerPost)} />
          <NodeStatRow label="Cap per timeline" value={formatNumber(TIMELINE_CAP)} />
        </ArchNode>
        <ArchNode
          kind="client"
          title="Followers"
          subtitle={`each follows ${formatNumber(following)}`}
          placed={LAYOUT.followers}
          statusLabel="Opening feeds"
          compact
        />
        <ArchNode
          kind="server"
          title="Feed service"
          subtitle={readPlan === 'timeline' ? 'reads one timeline' : readPlan === 'merge' ? 'merges on read' : 'timeline + pull'}
          placed={LAYOUT.feed}
          status={readLatencyMs > 100 ? 'degraded' : 'healthy'}
          compact
        >
          <NodeStatRow label="Queries/read" value={formatNumber(queriesPerRead)} />
          <NodeStatRow label="Latency" value={formatLatency(readLatencyMs)} tone={readLatencyMs > 100 ? 'text-danger' : 'text-ink'} />
        </ArchNode>
      </DiagramCanvas>
    </LabShell>
  );
}

export default FanOutLab;
