import { useRef } from 'react';
import { CreditCard, MousePointerClick } from 'lucide-react';
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
import { Button, SegmentedControl, Slider, Toggle } from '@/components/ui';
import { advanceParticles, nextParticleId, useEventLog, useTicker, type Particle } from '@/simulations/engine';
import { useLabSetup } from '@/hooks/useLabSetup';
import { useRerender } from '@/hooks/useRerender';
import { cn } from '@/utils/cn';
import type { RequestOutcome } from '@/types';
import { useLabRunning } from '@/hooks/useLabRunning';

/**
 * Idempotency: a client pays over a network that loses responses. The first
 * attempt does charge; only the answer goes missing, so the client retries.
 * Without a key the retry is a second charge. With one key per payment the API
 * finds the key in the keys table and replays the stored result instead.
 *
 * Simplified model, not a measurement: requests always arrive, each response is
 * lost with the chosen probability halfway along the network wire, the client
 * waits a fixed timeout before it retries, and keys never expire in this Lab.
 */

type KeyMode = 'none' | 'per-attempt' | 'per-intent';

interface Setup {
  keyMode: KeyMode;
  /** Chance that a response is lost on its way back to the client. */
  responseLoss: number;
  maxAttempts: number;
  autoPay: boolean;
}

/** Opens on no key at all, so the first thing the learner sees is a double charge. */
const DEFAULT_SETUP: Setup = { keyMode: 'none', responseLoss: 0.5, maxAttempts: 3, autoPay: true };

const KEY_MODES: { value: KeyMode; label: string }[] = [
  { value: 'none', label: 'No key' },
  { value: 'per-attempt', label: 'New per try' },
  { value: 'per-intent', label: 'Same on retry' },
];

/** Simulated seconds. */
const TIMEOUT_S = 1;
const CONFLICT_WAIT_S = 0.8;
const DOUBLE_TAP_GAP_S = 0.12;
const PAY_INTERVAL_S = 3;
const DROP_VISIBLE_S = 0.6;
const LEG_SPEED = 1.6;
const PRICE = 20;

const LAYOUT: Layout = {
  client: { x: 30, y: 165, w: 210, h: 124 },
  // Three stat rows need about 142px.
  api: { x: 345, y: 156, w: 230, h: 142 },
  keys: { x: 690, y: 55, w: 240, h: 124 },
  charges: { x: 690, y: 270, w: 240, h: 124 },
};

/** The two tables live in one database, so one transaction covers the key and the charge. */
const DATABASE_BOX = { x: 672, y: 16, w: 276, h: 396 };

type Stage = 'request' | 'lookup' | 'write' | 'response';
type Answer = 'charged' | 'replay' | 'conflict';

type Hop = {
  stage: Stage;
  intent: number;
  attempt: number;
  key: string | null;
  answer?: Answer;
  chargeId?: string;
  lost?: boolean;
  droppedAt?: number;
};

interface Intent {
  id: number;
  attempts: number;
  charges: number;
  status: 'pending' | 'paid' | 'gave-up';
}

interface KeyRow {
  key: string;
  intent: number;
  status: 'in-progress' | 'completed';
  chargeId?: string;
}

interface ChargeRow {
  id: string;
  intent: number;
  attempt: number;
  key: string | null;
}

interface Scheduled {
  intent: number;
  at: number;
  reason: 'timeout' | 'conflict' | 'double-tap';
}

interface Stats {
  payments: number;
  attempts: number;
  retries: number;
  lost: number;
  replays: number;
  conflicts: number;
  doubleCharged: number;
  extraCharges: number;
  gaveUp: number;
}

interface SimState {
  clock: number;
  nextPayAt: number;
  nextIntent: number;
  nextCharge: number;
  particles: Particle[];
  intents: Map<number, Intent>;
  keys: Map<string, KeyRow>;
  charges: ChargeRow[];
  scheduled: Scheduled[];
  stats: Stats;
  /** The last payment charged more than once, for the insight. */
  lastDouble: { intent: number; charges: number } | null;
}

const createState = (): SimState => ({
  clock: 0,
  nextPayAt: 0.4,
  nextIntent: 0,
  nextCharge: 100,
  particles: [],
  intents: new Map(),
  keys: new Map(),
  charges: [],
  scheduled: [],
  stats: { payments: 0, attempts: 0, retries: 0, lost: 0, replays: 0, conflicts: 0, doubleCharged: 0, extraCharges: 0, gaveUp: 0 },
  lastDouble: null,
});

const hopOf = (particle: Particle) => particle.meta as Hop;

const keyFor = (mode: KeyMode, intent: number, attempt: number) =>
  mode === 'none' ? null : mode === 'per-intent' ? `pay-${intent}` : `pay-${intent}.${attempt}`;

export function IdempotencyLab() {
  // Every control lives in one object, so Reset cannot miss one.
  const { setup, setSetup, change } = useLabSetup(DEFAULT_SETUP);
  const { keyMode, responseLoss, maxAttempts, autoPay } = setup;
  const [running, setRunning] = useLabRunning();
  const sim = useRef<SimState>(createState());
  const rerender = useRerender(30);
  const { events, log, clear } = useEventLog();

  const spawn = (route: string[], outcome: RequestOutcome, hop: Hop) => {
    sim.current.particles.push({ id: nextParticleId(), route, leg: 0, t: 0, speed: LEG_SPEED, outcome, meta: hop });
  };

  /** A response leaves the server; the network decides now whether it will arrive. */
  const respond = (from: string, outcome: RequestOutcome, hop: Hop) => {
    spawn([from, 'api', 'client'], outcome, { ...hop, stage: 'response', lost: Math.random() < responseLoss });
  };

  const sendAttempt = (intentId: number) => {
    const state = sim.current;
    const intent = state.intents.get(intentId);
    if (!intent) return;
    intent.attempts += 1;
    state.stats.attempts += 1;
    const key = keyFor(keyMode, intent.id, intent.attempts);
    spawn(['client', 'api'], intent.attempts > 1 ? 'warning' : 'success', {
      stage: 'request',
      intent: intent.id,
      attempt: intent.attempts,
      key,
    });
  };

  const startPayment = (doubleTap: boolean) => {
    const state = sim.current;
    state.nextIntent += 1;
    const id = state.nextIntent;
    state.intents.set(id, { id, attempts: 0, charges: 0, status: 'pending' });
    state.stats.payments += 1;
    sendAttempt(id);
    if (doubleTap) {
      state.scheduled.push({ intent: id, at: state.clock + DOUBLE_TAP_GAP_S, reason: 'double-tap' });
      log(`Payment #${id}: the user taps Pay twice`, 'info');
    }
  };

  const runScheduled = (item: Scheduled) => {
    const state = sim.current;
    const intent = state.intents.get(item.intent);
    if (!intent || intent.status !== 'pending') return;
    if (item.reason === 'double-tap') {
      sendAttempt(intent.id);
      return;
    }
    if (intent.attempts >= maxAttempts) {
      intent.status = 'gave-up';
      state.stats.gaveUp += 1;
      log(
        `Payment #${intent.id}: gave up after ${intent.attempts} attempts - the user sees an error, yet the card was charged ${intent.charges} time${intent.charges === 1 ? '' : 's'}`,
        'warn',
      );
      return;
    }
    state.stats.retries += 1;
    sendAttempt(intent.id);
  };

  /** A particle reached the end of its route: the next part of the system acts on it. */
  const arrive = (particle: Particle) => {
    const state = sim.current;
    const hop = hopOf(particle);
    const intent = state.intents.get(hop.intent);
    if (!intent) return;

    if (hop.stage === 'request') {
      if (hop.key === null) spawn(['api', 'charges'], 'success', { ...hop, stage: 'write' });
      else spawn(['api', 'keys'], particle.outcome ?? 'success', { ...hop, stage: 'lookup' });
      return;
    }

    if (hop.stage === 'lookup' && hop.key !== null) {
      const row = state.keys.get(hop.key);
      if (!row) {
        state.keys.set(hop.key, { key: hop.key, intent: hop.intent, status: 'in-progress' });
        spawn(['keys', 'api', 'charges'], 'success', { ...hop, stage: 'write' });
      } else if (row.status === 'in-progress') {
        state.stats.conflicts += 1;
        log(`Payment #${hop.intent} attempt ${hop.attempt}: key ${hop.key} is still in progress - 409, try again shortly`, 'warn');
        respond('keys', 'warning', { ...hop, answer: 'conflict' });
      } else {
        state.stats.replays += 1;
        log(`Payment #${hop.intent} attempt ${hop.attempt}: key ${hop.key} found - stored result ${row.chargeId} replayed, no charge`, 'ok');
        respond('keys', 'cache-hit', { ...hop, answer: 'replay', chargeId: row.chargeId });
      }
      return;
    }

    if (hop.stage === 'write') {
      state.nextCharge += 1;
      const chargeId = `ch_${state.nextCharge}`;
      state.charges.push({ id: chargeId, intent: hop.intent, attempt: hop.attempt, key: hop.key });
      if (state.charges.length > 60) state.charges.shift();
      intent.charges += 1;
      // The key row is completed in the same transaction as the charge row.
      if (hop.key !== null) state.keys.set(hop.key, { key: hop.key, intent: hop.intent, status: 'completed', chargeId });
      if (intent.charges >= 2) {
        state.stats.extraCharges += 1;
        if (intent.charges === 2) state.stats.doubleCharged += 1;
        state.lastDouble = { intent: intent.id, charges: intent.charges };
        log(`Payment #${intent.id} charged again (${chargeId}): ${intent.charges} charges for one purchase`, 'danger');
      } else {
        log(`Payment #${intent.id} attempt ${hop.attempt}: card charged, ${chargeId}`, 'info');
      }
      respond('charges', 'success', { ...hop, answer: 'charged', chargeId });
      return;
    }

    if (hop.stage === 'response') {
      if (hop.answer === 'conflict') {
        state.scheduled.push({ intent: hop.intent, at: state.clock + CONFLICT_WAIT_S, reason: 'conflict' });
      } else if (intent.status === 'pending') {
        intent.status = 'paid';
      }
    }
  };

  useTicker(running, (dt) => {
    const state = sim.current;
    state.clock += dt;

    if (autoPay && state.clock >= state.nextPayAt) {
      startPayment(false);
      state.nextPayAt = state.clock + PAY_INTERVAL_S;
    }

    const due = state.scheduled.filter((item) => item.at <= state.clock);
    if (due.length) {
      state.scheduled = state.scheduled.filter((item) => item.at > state.clock);
      due.forEach(runScheduled);
    }

    // A lost response disappears halfway along the network wire; the client only
    // learns that nothing came back when its timeout fires.
    for (const particle of state.particles) {
      const hop = hopOf(particle);
      const onLastLeg = particle.leg === particle.route.length - 2;
      if (hop.stage === 'response' && hop.lost && hop.droppedAt === undefined && onLastLeg && particle.t >= 0.5) {
        hop.droppedAt = state.clock;
        particle.outcome = 'failure';
        particle.speed = 0;
        state.stats.lost += 1;
        state.scheduled.push({ intent: hop.intent, at: state.clock + TIMEOUT_S, reason: 'timeout' });
        log(`Payment #${hop.intent} attempt ${hop.attempt}: response lost - the client cannot tell if it was charged`, 'warn');
      }
    }

    const { alive, finished } = advanceParticles(state.particles, dt);
    state.particles = alive
      .filter((particle) => {
        const dropped = hopOf(particle).droppedAt;
        return dropped === undefined || state.clock - dropped < DROP_VISIBLE_S;
      })
      .slice(-80);
    finished.forEach(arrive);
    rerender();
  });

  const reset = () => {
    sim.current = createState();
    setSetup(DEFAULT_SETUP);
    clear();
    rerender();
  };

  const state = sim.current;
  const { stats } = state;
  const keysOn = keyMode !== 'none';
  const chargeRows = state.charges.slice(-6).reverse();
  const keyRows = [...state.keys.values()].slice(-5).reverse();

  const particleViews: ParticleView[] = state.particles.map((particle) => ({
    id: particle.id,
    from: particle.route[particle.leg],
    to: particle.route[particle.leg + 1],
    t: particle.t,
    outcome: particle.outcome ?? 'success',
  }));

  const edges: DiagramEdge[] = [
    { from: 'client', to: 'api', tone: 'brand', label: 'lossy network', labelT: 0.5, width: 2 },
    { from: 'api', to: 'keys', tone: keysOn ? 'ok' : 'muted', dashed: !keysOn },
    { from: 'api', to: 'charges', tone: 'violet' },
  ];

  const underlay = (
    <g>
      <rect
        x={DATABASE_BOX.x}
        y={DATABASE_BOX.y}
        width={DATABASE_BOX.w}
        height={DATABASE_BOX.h}
        rx={14}
        className="fill-elevated stroke-line"
        fillOpacity={0.6}
        strokeDasharray="6 5"
        strokeWidth={1.5}
      />
      <text
        x={DATABASE_BOX.x + 14}
        y={DATABASE_BOX.y + 24}
        className="fill-muted font-mono"
        style={{ fontSize: 11 }}
      >
        Payments DB - one transaction
      </text>
    </g>
  );

  const doubleNote = state.lastDouble
    ? `Payment #${state.lastDouble.intent} was charged ${state.lastDouble.charges} times.`
    : 'No payment has been charged twice yet - wait for a lost response (a red cross on the network wire).';

  return (
    <LabShell
      title="Idempotency Lab"
      description="Pay over a network that loses responses. Retry without a key and watch a double charge; send the same key on every retry and watch the retry answered from the keys table."
      running={running}
      onRunningChange={setRunning}
      onReset={reset}
      legend={
        <ParticleLegend
          outcomes={[
            'success',
            { outcome: 'warning', label: 'Retry, or 409 in progress' },
            { outcome: 'cache-hit', label: 'Stored result replayed' },
            { outcome: 'failure', label: 'Response lost' },
          ]}
        />
      }
      events={events}
      actions={
        <>
          <Button variant="secondary" onClick={() => startPayment(true)}>
            <MousePointerClick className="h-4 w-4" />
            Double-tap Pay
          </Button>
          <Button variant="primary" onClick={() => startPayment(false)}>
            <CreditCard className="h-4 w-4" />
            Pay ${PRICE}
          </Button>
        </>
      }
      insight={
        <Insight>
          {responseLoss === 0 ? (
            <>
              No response is lost, so the client never retries and every payment is charged once - even with no key.
              The bug is still there; it waits for the first bad network day. Raise Response loss.
            </>
          ) : keyMode === 'none' ? (
            <>
              {doubleNote} The first attempt did charge the card; only the response was lost, so the client could not
              tell success from failure and retried. Nothing ties the retry to the first attempt, so the server runs it
              again. Choose Same on retry.
            </>
          ) : keyMode === 'per-attempt' ? (
            <>
              A new key on every attempt is the same as no key: each retry carries a key the keys table has never seen,
              so it inserts a new row and charges again. {doubleNote} The key must name the payment (the intent), not
              the attempt.
            </>
          ) : (
            <>
              Every retry carries the key of its first attempt. The API finds it in the keys table and replays the stored
              result (green diamonds) instead of charging - {stats.replays} repeat{stats.replays === 1 ? '' : 's'}{' '}
              answered that way so far. Press Double-tap Pay: the second tap finds the key still in progress and gets a
              409, then retries and receives the stored result.
            </>
          )}
        </Insight>
      }
      metrics={
        <>
          <MetricsPanel
            items={[
              { key: 'payments', label: 'Payments', value: stats.payments, hint: 'Purchases the user made - one tap of Pay each.' },
              { key: 'charges', label: 'Charges written', value: state.nextCharge - 100, tone: 'violet' },
              {
                key: 'double',
                label: 'Charged twice or more',
                value: stats.doubleCharged,
                tone: stats.doubleCharged > 0 ? 'danger' : 'ok',
                hint: 'Payments with more than one charge row since the last reset.',
              },
              {
                key: 'extra',
                label: 'Extra money taken',
                value: `$${stats.extraCharges * PRICE}`,
                tone: stats.extraCharges > 0 ? 'danger' : 'ok',
                hint: `Every charge beyond the first for one payment, at $${PRICE} each.`,
              },
              {
                key: 'replays',
                label: 'Answered from keys',
                value: stats.replays,
                tone: 'ok',
                hint: 'Repeats that found a completed key and got the stored result back, with no new charge.',
              },
              { key: 'lost', label: 'Responses lost', value: stats.lost, tone: stats.lost > 0 ? 'warn' : 'neutral', simulated: true },
              { key: 'conflicts', label: '409 in progress', value: stats.conflicts, hint: 'Repeats that arrived while the first attempt was still running.' },
              { key: 'gaveup', label: 'Gave up', value: stats.gaveUp, hint: 'Payments where the client ran out of attempts without an answer.' },
            ]}
          />
          <div className="grid gap-4 md:grid-cols-2">
            <div className="card p-4">
              <p className="label mb-3">charges table (newest first)</p>
              {chargeRows.length === 0 ? (
                <p className="text-xs text-faint">No charges yet.</p>
              ) : (
                <ul className="space-y-1.5 font-mono text-[11px]">
                  {chargeRows.map((row) => {
                    const twice = (state.intents.get(row.intent)?.charges ?? 0) > 1;
                    return (
                      <li key={row.id} className={cn('flex items-center gap-2', twice ? 'text-danger' : 'text-muted')}>
                        <span className="w-14 shrink-0 text-ink">{row.id}</span>
                        <span className="w-20 shrink-0">payment #{row.intent}</span>
                        <span className="w-14 shrink-0">try {row.attempt}</span>
                        <span className="min-w-0 truncate">{row.key ?? 'no key'}</span>
                        {twice ? <span className="ml-auto shrink-0">DUPLICATE</span> : null}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
            <div className="card p-4">
              <p className="label mb-3">idempotency_keys table</p>
              {!keysOn && keyRows.length === 0 ? (
                <p className="text-xs text-faint">Not used: requests carry no key.</p>
              ) : keyRows.length === 0 ? (
                <p className="text-xs text-faint">No keys yet.</p>
              ) : (
                <ul className="space-y-1.5 font-mono text-[11px] text-muted">
                  {keyRows.map((row) => (
                    <li key={row.key} className="flex items-center gap-2">
                      <span className="w-20 shrink-0 text-ink">{row.key}</span>
                      <span className={row.status === 'completed' ? 'text-ok' : 'text-warn'}>
                        {row.status === 'completed' ? `completed -> ${row.chargeId}` : 'in progress'}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
          <p className="text-xs text-faint">
            {SIMULATED_HINT} Requests always arrive, each response is lost with the chosen chance,
            the client waits a fixed {TIMEOUT_S} s timeout (and {CONFLICT_WAIT_S} s after a 409) before it retries, and
            keys never expire here. Real APIs keep keys for a window, such as 24 hours, and a retry after that window is a
            new payment.
          </p>
        </>
      }
      controls={
        <>
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted">Idempotency key</p>
            <SegmentedControl size="sm" className="w-full" value={keyMode} options={KEY_MODES} onChange={change('keyMode')} />
            <p className="text-[11px] text-faint">
              {keyMode === 'none'
                ? 'Requests carry no key. The server cannot tell a retry from a new purchase.'
                : keyMode === 'per-attempt'
                  ? 'The client makes a new key for every attempt - a common bug.'
                  : 'The client makes one key when the user taps Pay and sends it on every retry.'}
            </p>
          </div>
          <Slider
            label="Response loss"
            value={responseLoss}
            min={0}
            max={0.9}
            step={0.05}
            onChange={change('responseLoss')}
            format={(value) => `${Math.round(value * 100)}%`}
            tone="danger"
            hint="Chance that the answer is lost on its way back. The work on the server already happened."
          />
          <Slider
            label="Max attempts"
            value={maxAttempts}
            min={1}
            max={5}
            onChange={change('maxAttempts')}
            format={(value) => `${value} attempt${value === 1 ? '' : 's'}`}
            hint="With 1 the client never retries: no double charge, but the user sees an error for a payment that went through."
          />
          <Toggle
            label="Automatic payments"
            checked={autoPay}
            onChange={change('autoPay')}
            description={`A new $${PRICE} purchase every ${PAY_INTERVAL_S} s. Turn off to follow one Pay at a time.`}
          />
        </>
      }
    >
      <DiagramCanvas
        layout={LAYOUT}
        edges={edges}
        particles={particleViews}
        underlay={underlay}
        height={430}
        className="bg-canvas"
      >
        <ArchNode kind="client" title="Client" subtitle={`retries after ${TIMEOUT_S} s timeout`} placed={LAYOUT.client} compact>
          <NodeStatRow label="Payments" value={stats.payments} />
          <NodeStatRow label="Retries" value={stats.retries} tone={stats.retries > 0 ? 'text-warn' : 'text-ink'} />
        </ArchNode>
        <ArchNode
          kind="server"
          title="Payments API"
          subtitle={keysOn ? 'checks Idempotency-Key' : 'no key check'}
          placed={LAYOUT.api}
          compact
        >
          <NodeStatRow label="Requests" value={stats.attempts} />
          <NodeStatRow label="Replayed" value={stats.replays} tone={stats.replays > 0 ? 'text-ok' : 'text-ink'} />
          <NodeStatRow label="409 in progress" value={stats.conflicts} />
        </ArchNode>
        <ArchNode
          kind="sql"
          title="Keys table"
          subtitle="idempotency_keys"
          placed={LAYOUT.keys}
          status={keysOn ? 'healthy' : 'down'}
          statusLabel={keysOn ? undefined : 'Not used'}
          compact
        >
          <NodeStatRow label="Rows" value={state.keys.size} />
          <NodeStatRow label="Hits" value={stats.replays} tone={stats.replays > 0 ? 'text-ok' : 'text-ink'} />
        </ArchNode>
        <ArchNode
          kind="sql"
          title="Charges table"
          subtitle="one row = one charge"
          placed={LAYOUT.charges}
          alert={stats.doubleCharged > 0}
          compact
        >
          <NodeStatRow label="Rows" value={state.nextCharge - 100} />
          <NodeStatRow
            label="Charged twice"
            value={stats.doubleCharged}
            tone={stats.doubleCharged > 0 ? 'text-danger' : 'text-ok'}
          />
        </ArchNode>
      </DiagramCanvas>
    </LabShell>
  );
}

export default IdempotencyLab;
