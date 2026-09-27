import { useCallback, useRef, type ReactNode } from 'react';
import { RefreshCcw, Rewind } from 'lucide-react';
import { ArchNode, DiagramCanvas, NodeStatRow, ParticleLegend, type DiagramEdge, type Layout, type ParticleView } from '@/components/architecture';
import { Insight, LabShell, MetricsPanel } from '@/components/learning';
import { Button, SegmentedControl, Slider, Stepper, Toggle } from '@/components/ui';
import { advanceParticles, nextParticleId, useEventLog, useTicker, visualShare, type Particle } from '@/simulations/engine';
import { useLabSetup } from '@/hooks/useLabSetup';
import { useRerender } from '@/hooks/useRerender';
import { cn } from '@/utils/cn';
import { clamp, sampleArrivals } from '@/utils/math';
import { formatNumber } from '@/utils/format';
import type { LabFocus, LabProps, RequestOutcome } from '@/types';
import {
  ACCOUNTS,
  PREFILL,
  QUERY_RATE,
  READ_WINDOW,
  REBALANCE_SECONDS,
  RETAINED_RECORDS,
  SNAPSHOT_EVERY,
  applyRetention,
  createLogState,
  endOffset,
  lagOf,
  ownedBy,
  partitionOf,
  previewSeek,
  readLagSeconds,
  seekBilling,
  skipDeleted,
  startRebuild,
  stepMember,
  stepProjector,
  write,
  wrongAccounts,
  type LogState,
  type OffsetReset,
  type SeekResult,
} from './eventLogModel';
import { useLabRunning } from '@/hooks/useLabRunning';

interface Setup {
  /** Commands per second sent to the write model. */
  writeRate: number;
  partitions: number;
  /** Members of the billing consumer group; 0 leaves the group out. */
  members: number;
  /** Records per second one billing member can process. */
  memberRate: number;
  /** The offset Rewind billing commits on every partition. */
  replayFrom: number;
  /** Where billing goes when its offset was deleted by retention (auto.offset.reset). */
  offsetReset: OffsetReset;
  /** Records per second the projector can apply. */
  projectorRate: number;
  /** How old a record must be before the projector sees it: transport plus batching. */
  delayMs: number;
  /** The projector has a bug: it skips withdrawals. */
  bug: boolean;
  snapshots: boolean;
  retention: boolean;
  /** Open with the read model thrown away, so the first thing on screen is a replay. */
  rebuildOnStart: boolean;
}

/** What the Lab opens on at /labs/event-log, with no Lab focus. */
const DEFAULT_SETUP: Setup = {
  writeRate: 12,
  partitions: 3,
  members: 2,
  memberRate: 6,
  replayFrom: 0,
  offsetReset: 'earliest',
  projectorRate: 30,
  delayMs: 300,
  bug: false,
  snapshots: false,
  retention: false,
  rebuildOnStart: false,
};

/**
 * The Lab focus of each Concept that hosts this Lab.
 * - Kafka opens on partitions, offsets and consumer groups: 3 partitions and 2
 *   billing members, so Billing 1 owns two partitions and falls behind. A third
 *   member fixes it; a fourth sits idle.
 * - CQRS opens on the write model, the projector and the read model, with a
 *   1.5 s projection delay, so the read lag and stale reads show at once.
 * - Event sourcing opens with the read model thrown away and the projector
 *   replaying the history already in the log (PREFILL commands, less the
 *   refused ones).
 */
const FOCUS_SETUPS: Record<LabFocus<'event-log'>, Setup> = {
  kafka: { ...DEFAULT_SETUP, delayMs: 0 },
  cqrs: { ...DEFAULT_SETUP, writeRate: 10, partitions: 1, members: 0, projectorRate: 30, delayMs: 1500 },
  'event-sourcing': {
    ...DEFAULT_SETUP,
    writeRate: 4,
    partitions: 1,
    members: 0,
    projectorRate: 40,
    delayMs: 0,
    rebuildOnStart: true,
  },
};

interface State {
  log: LogState;
  particles: Particle[];
  billingCarry: number[];
  projectorCarry: number;
  /** Clock time of the last "fell behind retention" message, per consumer, so it is not repeated every frame. */
  warnedAt: { billing: number; projector: number };
}

const createState = (setup: Setup): State => ({
  log: createLogState(setup.partitions, setup.rebuildOnStart),
  particles: [],
  billingCarry: [],
  projectorCarry: 0,
  warnedAt: { billing: -Infinity, projector: -Infinity },
});

const MAX_PARTICLES = 90;
/** Particles emitted per second on each flow: a sample of the traffic, never the traffic itself. */
const PARTICLES_PER_FLOW = 8;

const WIDTH = 900;
const HEIGHT = 630;
const PARTITION_H = 132;
const MEMBER_H = 96;

function buildLayout(partitions: number, members: number, snapshots: boolean): Layout {
  // The left column is 210 wide: "write model: appends events" needs about 207.
  const layout: Layout = {
    producer: { x: 24, y: 20, w: 210, h: 116 },
    projector: { x: 24, y: 300, w: 210, h: 116 },
    readModel: { x: 300, y: 470, w: 290, h: 140 },
    query: { x: 680, y: 490, w: 190, h: 96 },
  };
  if (snapshots) layout.snapshot = { x: 24, y: 470, w: 210, h: 96 };
  // Partitions and members are stacked in their own columns, centred on the same band.
  const partitionGap = 20;
  const partitionTop = 20 + (3 - partitions) * ((PARTITION_H + partitionGap) / 2);
  for (let index = 0; index < partitions; index += 1) {
    layout[`p${index}`] = { x: 300, y: partitionTop + index * (PARTITION_H + partitionGap), w: 290, h: PARTITION_H };
  }
  const memberGap = 12;
  const memberTop = 20 + (4 - members) * ((MEMBER_H + memberGap) / 2);
  for (let index = 0; index < members; index += 1) {
    layout[`m${index}`] = { x: 680, y: memberTop + index * (MEMBER_H + memberGap), w: 190, h: MEMBER_H };
  }
  return layout;
}

export function EventLogLab({ focus }: LabProps<'event-log'>) {
  // The page keys this Lab by Concept, so the focus never changes under a mounted Lab.
  const start = focus ? FOCUS_SETUPS[focus] : DEFAULT_SETUP;
  // Every control lives in one object, so Reset cannot miss one.
  const { setup, setSetup, change } = useLabSetup(start);
  const { writeRate, partitions, members, memberRate, replayFrom, offsetReset, projectorRate, delayMs, bug, snapshots, retention } =
    setup;

  const [running, setRunning] = useLabRunning();
  const state = useRef<State>(createState(start));
  const rerender = useRerender(30);
  const { events, log, clear } = useEventLog();

  const emit = (route: string[], outcome: RequestOutcome, share: number, speed = 1.5) => {
    const current = state.current;
    if (current.particles.length >= MAX_PARTICLES || Math.random() > share) return;
    current.particles.push({ id: nextParticleId(), route, leg: 0, t: 0, speed, outcome });
  };

  useTicker(running, (dt) => {
    const current = state.current;
    const model = current.log;
    model.clock += dt;

    // Producer: the write model accepts or refuses each command, then appends.
    const writeShare = visualShare(writeRate, PARTICLES_PER_FLOW);
    for (const partition of write(model, sampleArrivals(writeRate, dt))) {
      emit(['producer', `p${partition}`], 'success', writeShare);
    }
    if (retention) applyRetention(model);

    // Billing group: each member reads the partitions it owns, at its own pace.
    if (members > 0 && model.clock >= model.billing.pausedUntil) {
      const skipped = skipDeleted(model, offsetReset);
      if (skipped > 0) {
        if (model.clock - current.warnedAt.billing > 4) {
          current.warnedAt.billing = model.clock;
          log(
            `Billing fell behind retention: ${formatNumber(skipped)} records were ` +
              (offsetReset === 'earliest'
                ? 'deleted before it read them - auto.offset.reset=earliest restarts it at the oldest kept record'
                : 'deleted or jumped over - auto.offset.reset=latest sends it to the log end'),
            'danger',
          );
        }
      }
      const readShare = visualShare(memberRate, PARTICLES_PER_FLOW / 2);
      for (let member = 0; member < members; member += 1) {
        const owned = ownedBy(member, members, partitions);
        const budget = memberRate * dt + (current.billingCarry[member] ?? 0);
        current.billingCarry[member] = owned.length
          ? stepMember(model, member, owned, budget, (partition) => emit([`p${partition}`, `m${member}`], 'success', readShare))
          : 0;
      }
    }

    // Projector: its own consumer group, folding records into the read model.
    const projector = model.projector;
    const lostBefore = projector.skipped;
    const applyShare = visualShare(projectorRate, PARTICLES_PER_FLOW);
    const result = stepProjector(
      model,
      projectorRate * dt + current.projectorCarry,
      model.clock - delayMs / 1000,
      { skipWithdrawals: bug, snapshots },
      {
        apply: (partition) => emit([`p${partition}`, 'projector', 'readModel'], 'success', applyShare),
        snapshot: () => {
          emit(['projector', 'snapshot'], 'cache-hit', 1, 1.2);
          log(`Snapshot saved after ${formatNumber(sumOffsets(projector.offsets))} events`, 'info');
        },
      },
    );
    current.projectorCarry = result.carry;
    if (projector.skipped > lostBefore && model.clock - current.warnedAt.projector > 4) {
      current.warnedAt.projector = model.clock;
      log(
        `Projector fell behind retention: ${formatNumber(projector.skipped - lostBefore)} records were deleted before it applied them - the read model is now wrong`,
        'danger',
      );
    }
    if (projector.rebuild && result.caughtUp) {
      const rebuild = projector.rebuild;
      const seconds = model.clock - rebuild.startedAt;
      const wrong = wrongAccounts(model);
      projector.lastRebuild = { events: rebuild.events, seconds, fromSnapshot: rebuild.fromSnapshot, wrong };
      projector.rebuild = null;
      log(
        `Rebuild finished: ${formatNumber(rebuild.events)} events replayed in ${seconds.toFixed(1)} s. ` +
          (wrong ? `${wrong} balances are still wrong.` : 'Every balance matches the log.'),
        wrong ? 'danger' : 'ok',
      );
    }

    // Query: the read side only ever reads the read model.
    const reads = sampleArrivals(QUERY_RATE, dt);
    for (let index = 0; index < reads; index += 1) {
      const account = Math.floor(Math.random() * ACCOUNTS);
      const stale = projector.balances[account] !== model.truth[account];
      model.reads.push(stale);
      emit(['query', 'readModel', 'query'], stale ? 'warning' : 'cache-hit', 1, 2);
    }
    if (model.reads.length > READ_WINDOW) model.reads.splice(0, model.reads.length - READ_WINDOW);

    current.particles = advanceParticles(current.particles, dt).alive;
    rerender();
  });

  const reset = useCallback(() => {
    // Back to this Concept's starting setup, not the Lab's global default.
    setSetup(start);
    state.current = createState(start);
    clear();
  }, [start, clear, setSetup]);

  const changePartitions = (value: number) => {
    setSetup((current) => ({ ...current, partitions: value }));
    state.current = createState({ ...setup, partitions: value, rebuildOnStart: false });
    log(`Topic recreated with ${value} partition${value === 1 ? '' : 's'} and ${formatNumber(PREFILL)} events of history`, 'info');
  };

  const changeMembers = (value: number) => {
    setSetup((current) => ({ ...current, members: value }));
    const model = state.current.log;
    if (value === 0) {
      log('Billing group has no members: its committed offsets stay, and its lag grows', 'warn');
      return;
    }
    model.billing.pausedUntil = model.clock + REBALANCE_SECONDS;
    const idle = Math.max(0, value - partitions);
    log(
      `Rebalance: ${partitions} partition${partitions === 1 ? '' : 's'} over ${value} member${value === 1 ? '' : 's'}` +
        (idle ? ` - ${idle} member${idle === 1 ? ' has' : 's have'} no partition and sit${idle === 1 ? 's' : ''} idle` : ''),
      idle ? 'warn' : 'info',
    );
  };

  const changeBug = (value: boolean) => {
    setSetup((current) => ({ ...current, bug: value }));
    const model = state.current.log;
    // A snapshot is the output of one version of the projection code; new code cannot trust it.
    const hadSnapshot = Boolean(model.snapshot);
    model.snapshot = null;
    model.projector.sinceSnapshot = 0;
    log(
      value
        ? 'Projector bug shipped: from now on it skips withdrawals'
        : 'Bug fixed: new events are applied right, but the read model keeps the wrong balances until you rebuild it',
      value ? 'danger' : 'warn',
    );
    if (hadSnapshot) log('Projection code changed: the old snapshot was discarded', 'info');
  };

  const changeSnapshots = (value: boolean) => {
    setSetup((current) => ({ ...current, snapshots: value }));
    if (!value) state.current.log.snapshot = null;
    state.current.log.projector.sinceSnapshot = 0;
  };

  const rewindBilling = () => {
    const model = state.current.log;
    const target = Math.min(replayFrom, maxEndOf(model));
    const results = seekBilling(model, target, offsetReset);
    const replay = results.reduce((sum, result) => sum + result.replay, 0);
    const skipped = results.reduce((sum, result) => sum + result.skipped, 0);
    const deleted = results.filter((result) => result.outcome === 'deleted');
    const pastEnd = results.filter((result) => result.outcome === 'past-end');
    log(
      `Billing rewound to offset ${formatNumber(target)}: it will read ${formatNumber(replay)} records again. A real billing consumer must be idempotent, or it charges twice`,
      'warn',
    );
    if (deleted.length) {
      log(
        `Offset ${formatNumber(target)} is gone from ${listPartitions(deleted)}: retention deleted it, so no one can read it again. ` +
          (offsetReset === 'earliest'
            ? 'auto.offset.reset=earliest starts there at the oldest kept offset instead'
            : 'auto.offset.reset=latest jumps there to the log end, so nothing is replayed'),
        'danger',
      );
    }
    if (pastEnd.length) log(`${listPartitions(pastEnd)} ${pastEnd.length === 1 ? 'ends' : 'end'} before offset ${formatNumber(target)}: billing lands on the log end`, 'info');
    if (skipped > 0) log(`${formatNumber(skipped)} records billing had not read yet were jumped over and will never be billed`, 'danger');
  };

  const rebuild = () => {
    const model = state.current.log;
    const started = startRebuild(model, snapshots);
    state.current.projectorCarry = 0;
    const deleted = model.partitions.some((partitionLog) => partitionLog.start > 0);
    log(
      started.fromSnapshot
        ? `Rebuild: read model loaded from the snapshot, replaying the ${formatNumber(started.events)} events after it`
        : `Rebuild: read model thrown away, replaying ${formatNumber(started.events)} events from the oldest kept offset` +
            (deleted ? ' - older records were deleted by retention, so they cannot be replayed' : ''),
      deleted && !started.fromSnapshot ? 'warn' : 'info',
    );
  };

  // ---- Derived view -------------------------------------------------------
  const current = state.current;
  const model = current.log;
  const projector = model.projector;
  const layout = buildLayout(partitions, members, snapshots);

  const memberOwned = Array.from({ length: members }, (_, member) => ownedBy(member, members, partitions));
  const memberLag = memberOwned.map((owned) =>
    owned.reduce((sum, partition) => sum + endOffset(model.partitions[partition]) - model.billing.offsets[partition], 0),
  );
  const memberArrival = memberOwned.map((owned) => (writeRate * owned.reduce((sum, p) => sum + keysOf(p, partitions).length, 0)) / ACCOUNTS);
  const rebalancing = members > 0 && model.clock < model.billing.pausedUntil;
  const billingLag = lagOf(model.billing.offsets, model);
  const projectorLag = lagOf(projector.offsets, model);
  const readLag = readLagSeconds(model);
  const wrong = wrongAccounts(model);
  const staleShare = model.reads.length ? model.reads.filter(Boolean).length / model.reads.length : 0;
  const rebuilding = projector.rebuild;
  const rebuildDone = rebuilding ? clamp(1 - projectorLag / Math.max(rebuilding.events, 1), 0, 1) : 1;
  const logStart = Math.max(...model.partitions.map((partitionLog) => partitionLog.start));
  const maxEnd = maxEndOf(model);
  const replayTarget = Math.min(replayFrom, maxEnd);
  const seekPreview = previewSeek(model, replayTarget, offsetReset);

  const edges: DiagramEdge[] = [
    ...Array.from({ length: partitions }, (_, index) => ({ from: 'producer', to: `p${index}`, tone: 'brand' as const })),
    // Each partition is wired to the one billing member that owns it, and to the
    // projector. A member past the partition count has no wire: that is the lesson.
    ...(members > 0
      ? Array.from({ length: partitions }, (_, index) => ({ from: `p${index}`, to: `m${index % members}`, tone: 'brand' as const }))
      : []),
    ...Array.from({ length: partitions }, (_, index) => ({ from: `p${index}`, to: 'projector', tone: 'violet' as const })),
    { from: 'projector', to: 'readModel', tone: 'violet', width: 2 },
    ...(snapshots ? [{ from: 'projector', to: 'snapshot', tone: 'muted' as const, dashed: true }] : []),
    { from: 'query', to: 'readModel', tone: 'brand' },
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

  const readModelStatus = rebuilding
    ? { status: 'starting' as const, label: `Rebuilding ${Math.round(rebuildDone * 100)}%` }
    : wrong
      ? { status: 'down' as const, label: `${wrong} balance${wrong === 1 ? '' : 's'} wrong` }
      : readLag > 0.25
        ? { status: 'degraded' as const, label: `Behind by ${readLag.toFixed(1)} s` }
        : { status: 'healthy' as const, label: 'Up to date' };

  return (
    <LabShell
      title="Event Log Lab"
      description="An append-only log split into partitions. A consumer group and a projector read it at their own offsets; the projector folds it into a read model you can throw away and rebuild."
      running={running}
      onRunningChange={setRunning}
      onReset={reset}
      events={events}
      actions={
        <>
          <Button onClick={rewindBilling} disabled={members === 0}>
            <Rewind className="h-4 w-4" />
            Rewind billing
          </Button>
          <Button variant="primary" onClick={rebuild}>
            <RefreshCcw className="h-4 w-4" />
            Rebuild read model
          </Button>
        </>
      }
      legend={<Legend />}
      insight={
        <Insight>
          {insightFor({
            setup,
            model,
            rebuildDone,
            wrong,
            readLag,
            staleShare,
            memberLag,
            memberArrival,
            projectorLag,
            logStart,
          })}
        </Insight>
      }
      metrics={
        <MetricsPanel
          items={[
            {
              key: 'readLag',
              label: 'Read lag',
              value: `${readLag.toFixed(1)} s`,
              tone: readLag > 2 ? 'danger' : readLag > 0.25 ? 'warn' : 'ok',
              hint: 'Age of the oldest event the projector has not applied yet: how far the read model trails the write model.',
              simulated: true,
            },
            {
              key: 'stale',
              label: 'Stale reads',
              value: `${Math.round(staleShare * 100)}%`,
              tone: staleShare > 0.3 ? 'danger' : staleShare > 0 ? 'warn' : 'ok',
              hint: `Share of the last ${READ_WINDOW} queries whose balance differed from the write model.`,
              simulated: true,
            },
            {
              key: 'readModel',
              label: 'Read model',
              value: rebuilding ? 'Rebuilding' : wrong ? `${wrong} wrong` : 'Correct',
              tone: rebuilding ? 'info' : wrong ? 'danger' : 'ok',
              hint: 'Compares each balance with a correct fold of the same events: a bug or a deleted record makes them differ, lag alone does not.',
            },
            {
              key: 'billingLag',
              label: 'Billing lag',
              value: members > 0 ? formatNumber(billingLag) : 'no group',
              unit: members > 0 ? 'records' : undefined,
              tone: members === 0 ? 'neutral' : billingLag > 60 ? 'danger' : billingLag > 10 ? 'warn' : 'ok',
              hint: 'Records written but not yet read by the billing group, summed over partitions.',
            },
            {
              key: 'rebuild',
              label: 'Last rebuild',
              value: projector.lastRebuild
                ? `${formatNumber(projector.lastRebuild.events)} in ${projector.lastRebuild.seconds.toFixed(1)} s`
                : 'none yet',
              hint: 'Events replayed and how long it took at the projector speed.',
              simulated: true,
            },
            {
              key: 'rejected',
              label: 'Refused commands',
              value: formatNumber(model.rejected),
              tone: 'neutral',
              hint: 'Withdrawals the write model refused because they would overdraw the account. Refused commands never reach the log.',
            },
          ]}
        />
      }
      controls={
        <>
          <ControlGroup title="Producer (write model)">
            <Slider
              label="Write rate"
              value={writeRate}
              min={0}
              max={40}
              onChange={change('writeRate')}
              format={(value) => `${value} events/s`}
              hint="Deposits and withdrawals on 6 accounts. The account is the key."
            />
          </ControlGroup>
          <ControlGroup title="Topic">
            <Stepper
              label="Partitions"
              value={partitions}
              min={1}
              max={3}
              onChange={changePartitions}
              hint="Changing it recreates the topic here. Real Kafka can only add partitions, and adding them moves keys."
            />
            <Toggle
              label="Size retention"
              checked={retention}
              onChange={change('retention')}
              description={`Keep only the newest ${RETAINED_RECORDS} records per partition`}
            />
          </ControlGroup>
          <ControlGroup title="Consumer group: billing">
            <Stepper
              label="Members"
              value={members}
              min={0}
              max={4}
              onChange={changeMembers}
              hint="Each partition goes to exactly one member. 0 removes the group."
            />
            <Slider
              label="Member speed"
              value={memberRate}
              min={1}
              max={20}
              onChange={change('memberRate')}
              disabled={members === 0}
              format={(value) => `${value} records/s`}
            />
            <Slider
              label="Replay from offset"
              value={replayTarget}
              min={0}
              max={Math.max(maxEnd, 1)}
              onChange={change('replayFrom')}
              disabled={members === 0}
              format={(value) => `offset ${formatNumber(value)}`}
              scale={['0', `${formatNumber(maxEnd)} (newest end)`]}
              hint="Rewind billing commits this offset on every partition, like kafka-consumer-groups --reset-offsets --to-offset. Offsets of different partitions are unrelated numbers; the Lab uses one slider for all of them to keep it simple."
            />
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted">If that offset was deleted (auto.offset.reset)</p>
              <SegmentedControl
                size="sm"
                value={offsetReset}
                onChange={change('offsetReset')}
                options={[
                  { value: 'earliest', label: 'earliest' },
                  { value: 'latest', label: 'latest' },
                ]}
              />
            </div>
            {members > 0 ? <SeekPreview results={seekPreview} model={model} reread={model.billing.reread} /> : null}
          </ControlGroup>
          <ControlGroup title="Projector and read model">
            <Slider
              label="Projector speed"
              value={projectorRate}
              min={2}
              max={80}
              step={2}
              onChange={change('projectorRate')}
              format={(value) => `${value} events/s`}
              hint="Also the replay speed of a rebuild."
            />
            <Slider
              label="Projection delay"
              value={delayMs}
              min={0}
              max={3000}
              step={100}
              onChange={change('delayMs')}
              format={(value) => `${value} ms`}
              hint="Transport and batching between the log and the projector."
            />
            <Toggle
              label="Projector bug"
              checked={bug}
              onChange={changeBug}
              description="The projection code skips withdrawals"
            />
            <Toggle
              label="Snapshots"
              checked={snapshots}
              onChange={changeSnapshots}
              description={`Save the read model every ${SNAPSHOT_EVERY} events; a rebuild starts from the latest one`}
            />
          </ControlGroup>
          <p className="text-[11px] text-faint">
            Simplified model: one event is one record, a key goes to partition account mod partitions, partitions go to
            members round robin, and a rebalance pauses the group for {REBALANCE_SECONDS} s. Rewind billing applies
            auto.offset.reset at once; a real consumer does it on its next fetch. Rates are not broker benchmarks.
          </p>
        </>
      }
    >
      <DiagramCanvas layout={layout} edges={edges} particles={particleViews} width={WIDTH} height={HEIGHT} className="bg-canvas">
        <ArchNode kind="server" title="Accounts API" subtitle="write model: appends events" placed={layout.producer} compact>
          <NodeStatRow label="Writes" value={`${writeRate}/s`} />
          <NodeStatRow label="Refused" value={formatNumber(model.rejected)} tone={model.rejected ? 'text-warn' : 'text-ink'} />
        </ArchNode>

        {model.partitions.map((partitionLog, index) => {
          const end = endOffset(partitionLog);
          return (
            <ArchNode
              key={index}
              kind="queue"
              title={`Partition ${index}`}
              subtitle={
                partitions === 1
                  ? `key: all ${ACCOUNTS} accounts`
                  : `key: ${keysOf(index, partitions)
                      .map((account) => `acct ${account + 1}`)
                      .join(', ')}`
              }
              placed={layout[`p${index}`]}
              // The status line carries the offsets still kept: retention is what moves its start.
              status={partitionLog.start > 0 ? 'degraded' : 'healthy'}
              statusLabel={
                partitionLog.start > 0
                  ? `keeps offsets ${formatNumber(partitionLog.start)} to ${formatNumber(end - 1)}`
                  : `keeps every offset, 0 to ${formatNumber(Math.max(end - 1, 0))}`
              }
              compact
            >
              {members > 0 ? <OffsetTrack label="billing" offset={model.billing.offsets[index]} end={end} tone="brand" /> : null}
              <OffsetTrack label="projector" offset={projector.offsets[index]} end={end} tone="violet" />
            </ArchNode>
          );
        })}

        {memberOwned.map((owned, member) => {
          const lagging = memberArrival[member] > memberRate && memberLag[member] > 10;
          return (
            <ArchNode
              key={member}
              kind="worker"
              title={`Billing ${member + 1}`}
              subtitle={owned.length ? `owns ${owned.map((partition) => `P${partition}`).join(', ')}` : 'no partition left'}
              placed={layout[`m${member}`]}
              status={rebalancing ? 'starting' : !owned.length || lagging ? 'degraded' : 'healthy'}
              statusLabel={rebalancing ? 'Rebalancing' : !owned.length ? 'Idle' : lagging ? 'Falling behind' : 'Keeping up'}
              alert={lagging}
              compact
            >
              <NodeStatRow label="Lag" value={formatNumber(memberLag[member])} tone={lagging ? 'text-warn' : 'text-ink'} />
            </ArchNode>
          );
        })}

        <ArchNode
          kind="worker"
          title="Projector"
          subtitle="its own consumer group"
          placed={layout.projector}
          status={rebuilding ? 'starting' : bug ? 'degraded' : 'healthy'}
          statusLabel={rebuilding ? 'Replaying' : bug ? 'Bug: skips withdrawals' : 'Applying events'}
          alert={bug}
          compact
        >
          <NodeStatRow label="Lag" value={formatNumber(projectorLag)} tone={projectorLag > 20 ? 'text-warn' : 'text-ink'} />
          <NodeStatRow label="Speed" value={`${projectorRate}/s`} />
        </ArchNode>

        {snapshots ? (
          <ArchNode
            kind="storage"
            title="Snapshot store"
            subtitle={model.snapshot ? `taken after ${formatNumber(sumOffsets(model.snapshot.offsets))} events` : 'none yet'}
            placed={layout.snapshot}
            compact
          >
            <NodeStatRow label="Every" value={`${SNAPSHOT_EVERY} events`} />
          </ArchNode>
        ) : null}

        <ArchNode
          kind="nosql"
          title="Read model"
          subtitle="balances, derived from the log"
          placed={layout.readModel}
          status={readModelStatus.status}
          statusLabel={readModelStatus.label}
          alert={wrong > 0}
          compact
        >
          <div className="grid grid-cols-3 gap-x-3 gap-y-0.5">
            {projector.balances.map((balance, account) => {
              const off = balance !== projector.correct[account];
              return (
                <div key={account} className="flex items-baseline justify-between gap-1 text-[11px]">
                  <span className="text-faint">acct {account + 1}</span>
                  <span className={cn('font-mono font-semibold tabular-nums', off ? 'text-danger' : 'text-ink')}>
                    {off ? '!' : ''}
                    {formatNumber(balance)}
                  </span>
                </div>
              );
            })}
          </div>
          <NodeStatRow label="Events applied" value={formatNumber(sumOffsets(projector.offsets))} />
        </ArchNode>

        <ArchNode
          kind="client"
          title="Query"
          subtitle={`reads a balance ${QUERY_RATE}/s`}
          placed={layout.query}
          status={staleShare > 0 ? 'degraded' : 'healthy'}
          statusLabel={staleShare > 0 ? 'Some reads stale' : 'Reads fresh'}
          compact
        >
          <NodeStatRow
            label="Stale reads"
            value={`${Math.round(staleShare * 100)}%`}
            tone={staleShare > 0.3 ? 'text-danger' : staleShare > 0 ? 'text-warn' : 'text-ok'}
          />
        </ArchNode>
      </DiagramCanvas>
    </LabShell>
  );
}

/** Accounts whose key lands on a partition. */
const keysOf = (partition: number, partitions: number) =>
  Array.from({ length: ACCOUNTS }, (_, account) => account).filter((account) => partitionOf(account, partitions) === partition);

const sumOffsets = (offsets: number[]) => offsets.reduce((sum, offset) => sum + offset, 0);

/** The highest log end offset over all partitions: the top of the Replay from slider. */
const maxEndOf = (model: LogState) => Math.max(...model.partitions.map(endOffset));

const listPartitions = (results: SeekResult[]) => results.map((result) => `P${result.partition}`).join(', ');

/**
 * Where Rewind billing would land on each partition with the offset picked now:
 * the kept range is written out, so an offset older than retention reads as
 * "deleted", never as a silent jump.
 */
function SeekPreview({ results, model, reread }: { results: SeekResult[]; model: LogState; reread: number }) {
  return (
    <div className="space-y-1 text-[11px]">
      {results.map((result) => {
        const log = model.partitions[result.partition];
        return (
          <div key={result.partition} className="flex items-baseline justify-between gap-2">
            <span className="shrink-0 text-faint">
              P{result.partition} keeps {formatNumber(log.start)}-{formatNumber(Math.max(endOffset(log) - 1, 0))}
            </span>
            <span
              className={cn(
                'text-right font-mono tabular-nums',
                result.outcome === 'deleted' ? 'text-danger' : result.outcome === 'past-end' ? 'text-muted' : 'text-ink',
              )}
            >
              {result.outcome === 'deleted'
                ? `deleted, lands on ${formatNumber(result.landed)}`
                : result.outcome === 'past-end'
                  ? 'past its end, lands on end'
                  : result.skipped > 0
                    ? `skips ${formatNumber(result.skipped)} unread`
                    : `re-reads ${formatNumber(result.replay)}`}
            </span>
          </div>
        );
      })}
      <p className="text-faint">Records billing read twice so far: {formatNumber(reread)}</p>
    </div>
  );
}

/** Records shown on an offset track: the newest ones, so a small lag is still visible. */
const TRACK_WINDOW = 60;

/**
 * Where one group stands in a partition: the filled part is what it has read,
 * the rest up to the log end is its lag. Its offset and lag are written out
 * too, so the picture never carries meaning by colour alone.
 */
function OffsetTrack({ label, offset, end, tone }: { label: string; offset: number; end: number; tone: 'brand' | 'violet' }) {
  const from = Math.max(0, end - TRACK_WINDOW);
  const read = clamp((offset - from) / Math.max(end - from, 1), 0, 1);
  const lag = end - offset;
  return (
    <div className="space-y-0.5">
      <div className="flex items-baseline justify-between gap-2 text-[11px]">
        <span className="text-faint">{label} at offset</span>
        <span className="font-mono tabular-nums text-ink">
          {offset < from ? '< ' : ''}
          {formatNumber(offset)}
          <span className={cn('ml-1', lag > 10 ? 'text-warn' : 'text-faint')}>lag {formatNumber(lag)}</span>
        </span>
      </div>
      <div className="flex h-1.5 overflow-hidden rounded-full bg-elevated" aria-hidden>
        <div className={cn('h-full', tone === 'brand' ? 'bg-brand/70' : 'bg-violet/70')} style={{ width: `${read * 100}%` }} />
        <div className="h-full flex-1 bg-warn/40" />
      </div>
    </div>
  );
}

function ControlGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-3 border-b border-line pb-4 last:border-b-0">
      <p className="label">{title}</p>
      {children}
    </div>
  );
}

/** Particle legend in this Lab's words: shape and text, never colour alone. */
function Legend() {
  return (
    <ParticleLegend
      outcomes={[
        { outcome: 'success', label: 'Event (one record)' },
        { outcome: 'cache-hit', label: 'Fresh read, or a snapshot saved' },
        { outcome: 'warning', label: 'Stale read' },
      ]}
    />
  );
}

interface InsightInput {
  setup: Setup;
  model: LogState;
  rebuildDone: number;
  wrong: number;
  readLag: number;
  staleShare: number;
  memberLag: number[];
  memberArrival: number[];
  projectorLag: number;
  logStart: number;
}

/** The one thing worth noticing right now, most urgent first. */
function insightFor({
  setup,
  model,
  rebuildDone,
  wrong,
  readLag,
  staleShare,
  memberLag,
  memberArrival,
  projectorLag,
  logStart,
}: InsightInput) {
  const { writeRate, partitions, members, memberRate, projectorRate, bug, snapshots, retention } = setup;
  const projector = model.projector;
  const rebuild = projector.rebuild;

  if (rebuild) {
    return (
      <>
        Replaying: {Math.round(rebuildDone * 100)}% of {formatNumber(rebuild.events)} events. The read model was thrown
        away and is being rebuilt by folding the log{' '}
        {rebuild.fromSnapshot ? 'from the latest snapshot onward' : 'from the oldest record still kept'}, at{' '}
        {projectorRate} events/s. Nothing was copied from the old read model - the events are the source of truth, and
        the balances are only a result of them.
        {!rebuild.fromSnapshot && !snapshots ? ' Turn on Snapshots and rebuild again to see how much less there is to replay.' : ''}
      </>
    );
  }
  if (wrong > 0) {
    if (bug) {
      return (
        <>
          The projector skips withdrawals, so {wrong} balance{wrong === 1 ? ' is' : 's are'} too high (marked with !).
          The log itself is fine - only the derived view is wrong. Turn the bug off: new events are then right, but the
          damage stays until you press Rebuild read model and replay the log with the fixed code.
        </>
      );
    }
    if (projector.skipped > 0 || logStart > 0) {
      return (
        <>
          Retention deleted records the read model needed, so {wrong} balance{wrong === 1 ? ' is' : 's are'} wrong and
          no rebuild can fix it: replay can only start at offset {formatNumber(logStart)}, and the events before it are
          gone. An event store keeps every event forever; a Kafka topic used as one needs time and size retention turned
          off.
        </>
      );
    }
    return (
      <>
        The bug is fixed, but {wrong} balance{wrong === 1 ? ' is' : 's are'} still wrong: the read model only saw new
        events with the new code. Press Rebuild read model - replaying the log with fixed code is how a projection bug is
        repaired.
        {snapshots ? ' The old snapshot was discarded, because it was built by the buggy code.' : ''}
      </>
    );
  }
  const idle = members - partitions;
  if (members > 0 && idle > 0) {
    return (
      <>
        {members} members, {partitions} partition{partitions === 1 ? '' : 's'}: {idle} member{idle === 1 ? ' has' : 's have'}{' '}
        nothing to read. A partition goes to exactly one member of a group, so the partition count is the ceiling on
        parallelism - add partitions, not members.
      </>
    );
  }
  const slow = memberArrival.findIndex((arrival, member) => arrival > memberRate && memberLag[member] > 10);
  if (members > 0 && slow >= 0) {
    return (
      <>
        Billing {slow + 1} owns more keys than it can keep up with: about {memberArrival[slow].toFixed(0)} records/s arrive
        on its partitions and it reads {memberRate}/s, so its lag grows. Add a member - the group rebalances and the
        partitions spread out. The projector reads the very same partitions at its own offsets and is not slowed down at
        all.
      </>
    );
  }
  if (projectorRate < writeRate && projectorLag > 10) {
    return (
      <>
        Writes arrive at {writeRate}/s and the projector applies {projectorRate}/s, so the read lag grows without limit
        (now {readLag.toFixed(1)} s). The write side is unaffected - commands are still accepted at once - but every query
        sees older data. Raise Projector speed.
      </>
    );
  }
  if (readLag > 0.25) {
    return (
      <>
        A write is accepted by the write model at once, but the read model only shows it about {readLag.toFixed(1)} s
        later, so {Math.round(staleShare * 100)}% of queries read an old balance. That is the price of a separate read
        model: eventual consistency. Lower Projection delay to shrink it; a screen that must show the user their own
        write can read the write side, or update itself from the command result.
      </>
    );
  }
  if (members > 0) {
    return (
      <>
        Two consumer groups read the same {partitions} partition{partitions === 1 ? '' : 's'}: billing and the projector.
        Each keeps its own offset per partition, and reading deletes nothing. Pick an offset under Replay from offset and
        press Rewind billing: it reads from there again while the projector carries on untouched.
        {retention
          ? ' An offset below the kept range is gone for good - auto.offset.reset decides whether billing starts at the oldest kept record or skips to the end.'
          : ' Then turn on Size retention and ask for an offset it already deleted.'}
      </>
    );
  }
  if (projector.lastRebuild) {
    const last = projector.lastRebuild;
    return (
      <>
        The last rebuild replayed {formatNumber(last.events)} events in {last.seconds.toFixed(1)} s and produced exactly the
        same balances: state is a fold over the events.{' '}
        {last.fromSnapshot
          ? 'It started from a snapshot, so only the events after it had to be replayed.'
          : snapshots
            ? 'The next rebuild will start from the latest snapshot.'
            : 'Replay time grows with the log - turn on Snapshots, wait for one, and rebuild again.'}
      </>
    );
  }
  return (
    <>
      Every event is appended to the log and never changed. The read model is only a fold over those events, so it can be
      thrown away and rebuilt at any time - press Rebuild read model, or turn on the Projector bug to break it first.
    </>
  );
}

export default EventLogLab;
