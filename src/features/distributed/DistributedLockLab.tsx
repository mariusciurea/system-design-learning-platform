import { useCallback, useRef } from 'react';
import { Pause, Power, RotateCw } from 'lucide-react';
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
import { Button, SegmentedControl, Slider, Toggle } from '@/components/ui';
import { nextParticleId, useEventLog, useTicker } from '@/simulations/engine';
import { useLabSetup } from '@/hooks/useLabSetup';
import { useRerender } from '@/hooks/useRerender';
import type { NodeStatus, RequestOutcome } from '@/types';
import { useLabRunning } from '@/hooks/useLabRunning';

/*
 * Simplified model, not a measurement. Time is simulated seconds: the clock runs
 * SIM_SPEED times faster than the wall clock, every message takes MSG_S to cross
 * a wire, and a worker needs WORK_S of work between taking the lock and writing.
 * Real leases are usually tens of seconds and real pauses (GC, a stalled VM, a
 * swapped-out process) are unbounded - the numbers are sized so one run fits
 * on screen, the order of events is what is real.
 */
const SIM_SPEED = 1.5;
const MSG_S = 0.5;
const WORK_S = 4;
const RETRY_S = 1;
const COOLDOWN_S = 2;

type WorkerId = 'w1' | 'w2' | 'w3';
type NodeId = WorkerId | 'lock' | 'store';
type WorkerCount = 2 | 3;
const ALL_WORKERS: WorkerId[] = ['w1', 'w2', 'w3'];
const NAME: Record<WorkerId, string> = { w1: 'Worker 1', w2: 'Worker 2', w3: 'Worker 3' };
const NUMBER: Record<WorkerId, string> = { w1: '1', w2: '2', w3: '3' };
/** The first attempt of each worker, staggered so the run does not open on a tie. */
const FIRST_WAIT: Record<WorkerId, number> = { w1: 0.2, w2: 0.9, w3: 1.6 };

type Phase = 'idle' | 'acquiring' | 'working' | 'writing' | 'crashed';

interface WorkerState {
  phase: Phase;
  /** Countdown before the next acquire attempt while idle. */
  wait: number;
  /** The fencing token of the lease this worker believes it holds. */
  token: number | null;
  workLeft: number;
  /** Seconds of stop-the-world pause left. Nothing runs in the worker while it is above 0. */
  pauseLeft: number;
  /** Pause as soon as the worker next holds the lock. */
  pauseArmed: boolean;
  /** Replies that arrived while the worker was paused, handled when it wakes. */
  inbox: Message[];
}

interface LockState {
  /** Who the lock service has the key for. Null once released or expired. */
  holder: WorkerId | null;
  /** Token of the current (or last) lease. */
  token: number;
  /** Simulated time the key expires, or null for a lease with no TTL. */
  expiresAt: number | null;
}

interface StoreState {
  highest: number;
  lastWriter: WorkerId | null;
  lastToken: number;
  accepted: number;
  rejected: number;
  /** Writes accepted with a token older than one the storage had already seen: a lost update. */
  overwrites: number;
}

type MessageKind = 'acquire' | 'granted' | 'busy' | 'write' | 'write-ok' | 'write-rejected' | 'release';

interface Message {
  id: number;
  from: NodeId;
  to: NodeId;
  t: number;
  kind: MessageKind;
  worker: WorkerId;
  token: number;
}

interface Sim {
  /** The workers in this run, in order. Every one is wired the same way. */
  ids: WorkerId[];
  time: number;
  nextToken: number;
  workers: Record<WorkerId, WorkerState>;
  lock: LockState;
  store: StoreState;
  messages: Message[];
  twoOwnerEpisodes: number;
  twoOwnersNow: boolean;
}

const newWorker = (wait: number): WorkerState => ({
  phase: 'idle',
  wait,
  token: null,
  workLeft: 0,
  pauseLeft: 0,
  pauseArmed: false,
  inbox: [],
});

/** Tokens start at 41 so the Lab reads like the Diagram: 41 is the paused holder, 42 the next one. */
const createSim = (count: WorkerCount): Sim => ({
  ids: ALL_WORKERS.slice(0, count),
  time: 0,
  nextToken: 41,
  // A record of all three keeps the types simple; only the workers in `ids` ever run.
  workers: { w1: newWorker(FIRST_WAIT.w1), w2: newWorker(FIRST_WAIT.w2), w3: newWorker(FIRST_WAIT.w3) },
  lock: { holder: null, token: 0, expiresAt: null },
  store: { highest: 0, lastWriter: null, lastToken: 0, accepted: 0, rejected: 0, overwrites: 0 },
  messages: [],
  twoOwnerEpisodes: 0,
  twoOwnersNow: false,
});

interface Setup {
  /** How many workers compete for the lock. Changing it starts a new run. */
  workerCount: WorkerCount;
  fencing: boolean;
  ttlOn: boolean;
  ttlS: number;
  pauseS: number;
  checkRelease: boolean;
}

/** One lab, one host Concept, so there is no Lab focus: it always opens on the unsafe lock. */
const DEFAULT_SETUP: Setup = { workerCount: 2, fencing: false, ttlOn: true, ttlS: 8, pauseS: 15, checkRelease: true };

/** A worker that believes it holds the lock: it got a token and has not finished or been refused. */
const believesItHolds = (worker: WorkerState) =>
  worker.token !== null && (worker.phase === 'working' || worker.phase === 'writing');

const OUTCOME: Record<MessageKind, RequestOutcome> = {
  acquire: 'success',
  granted: 'success',
  busy: 'warning',
  write: 'success',
  'write-ok': 'success',
  'write-rejected': 'failure',
  release: 'success',
};

/**
 * Lock service on the left, the workers in one column, storage on the right: every
 * worker has the same two wires (lease, write + token), so no worker looks special.
 * Checked so no wire runs behind a card it does not connect to and every edge
 * label sits in the gap between the cards.
 */
const CANVAS_H = 540;
const WORKER_W = 230;
const WORKER_H = 154;
const WORKER_Y: Record<WorkerCount, number[]> = { 2: [80, 310], 3: [20, 195, 370] };

const buildLayout = (count: WorkerCount): Layout => {
  const layout: Layout = {
    // Tall enough for three stat rows; the storage is wide enough for "refuses a token older than seen".
    lock: { x: 20, y: 193, w: 220, h: 154 },
    store: { x: 715, y: 193, w: 230, h: 154 },
  };
  WORKER_Y[count].forEach((y, index) => {
    layout[ALL_WORKERS[index]] = { x: 365, y, w: WORKER_W, h: WORKER_H };
  });
  return layout;
};

const LAYOUTS: Record<WorkerCount, Layout> = { 2: buildLayout(2), 3: buildLayout(3) };

export function DistributedLockLab() {
  const [running, setRunning] = useLabRunning();
  // Every control lives in one object, so Reset cannot miss one.
  const { setup, setSetup, change } = useLabSetup(DEFAULT_SETUP);
  const { workerCount, fencing, ttlOn, ttlS, pauseS, checkRelease } = setup;
  const sim = useRef<Sim>(createSim(DEFAULT_SETUP.workerCount));
  const rerender = useRerender(30);
  const { events, log, clear } = useEventLog(40);

  const send = (from: NodeId, to: NodeId, kind: MessageKind, worker: WorkerId, token: number) => {
    sim.current.messages.push({ id: nextParticleId(), from, to, t: 0, kind, worker, token });
  };

  /** A reply reached a worker that is awake. */
  const handleAtWorker = (message: Message) => {
    const s = sim.current;
    const worker = s.workers[message.worker];
    const name = NAME[message.worker];
    if (message.kind === 'granted') {
      worker.phase = 'working';
      worker.token = message.token;
      worker.workLeft = WORK_S;
      if (worker.pauseArmed) {
        worker.pauseArmed = false;
        worker.pauseLeft = setup.pauseS;
        log(`${name} got token ${message.token} and freezes for ${setup.pauseS} s (a GC pause)`, 'warn');
      }
    } else if (message.kind === 'busy') {
      worker.phase = 'idle';
      worker.wait = RETRY_S;
    } else if (message.kind === 'write-ok') {
      send(message.worker, 'lock', 'release', message.worker, message.token);
      worker.phase = 'idle';
      worker.token = null;
      worker.wait = COOLDOWN_S;
    } else if (message.kind === 'write-rejected') {
      log(`${name} learns its lease is gone and abandons the work`, 'info');
      worker.phase = 'idle';
      worker.token = null;
      worker.wait = COOLDOWN_S;
    }
  };

  const handleAtLock = (message: Message) => {
    const s = sim.current;
    const { lock } = s;
    const name = NAME[message.worker];
    if (message.kind === 'acquire') {
      if (lock.holder === null) {
        const token = s.nextToken;
        s.nextToken += 1;
        lock.holder = message.worker;
        lock.token = token;
        lock.expiresAt = setup.ttlOn ? s.time + setup.ttlS : null;
        log(`Lock granted to ${name}, token ${token}${setup.ttlOn ? `, TTL ${setup.ttlS} s` : ', no expiry'}`, 'ok');
        send('lock', message.worker, 'granted', message.worker, token);
      } else {
        send('lock', message.worker, 'busy', message.worker, 0);
      }
      return;
    }
    // A release. The safe version deletes the key only if it still holds this token
    // (the Lua compare-and-delete); the naive one is a plain DEL.
    if (lock.holder === null) return;
    const own = lock.holder === message.worker && lock.token === message.token;
    if (own) {
      lock.holder = null;
    } else if (setup.checkRelease) {
      log(`${name} tried to release token ${message.token}; the lock is now token ${lock.token}, so nothing is deleted`, 'info');
    } else {
      log(`${name} released with a plain DEL and deleted the lock of ${NAME[lock.holder]} (token ${lock.token})`, 'danger');
      lock.holder = null;
    }
  };

  const handleAtStore = (message: Message) => {
    const { store } = sim.current;
    const name = NAME[message.worker];
    if (setup.fencing && message.token < store.highest) {
      store.rejected += 1;
      log(`Storage rejected the write of ${name}: token ${message.token} is older than ${store.highest}`, 'ok');
      send('store', message.worker, 'write-rejected', message.worker, message.token);
      return;
    }
    if (message.token < store.highest) {
      store.overwrites += 1;
      log(
        `Storage accepted the write of ${name} with token ${message.token} over newer data from token ${store.highest} - a lost update`,
        'danger',
      );
    }
    store.accepted += 1;
    store.highest = Math.max(store.highest, message.token);
    store.lastWriter = message.worker;
    store.lastToken = message.token;
    send('store', message.worker, 'write-ok', message.worker, message.token);
  };

  useTicker(running, (realDt) => {
    const dt = realDt * SIM_SPEED;
    const s = sim.current;
    s.time += dt;

    // The lock service drops the key when the lease runs out, whatever the holder is doing.
    if (s.lock.holder !== null && s.lock.expiresAt !== null && s.time >= s.lock.expiresAt) {
      const holder = s.workers[s.lock.holder];
      const stillWorking = believesItHolds(holder) && holder.token === s.lock.token;
      log(
        `Lease of ${NAME[s.lock.holder]} (token ${s.lock.token}) expired${stillWorking ? ' - it is still mid-work and does not know' : ''}`,
        stillWorking ? 'warn' : 'info',
      );
      s.lock.holder = null;
    }

    // Messages in flight.
    const arrived: Message[] = [];
    const moving: Message[] = [];
    for (const message of s.messages) {
      message.t += dt / MSG_S;
      (message.t >= 1 ? arrived : moving).push(message);
    }
    s.messages = moving;
    for (const message of arrived) {
      if (message.to === 'lock') handleAtLock(message);
      else if (message.to === 'store') handleAtStore(message);
      else {
        const worker = s.workers[message.to];
        if (worker.phase === 'crashed') continue; // nobody is listening
        if (worker.pauseLeft > 0) worker.inbox.push(message);
        else handleAtWorker(message);
      }
    }

    // Workers.
    for (const id of s.ids) {
      const worker = s.workers[id];
      if (worker.phase === 'crashed') continue;
      if (worker.pauseLeft > 0) {
        worker.pauseLeft -= dt;
        if (worker.pauseLeft > 0) continue;
        worker.pauseLeft = 0;
        const stillOwns = s.lock.holder === id && s.lock.token === worker.token;
        if (believesItHolds(worker)) {
          const left = s.lock.expiresAt === null ? null : Math.max(0, s.lock.expiresAt - s.time);
          log(
            stillOwns
              ? `${NAME[id]} wakes up with its lease still valid${left === null ? '' : ` (${left.toFixed(1)} s left)`}`
              : `${NAME[id]} wakes up and carries on with token ${worker.token}, a lease that already expired`,
            stillOwns ? 'ok' : 'danger',
          );
        }
        const inbox = worker.inbox;
        worker.inbox = [];
        inbox.forEach(handleAtWorker);
      }
      if (worker.phase === 'idle') {
        worker.wait -= dt;
        if (worker.wait <= 0) {
          worker.phase = 'acquiring';
          send(id, 'lock', 'acquire', id, 0);
        }
      } else if (worker.phase === 'working') {
        worker.workLeft -= dt;
        if (worker.workLeft <= 0 && worker.token !== null) {
          worker.phase = 'writing';
          send(id, 'store', 'write', id, worker.token);
        }
      }
    }

    const owners = s.ids.filter((id) => believesItHolds(s.workers[id]));
    if (owners.length >= 2 && !s.twoOwnersNow) {
      s.twoOwnerEpisodes += 1;
      const tokens = owners.map((id) => `${NAME[id]} (token ${s.workers[id].token})`).join(' and ');
      log(`${owners.length === 2 ? 'Two' : 'Three'} owners at once: ${tokens} all believe they hold the lock`, 'danger');
    }
    s.twoOwnersNow = owners.length >= 2;

    rerender();
  });

  const pauseWorker = useCallback(
    (id: WorkerId) => {
      const worker = sim.current.workers[id];
      if (worker.phase === 'crashed' || worker.pauseLeft > 0) return;
      if (believesItHolds(worker)) {
        worker.pauseLeft = setup.pauseS;
        log(`${NAME[id]} freezes for ${setup.pauseS} s while holding token ${worker.token} (a GC pause)`, 'warn');
      } else {
        worker.pauseArmed = true;
        log(`${NAME[id]} will freeze for ${setup.pauseS} s as soon as it holds the lock`, 'info');
      }
      rerender();
    },
    [log, rerender, setup.pauseS],
  );

  const toggleCrash = useCallback(
    (id: WorkerId) => {
      const s = sim.current;
      const worker = s.workers[id];
      if (worker.phase === 'crashed') {
        s.workers[id] = newWorker(0.5);
        log(`${NAME[id]} restarts with no memory of any lease`, 'info');
      } else {
        s.workers[id] = { ...newWorker(0), phase: 'crashed' };
        const holdsKey = s.lock.holder === id;
        log(
          holdsKey
            ? `${NAME[id]} crashed while holding the lock${s.lock.expiresAt === null ? ' - with no TTL, the key stays forever' : ''}`
            : `${NAME[id]} crashed`,
          holdsKey ? 'danger' : 'warn',
        );
      }
      rerender();
    },
    [log, rerender],
  );

  const reset = useCallback(() => {
    sim.current = createSim(DEFAULT_SETUP.workerCount);
    setSetup(DEFAULT_SETUP);
    clear();
  }, [clear, setSetup]);

  const changeWorkerCount = (next: WorkerCount) => {
    if (next === workerCount) return;
    change('workerCount')(next);
    sim.current = createSim(next);
    clear();
    log(`New run with ${next} workers, each wired to the lock service and the storage the same way`, 'info');
  };

  // ---- Derived view (recomputed each render; the ticker re-renders at 30fps) ----
  const s = sim.current;
  const { lock, store } = s;
  const layout = LAYOUTS[workerCount];
  const count = s.ids.length;
  const owners = s.ids.filter((id) => believesItHolds(s.workers[id]));
  const leaseLeft = lock.holder !== null && lock.expiresAt !== null ? Math.max(0, lock.expiresAt - s.time) : null;
  const holderWorker = lock.holder ? s.workers[lock.holder] : null;
  // With no TTL, a key whose owner crashed (or restarted and forgot it) is never deleted.
  const stuck =
    lock.holder !== null &&
    lock.expiresAt === null &&
    holderWorker !== null &&
    (holderWorker.phase === 'crashed' || holderWorker.token !== lock.token);

  const particles: ParticleView[] = s.messages.map((message) => ({
    id: message.id,
    from: message.from,
    to: message.to,
    t: Math.min(message.t, 1),
    outcome: OUTCOME[message.kind],
  }));

  const edges: DiagramEdge[] = s.ids.flatMap((id): DiagramEdge[] => {
    const worker = s.workers[id];
    const inactive = worker.phase === 'crashed' || worker.pauseLeft > 0;
    return [
      { from: id, to: 'lock', tone: 'brand', dashed: inactive, label: 'lease' },
      {
        from: id,
        to: 'store',
        tone: owners.length >= 2 && owners.includes(id) ? 'danger' : 'info',
        dashed: inactive,
        label: 'write + token',
      },
    ];
  });

  const workerNode = (id: WorkerId) => {
    const worker = s.workers[id];
    const ownsLease = lock.holder === id && lock.token === worker.token;
    const believes = believesItHolds(worker);
    let subtitle: string;
    let status: NodeStatus = 'healthy';
    let statusLabel: string | undefined;
    if (worker.phase === 'crashed') {
      subtitle = 'crashed';
      status = 'down';
    } else if (worker.pauseLeft > 0) {
      subtitle = `frozen (GC pause), ${Math.ceil(worker.pauseLeft)} s left`;
      status = 'degraded';
      statusLabel = 'Paused';
    } else if (worker.phase === 'working') {
      subtitle = `working, ${Math.ceil(Math.max(worker.workLeft, 0))} s to the write`;
    } else if (worker.phase === 'writing') {
      subtitle = 'writing to storage';
    } else if (worker.phase === 'acquiring') {
      subtitle = 'asking for the lock';
    } else {
      subtitle = worker.pauseArmed ? 'waiting, pause armed' : 'waiting to retry';
    }
    return (
      <ArchNode
        key={id}
        kind="worker"
        title={NAME[id]}
        subtitle={subtitle}
        placed={layout[id]}
        status={status}
        statusLabel={statusLabel}
        alert={believes && owners.length >= 2}
      >
        <NodeStatRow label="Token" value={worker.token ?? '-'} tone="text-brand" />
        <NodeStatRow
          label="Believes it holds"
          value={believes ? 'yes' : 'no'}
          tone={believes ? (ownsLease ? 'text-ok' : 'text-danger') : 'text-muted'}
        />
        <NodeStatRow
          label="Lease really valid"
          value={believes ? (ownsLease ? 'yes' : 'no') : '-'}
          tone={believes && !ownsLease ? 'text-danger' : 'text-muted'}
        />
      </ArchNode>
    );
  };

  const insight = (() => {
    if (owners.length >= 2) {
      // The owners whose token is no longer the one the lock service holds.
      const stale = owners.filter((id) => !(lock.holder === id && lock.token === s.workers[id].token));
      const one = stale.length <= 1;
      const who = stale.length
        ? stale.map((id) => `${NAME[id]} (token ${s.workers[id].token})`).join(' and ')
        : 'One worker';
      return (
        <>
          {owners.length === 2 ? 'Two' : 'Three'} owners right now. {who} still{' '}
          {one ? 'believes it holds' : 'believe they hold'} the lock: {one ? 'it was' : 'each was'} frozen and never saw
          the lease expire, and the lock service has since handed a newer token to another worker. No lock code can
          prevent this - a paused process cannot notice anything until it runs again. What decides the damage is the
          storage.{' '}
          {fencing
            ? 'Fencing tokens are on, so a write with an older token will be refused.'
            : 'Fencing tokens are off, so a write with an older token will land on top of newer data. Turn fencing on and pause again.'}
        </>
      );
    }
    if (stuck) {
      return (
        <>
          No TTL, and the holder of the key is gone: the lock service will keep the key forever, and every other worker
          is refused until a human deletes it. That is why every lease has an expiry - and every expiry can run out while
          a slow holder is still working.
        </>
      );
    }
    if (store.overwrites > 0 && !fencing) {
      return (
        <>
          Storage accepted {store.overwrites} write{store.overwrites === 1 ? '' : 's'} carrying an older token after it
          had already seen a newer one - a lost update, caused by a lock that looked correct. Turn on fencing tokens and
          pause a worker again: the same stale write is refused.
        </>
      );
    }
    if (store.rejected > 0) {
      return (
        <>
          Storage refused {store.rejected} stale write{store.rejected === 1 ? '' : 's'}. Two owners still happened -
          fencing does not stop that - but the one with the older token could not change the data. The cost is that the
          storage has to take part: it remembers the highest token it has seen and checks every write against it.
        </>
      );
    }
    if (!ttlOn) {
      return (
        <>
          With no TTL a lease can never expire, so a paused holder is safe - and so is a dead one, forever. Pause a
          worker: {count === 2 ? 'the other waits' : 'the others wait'} the whole pause. Crash one while it holds the
          lock: nothing ever frees it.
        </>
      );
    }
    return (
      <>
        The {count === 2 ? 'two' : 'three'} workers take turns: each takes the lock, works for {WORK_S} s, writes, and releases. Now press Pause
        Worker 1 with a pause ({pauseS} s) longer than the TTL ({ttlS} s) and watch the lease expire under it.
        {pauseS <= ttlS
          ? ` At these settings the pause is shorter than the TTL - but the lease also has to cover the ${WORK_S} s of work, so it can still run out just before the write.`
          : ''}
      </>
    );
  })();

  return (
    <LabShell
      title="Distributed Lock Lab"
      description="Two or three workers share one resource through a lock service with a TTL. Freeze the holder past its lease, see two owners at once, then turn on fencing tokens."
      running={running}
      onRunningChange={setRunning}
      onReset={reset}
      events={events}
      legend={
        <ParticleLegend
          outcomes={[
            'success',
            { outcome: 'warning', label: 'Lock busy, try again' },
            { outcome: 'failure', label: 'Stale write refused' },
          ]}
        />
      }
      actions={
        <Button variant="primary" onClick={() => pauseWorker('w1')} disabled={s.workers.w1.phase === 'crashed' || s.workers.w1.pauseLeft > 0}>
          <Pause className="h-4 w-4" />
          Pause Worker 1
        </Button>
      }
      insight={<Insight>{insight}</Insight>}
      metrics={
        <MetricsPanel
          items={[
            {
              key: 'clock',
              label: 'Clock',
              value: `${Math.floor(s.time)} s`,
              hint: `Simulated seconds, running ${SIM_SPEED}x faster than real time.`,
              simulated: true,
            },
            {
              key: 'believers',
              label: 'Believe they hold it',
              value: owners.length,
              tone: owners.length >= 2 ? 'danger' : 'ok',
              hint: 'Workers that got a token and think they are still inside the critical section.',
            },
            {
              key: 'episodes',
              label: 'Two-owner moments',
              value: s.twoOwnerEpisodes,
              tone: s.twoOwnerEpisodes > 0 ? 'warn' : 'neutral',
              hint: 'Times two or more workers believed they held the lock at once. Fencing does not lower this - it makes it harmless.',
            },
            { key: 'accepted', label: 'Writes accepted', value: store.accepted },
            {
              key: 'rejected',
              label: 'Stale writes refused',
              value: store.rejected,
              tone: store.rejected > 0 ? 'ok' : 'neutral',
              hint: 'Writes the storage refused because their token was older than one it had already seen.',
            },
            {
              key: 'overwrites',
              label: 'Lost updates',
              value: store.overwrites,
              tone: store.overwrites > 0 ? 'danger' : 'ok',
              hint: 'Writes with an older token accepted after a newer one: stale data landed on top of fresh data.',
            },
          ]}
        />
      }
      controls={
        <>
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted">Workers (starts a new run)</p>
            <SegmentedControl
              size="sm"
              className="w-full"
              value={String(workerCount) as '2' | '3'}
              options={[
                { value: '2', label: '2 workers' },
                { value: '3', label: '3 workers' },
              ]}
              onChange={(value) => changeWorkerCount(value === '3' ? 3 : 2)}
            />
          </div>
          <Toggle
            label="Fencing tokens"
            checked={fencing}
            onChange={(value) => {
              change('fencing')(value);
              log(value ? 'Fencing on: storage refuses a token older than the highest it has seen' : 'Fencing off: storage accepts any write', 'info');
            }}
            description="Storage remembers the highest token and refuses older ones"
          />
          <Toggle
            label="Lease expires (TTL)"
            checked={ttlOn}
            onChange={change('ttlOn')}
            description="Applies to the next lease the lock service grants"
          />
          <Slider
            label="Lease TTL"
            value={ttlS}
            min={2}
            max={30}
            onChange={change('ttlS')}
            disabled={!ttlOn}
            format={(value) => `${value} s`}
            hint={`Simulated seconds. The work itself takes ${WORK_S} s.`}
          />
          <Slider
            label="Pause length"
            value={pauseS}
            min={1}
            max={30}
            onChange={change('pauseS')}
            tone={ttlOn && pauseS > ttlS ? 'danger' : 'brand'}
            format={(value) => `${value} s`}
            hint="How long a paused worker freezes. Real GC pauses and VM stalls have no upper bound."
          />
          <Toggle
            label="Release checks the token"
            checked={checkRelease}
            onChange={change('checkRelease')}
            description="Off: release is a plain DEL, which can delete the lock of someone else"
          />
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted">Break a worker</p>
            {s.ids.map((id) => {
              const worker = s.workers[id];
              const crashed = worker.phase === 'crashed';
              return (
                <div key={id} className="grid grid-cols-2 gap-2">
                  <Button size="sm" onClick={() => pauseWorker(id)} disabled={crashed || worker.pauseLeft > 0 || worker.pauseArmed}>
                    <Pause className="h-3.5 w-3.5" />
                    Pause {NUMBER[id]}
                  </Button>
                  <Button size="sm" variant={crashed ? 'success' : 'outline'} onClick={() => toggleCrash(id)}>
                    {crashed ? <RotateCw className="h-3.5 w-3.5" /> : <Power className="h-3.5 w-3.5" />}
                    {crashed ? `Restart ${NUMBER[id]}` : `Crash ${NUMBER[id]}`}
                  </Button>
                </div>
              );
            })}
            <p className="text-[11px] text-faint">
              A pause pressed while the worker does not hold the lock waits until it next gets one.
            </p>
          </div>
        </>
      }
    >
      <DiagramCanvas layout={layout} edges={edges} particles={particles} height={CANVAS_H} className="bg-canvas">
        <ArchNode
          kind="cache"
          title="Lock service"
          subtitle={ttlOn ? `lease with TTL ${ttlS} s, token` : 'lease with no expiry, token'}
          placed={layout.lock}
          alert={stuck}
        >
          <NodeStatRow label="Key held for" value={lock.holder ? NAME[lock.holder] : 'nobody'} tone={lock.holder ? 'text-ink' : 'text-muted'} />
          <NodeStatRow label="Token" value={lock.token || '-'} tone="text-brand" />
          <NodeStatRow
            label="Lease left"
            value={lock.holder === null ? '-' : leaseLeft === null ? 'never expires' : `${leaseLeft.toFixed(1)} s`}
            tone={leaseLeft !== null && leaseLeft < 2 ? 'text-warn' : 'text-ink'}
          />
        </ArchNode>
        {s.ids.map(workerNode)}
        <ArchNode
          kind="storage"
          title="Storage"
          subtitle={fencing ? 'refuses a token older than seen' : 'accepts every write'}
          placed={layout.store}
          alert={store.overwrites > 0}
        >
          <NodeStatRow label="Highest token seen" value={store.highest || '-'} tone="text-brand" />
          <NodeStatRow
            label="Last write"
            value={store.lastWriter ? `${NAME[store.lastWriter]}, token ${store.lastToken}` : '-'}
            tone={store.lastToken < store.highest ? 'text-danger' : 'text-ink'}
          />
          <NodeStatRow label="Refused" value={store.rejected} tone={store.rejected > 0 ? 'text-ok' : 'text-muted'} />
        </ArchNode>
      </DiagramCanvas>
    </LabShell>
  );
}

export default DistributedLockLab;
