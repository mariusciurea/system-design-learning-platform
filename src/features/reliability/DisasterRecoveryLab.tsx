import { useCallback, useRef, useState } from 'react';
import { Bug, Flame, Wrench } from 'lucide-react';
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
import { sampleArrivals } from '@/utils/math';
import { cn } from '@/utils/cn';
import { formatSeconds } from '@/utils/format';
import type { NodeStatus, RequestOutcome } from '@/types';
import { useLabRunning } from '@/hooks/useLabRunning';

/*
 * Simplified model, not a measurement. Every duration below is a round,
 * illustrative number chosen so the strategies land in the ranges the AWS
 * disaster recovery whitepaper gives them (backup and restore: hours; pilot
 * light: tens of minutes; warm standby: minutes). A real RTO is whatever a
 * rehearsed restore of your own system measured.
 */

/** Simulated minutes that pass per real second. */
const SIM_MIN_PER_SEC = 10;
/** The simulated clock starts at 09:00. */
const START_CLOCK = 9 * 60;
/** How far an asynchronous replica trails the primary: a few seconds. */
const ASYNC_LAG_MIN = 5 / 60;
/** Extra time every write waits for a cross-region acknowledgement under synchronous replication. */
const SYNC_WRITE_PENALTY_MS = 70;
const LOCAL_WRITE_MS = 8;

const DURATION = {
  /** A human notices the region is gone and declares a disaster. */
  declare: 10,
  /** Health checks trip and automation starts the failover (hot standby only). */
  autoDetect: 2,
  /** Nobody notices the bad data for a while: every health check stays green. */
  noticeCorruption: 30,
  /** Restoring a 500 GB database from backup. */
  restore: 180,
  /** Promoting the replica to primary. */
  promote: 5,
  /** Deploying app servers from infrastructure as code. */
  deployApp: 30,
  /** Scaling a warm, scaled-down fleet up to full size. */
  scaleWarm: 5,
  /** DNS change plus the TTL for clients to follow it. */
  dns: 5,
  /** An unrehearsed plan: the key nobody can reach, the stale runbook, the missing permission. */
  surprises: 60,
} as const;

const BACKUP_OPTIONS = [5, 60, 360, 1440] as const;

type Replication = 'none' | 'async' | 'sync';
type Standby = 'off' | 'warm' | 'hot';
type BackupWhere = 'same' | 'other';
type DisasterKind = 'region' | 'corruption';

interface Setup {
  /** Index into BACKUP_OPTIONS. */
  backupIndex: number;
  backupWhere: BackupWhere;
  replication: Replication;
  standby: Standby;
  rehearsed: boolean;
}

/** Single host, no Lab focus: the lab opens on backups only, the cheapest and slowest setup. */
const DEFAULT_SETUP: Setup = {
  backupIndex: 1,
  backupWhere: 'other',
  replication: 'none',
  standby: 'off',
  rehearsed: true,
};

interface Stage {
  label: string;
  minutes: number;
}

interface Disaster {
  kind: DisasterKind;
  at: number;
  setup: Setup;
  stages: Stage[];
  /** Minutes of writes lost, or null when nothing survived to restore from. */
  dataLost: number | null;
  recoveredAt: number | null;
}

interface SimState {
  clock: number;
  lastBackupAt: number;
  particles: Particle[];
  disaster: Disaster | null;
}

interface RunResult {
  id: number;
  kind: DisasterKind;
  strategy: string;
  backup: string;
  dataLost: number | null;
  timeToRecover: number | null;
}

const createState = (backupEvery: number): SimState => ({
  clock: START_CLOCK,
  // Start part-way through a backup cycle, so the at-risk window is not empty on the first frame.
  lastBackupAt: START_CLOCK - backupEvery * 0.6,
  particles: [],
  disaster: null,
});

function strategyName({ replication, standby }: Setup) {
  if (replication === 'none') return 'Backup and restore';
  if (standby === 'off') return 'Pilot light';
  if (standby === 'warm') return 'Warm standby';
  return 'Hot standby';
}

/** Relative monthly cost, region A alone = 100. Illustrative, not a price list. */
function relativeCost({ replication, standby }: Setup) {
  const replica = replication === 'none' ? 0 : 35;
  const apps = standby === 'off' ? 0 : standby === 'warm' ? 20 : 60;
  return 100 + 5 + replica + apps;
}

/** The ordered recovery steps for one disaster under one setup. */
function planRecovery(kind: DisasterKind, setup: Setup): { stages: Stage[]; recoverable: boolean } {
  const stages: Stage[] = [];
  if (kind === 'corruption') {
    // Replication copied the bad write within seconds, so the replica is no help:
    // the only clean copy is the last backup taken before the migration ran.
    stages.push({ label: 'Someone notices the bad data', minutes: DURATION.noticeCorruption });
    if (!setup.rehearsed) stages.push({ label: 'Untested plan: find the key, the runbook', minutes: DURATION.surprises });
    stages.push({ label: 'Restore the last good backup', minutes: DURATION.restore });
    return { stages, recoverable: true };
  }

  if (setup.replication === 'none' && setup.backupWhere === 'same') return { stages: [], recoverable: false };

  stages.push(
    setup.standby === 'hot'
      ? { label: 'Health checks trip the failover', minutes: DURATION.autoDetect }
      : { label: 'Declare the disaster', minutes: DURATION.declare },
  );
  if (!setup.rehearsed) stages.push({ label: 'Untested plan: find the key, the runbook', minutes: DURATION.surprises });
  stages.push(
    setup.replication === 'none'
      ? { label: 'Restore the backup in region B', minutes: DURATION.restore }
      : { label: 'Promote the standby database', minutes: DURATION.promote },
  );
  if (setup.standby === 'off') stages.push({ label: 'Deploy app servers from code', minutes: DURATION.deployApp });
  if (setup.standby === 'warm') stages.push({ label: 'Scale the warm fleet up', minutes: DURATION.scaleWarm });
  stages.push({ label: 'Point DNS at region B', minutes: DURATION.dns });
  return { stages, recoverable: true };
}

/** Minutes of writes a disaster right now would lose, or null for everything. */
function dataAtRisk(kind: DisasterKind, setup: Setup, clock: number, lastBackupAt: number) {
  if (kind === 'corruption') return clock + DURATION.noticeCorruption - lastBackupAt;
  if (setup.replication === 'sync') return 0;
  if (setup.replication === 'async') return ASYNC_LAG_MIN;
  if (setup.backupWhere === 'same') return null;
  return clock - lastBackupAt;
}

const totalMinutes = (stages: Stage[]) => stages.reduce((sum, stage) => sum + stage.minutes, 0);

/** Simulated minutes as a duration; `null` is data that no backup covers. */
const formatMinutes = (minutes: number | null) => (minutes === null ? 'everything' : formatSeconds(minutes * 60));

/** The simulated wall clock: "09:30", then "day 2 09:30" once it passes midnight. */
function formatSimClock(minutes: number) {
  const day = Math.floor(minutes / 1440);
  const inDay = ((minutes % 1440) + 1440) % 1440;
  const hh = String(Math.floor(inDay / 60)).padStart(2, '0');
  const mm = String(Math.floor(inDay % 60)).padStart(2, '0');
  return `${day > 0 ? `day ${day + 1} ` : ''}${hh}:${mm}`;
}

const backupLabel = (every: number) => (every < 60 ? `${every} min` : `${every / 60} h`);

const CANVAS_W = 960;
const CANVAS_H = 560;

const BASE_LAYOUT: Layout = {
  users: { x: 400, y: 14, w: 160, h: 74 },
  dns: { x: 400, y: 106, w: 160, h: 74 },
  appA: { x: 50, y: 226, w: 210, h: 94 },
  dbA: { x: 50, y: 335, w: 210, h: 116 },
  appB: { x: 700, y: 226, w: 210, h: 94 },
  dbB: { x: 700, y: 335, w: 210, h: 116 },
};

/** The backups sit under the database of whichever region holds them. */
const BACKUP_BOX = {
  same: { x: 70, y: 476, w: 170, h: 74 },
  other: { x: 720, y: 476, w: 170, h: 74 },
};

function RegionZones({ lost }: { lost: boolean }) {
  return (
    <g>
      <rect
        x={20}
        y={196}
        width={430}
        height={356}
        rx={16}
        className={cn('fill-none', lost ? 'stroke-danger' : 'stroke-line')}
        strokeWidth={1.5}
        strokeDasharray="6 6"
      />
      <text x={36} y={216} className="fill-muted font-mono" style={{ fontSize: 11 }}>
        {lost ? 'REGION A - LOST' : 'REGION A - primary'}
      </text>
      <rect
        x={510}
        y={196}
        width={430}
        height={356}
        rx={16}
        className="fill-none stroke-line"
        strokeWidth={1.5}
        strokeDasharray="6 6"
      />
      <text x={526} y={216} className="fill-muted font-mono" style={{ fontSize: 11 }}>
        REGION B - recovery
      </text>
    </g>
  );
}

/**
 * Disaster recovery: a primary region and a recovery region. The learner picks
 * how often backups run, where they live, how the database replicates and how
 * much of region B is running, then destroys region A (or ships a bad
 * migration) and reads the data lost and the time to recover.
 */
export function DisasterRecoveryLab() {
  // Every control lives in one object, so Reset cannot miss one.
  const { setup, setSetup, change } = useLabSetup(DEFAULT_SETUP);
  const backupEvery = BACKUP_OPTIONS[setup.backupIndex];

  const [running, setRunning] = useLabRunning();
  const [results, setResults] = useState<RunResult[]>([]);
  const state = useRef<SimState>(createState(backupEvery));
  const rerender = useRerender(30);
  const { events, log, clear } = useEventLog();

  useTicker(running, (dt) => {
    const sim = state.current;
    const every = BACKUP_OPTIONS[setup.backupIndex];
    sim.clock += dt * SIM_MIN_PER_SEC;
    const disaster = sim.disaster;
    const spawn = (route: string[], outcome: RequestOutcome, rate: number, speed = 1.3) => {
      const count = sampleArrivals(rate, dt);
      for (let index = 0; index < count; index += 1) {
        sim.particles.push({ id: nextParticleId(), route, leg: 0, t: 0, speed: speed + Math.random() * 0.4, outcome });
      }
    };

    if (!disaster) {
      // Normal running: region A serves, the replica follows, backups tick on schedule.
      spawn(['users', 'dns', 'appA', 'dbA'], 'success', 6);
      if (setup.replication !== 'none') spawn(['dbA', 'dbB'], 'success', 3, 1.1);
      if (sim.clock - sim.lastBackupAt >= every) {
        sim.lastBackupAt = sim.clock;
        for (let index = 0; index < 3; index += 1) {
          sim.particles.push({ id: nextParticleId(), route: ['dbA', 'backups'], leg: 0, t: -index * 0.25, speed: 1.2, outcome: 'success' });
        }
      }
    } else {
      const elapsed = sim.clock - disaster.at;
      const total = totalMinutes(disaster.stages);
      const recovered = disaster.recoveredAt !== null;
      const stage = activeStage(disaster.stages, elapsed);

      if (disaster.kind === 'region') {
        if (recovered) spawn(['users', 'dns', 'appB', 'dbB'], 'success', 6);
        else spawn(['users', 'dns', 'appA'], 'failure', 4);
        if (!recovered && stage?.label.startsWith('Restore')) spawn(['backups', 'dbB'], 'success', 4, 1);
      } else {
        const noticed = elapsed >= DURATION.noticeCorruption;
        if (recovered) spawn(['users', 'dns', 'appA', 'dbA'], 'success', 6);
        else if (!noticed) spawn(['users', 'dns', 'appA', 'dbA'], 'warning', 6);
        else spawn(['users', 'dns', 'appA'], 'failure', 4);
        if (disaster.setup.replication !== 'none' && (recovered || !noticed))
          spawn(['dbA', 'dbB'], recovered ? 'success' : 'warning', 3, 1.1);
        if (!recovered && stage?.label.startsWith('Restore')) spawn(['backups', 'dbA'], 'success', 4, 1);
      }

      if (!recovered && disaster.stages.length > 0 && elapsed >= total) {
        disaster.recoveredAt = disaster.at + total;
        const name = strategyName(disaster.setup);
        log(`Recovered after ${formatMinutes(total)} with ${name}, ${formatMinutes(disaster.dataLost)} of writes lost`, 'ok');
        setResults((list) =>
          [
            {
              id: nextParticleId(),
              kind: disaster.kind,
              strategy: name,
              backup: `${backupLabel(BACKUP_OPTIONS[disaster.setup.backupIndex])}, ${disaster.setup.backupWhere === 'other' ? 'region B' : 'region A'}`,
              dataLost: disaster.dataLost,
              timeToRecover: total,
            },
            ...list,
          ].slice(0, 8),
        );
      }
    }

    const { alive } = advanceParticles(sim.particles, dt);
    sim.particles = alive.slice(-80);
    rerender();
  });

  const strike = useCallback(
    (kind: DisasterKind) => {
      const sim = state.current;
      if (sim.disaster) return;
      const { stages, recoverable } = planRecovery(kind, setup);
      const dataLost = dataAtRisk(kind, setup, sim.clock, sim.lastBackupAt);
      sim.disaster = { kind, at: sim.clock, setup, stages, dataLost, recoveredAt: null };
      if (kind === 'region') {
        log('Region A is gone: app servers, primary database' + (setup.backupWhere === 'same' ? ' and the backups with it' : ''), 'danger');
      } else {
        log('A bad migration corrupts the orders table', 'danger');
        if (setup.replication !== 'none') log('Replication copies the corrupted rows to the standby within seconds', 'warn');
      }
      if (!recoverable) {
        log('No replica and no copy outside region A: there is nothing to restore from', 'danger');
        setResults((list) =>
          [
            {
              id: nextParticleId(),
              kind,
              strategy: strategyName(setup),
              backup: `${backupLabel(BACKUP_OPTIONS[setup.backupIndex])}, region A`,
              dataLost: null,
              timeToRecover: null,
            },
            ...list,
          ].slice(0, 8),
        );
      } else {
        log(`Recovery plan: ${stages.map((stage) => stage.label.toLowerCase()).join(', then ')}`, 'info');
      }
      setRunning(true);
    },
    [setup, log, setRunning],
  );

  const rebuild = useCallback(() => {
    state.current = createState(BACKUP_OPTIONS[setup.backupIndex]);
    log('Region A rebuilt and serving again - change the setup and strike again', 'info');
    rerender();
  }, [setup.backupIndex, log, rerender]);

  const reset = useCallback(() => {
    setSetup(DEFAULT_SETUP);
    state.current = createState(BACKUP_OPTIONS[DEFAULT_SETUP.backupIndex]);
    setResults([]);
    clear();
    rerender();
  }, [clear, rerender, setSetup]);

  const sim = state.current;
  const disaster = sim.disaster;
  const elapsed = disaster ? sim.clock - disaster.at : 0;
  const recovered = disaster?.recoveredAt != null;
  const recoverable = !disaster || disaster.stages.length > 0;
  const stageNow = disaster ? activeStage(disaster.stages, elapsed) : null;
  const regionLost = disaster?.kind === 'region';
  const corrupted = disaster?.kind === 'corruption' && !recovered;
  const noticed = disaster?.kind === 'corruption' && elapsed >= DURATION.noticeCorruption;
  const effective = disaster?.setup ?? setup;
  const restoring = Boolean(stageNow?.label.startsWith('Restore')) && !recovered;

  const regionPlan = planRecovery('region', setup);
  const expectedRto = regionPlan.recoverable ? totalMinutes(regionPlan.stages) : null;
  const riskNow = dataAtRisk('region', setup, sim.clock, sim.lastBackupAt);
  const writeMs = LOCAL_WRITE_MS + (setup.replication === 'sync' ? SYNC_WRITE_PENALTY_MS : 0);

  const layout: Layout = { ...BASE_LAYOUT, backups: BACKUP_BOX[effective.backupWhere] };
  const backupsLost = regionLost && effective.backupWhere === 'same';

  // Region B pieces: what exists before the disaster, and what the recovery has built so far.
  const dbBBuilt = effective.replication !== 'none' || (regionLost && recovered);
  const dbBStatus: { status: NodeStatus; label?: string } = regionLost
    ? recovered
      ? { status: 'healthy', label: 'Primary' }
      : stageNow?.label.startsWith('Promote') || restoring
        ? { status: 'starting', label: restoring ? 'Restoring' : 'Promoting' }
        : dbBBuilt
          ? { status: 'healthy', label: 'Replica' }
          : { status: 'down', label: 'Not built' }
    : !dbBBuilt
      ? { status: 'down', label: 'Not built' }
      : corrupted
        ? { status: 'degraded', label: 'Corrupted' }
        : { status: 'healthy', label: 'Replica' };

  const appBStatus: { status: NodeStatus; label?: string } =
    regionLost && recovered
      ? { status: 'healthy', label: 'Serving' }
      : regionLost && (stageNow?.label.startsWith('Deploy') || stageNow?.label.startsWith('Scale'))
        ? { status: 'starting', label: stageNow.label.startsWith('Deploy') ? 'Deploying' : 'Scaling up' }
        : effective.standby === 'off'
          ? { status: 'down', label: 'Off' }
          : { status: 'healthy', label: 'Idle' };

  const aStatus: { status: NodeStatus; label?: string } = regionLost
    ? { status: 'down', label: 'Lost' }
    : corrupted
      ? noticed
        ? { status: 'starting', label: 'Restoring' }
        : { status: 'degraded', label: 'Wrong data' }
      : { status: 'healthy' };

  const serving = regionLost ? (recovered ? 'B' : 'none') : corrupted && noticed ? 'none' : 'A';
  const edges: DiagramEdge[] = [
    { from: 'users', to: 'dns', tone: 'brand', width: 2 },
    {
      from: 'dns',
      to: 'appA',
      tone: regionLost ? (recovered ? 'muted' : 'danger') : serving === 'A' ? 'brand' : 'danger',
      dashed: regionLost && recovered,
    },
    { from: 'dns', to: 'appB', tone: serving === 'B' ? 'brand' : 'muted', dashed: serving !== 'B' },
    { from: 'appA', to: 'dbA', tone: regionLost ? 'muted' : 'default', dashed: regionLost },
    { from: 'appB', to: 'dbB', tone: serving === 'B' ? 'default' : 'muted', dashed: serving !== 'B' },
    { from: 'dbA', to: 'backups', tone: backupsLost ? 'muted' : 'info' },
    { from: 'backups', to: 'dbB', tone: restoring && regionLost ? 'ok' : 'muted', dashed: !(restoring && regionLost), animated: restoring && regionLost },
  ];
  if (effective.replication !== 'none') {
    edges.push({
      from: 'dbA',
      to: 'dbB',
      tone: regionLost ? 'muted' : corrupted ? 'warn' : 'violet',
      dashed: regionLost,
      label: effective.replication === 'sync' ? 'sync replication' : 'async replication',
    });
  }

  const particleViews: ParticleView[] = sim.particles
    .filter((particle) => particle.t >= 0)
    .map((particle) => ({
      id: particle.id,
      from: particle.route[particle.leg],
      to: particle.route[particle.leg + 1],
      t: particle.t,
      outcome: particle.outcome ?? 'success',
    }));

  const locked = disaster !== null;
  const replicaLag = effective.replication === 'sync' ? '0' : effective.replication === 'async' ? '~5 s' : '-';

  return (
    <LabShell
      title="Disaster Recovery Lab"
      description="Choose how often you back up, where the backups live, how the database replicates and how much of region B runs. Then lose region A, or ship a bad migration, and read the data lost (RPO) and the time to recover (RTO)."
      running={running}
      onRunningChange={setRunning}
      onReset={reset}
      legend={
        <div className="flex flex-wrap items-center justify-between gap-2">
          <ParticleLegend
            outcomes={[
              { outcome: 'success', label: 'Request, copy or backup' },
              { outcome: 'warning', label: 'Bad data served or copied' },
              { outcome: 'failure', label: 'Failed request' },
            ]}
          />
          <span className="font-mono text-[11px] text-faint">
            simulated clock {formatSimClock(sim.clock)} - 1 s = {SIM_MIN_PER_SEC} min
          </span>
        </div>
      }
      events={events}
      actions={
        disaster ? (
          <Button variant="primary" onClick={rebuild}>
            <Wrench className="h-4 w-4" />
            Rebuild and run again
          </Button>
        ) : (
          <>
            <Button variant="secondary" onClick={() => strike('corruption')}>
              <Bug className="h-4 w-4" />
              Ship a bad migration
            </Button>
            <Button variant="danger" onClick={() => strike('region')}>
              <Flame className="h-4 w-4" />
              Lose region A
            </Button>
          </>
        )
      }
      insight={<Insight>{insightText()}</Insight>}
      metrics={
        <>
          <MetricsPanel
            title={disaster ? 'This disaster' : 'If region A died right now'}
            items={
              disaster
                ? [
                    { key: 'strategy', label: 'Strategy', value: strategyName(disaster.setup) },
                    {
                      key: 'rpo',
                      label: 'Data lost (RPO)',
                      value: formatMinutes(disaster.dataLost),
                      tone: disaster.dataLost === null ? 'danger' : disaster.dataLost > 60 ? 'danger' : disaster.dataLost > 1 ? 'warn' : 'ok',
                      hint: 'Minutes of writes that no surviving copy holds.',
                      simulated: true,
                    },
                    {
                      key: 'rto',
                      label: recovered ? 'Time to recover (RTO)' : 'Down for',
                      value: recoverable ? formatMinutes(recovered ? totalMinutes(disaster.stages) : elapsed) : 'never',
                      tone: !recoverable ? 'danger' : recovered ? 'ok' : 'warn',
                      hint: 'From the disaster until users are served correctly again.',
                      simulated: true,
                    },
                    { key: 'step', label: 'Now', value: !recoverable ? 'Nothing to restore' : recovered ? 'Serving' : (stageNow?.label ?? '-') },
                  ]
                : [
                    { key: 'strategy', label: 'Strategy', value: strategyName(setup) },
                    {
                      key: 'risk',
                      label: 'Data at risk',
                      value: formatMinutes(riskNow),
                      tone: riskNow === null || riskNow > 60 ? 'danger' : riskNow > 1 ? 'warn' : 'ok',
                      hint: 'Writes that only region A holds right now - what a region loss would take with it.',
                      simulated: true,
                    },
                    {
                      key: 'rto',
                      label: 'Expected RTO',
                      value: expectedRto === null ? 'never' : formatMinutes(expectedRto),
                      tone: expectedRto === null || expectedRto > 120 ? 'danger' : expectedRto > 30 ? 'warn' : 'ok',
                      hint: 'Sum of the recovery steps for a region loss with this setup.',
                      simulated: true,
                    },
                    {
                      key: 'write',
                      label: 'Write latency',
                      value: `${writeMs} ms`,
                      tone: setup.replication === 'sync' ? 'warn' : 'neutral',
                      hint: `Synchronous replication waits for region B on every write: about ${SYNC_WRITE_PENALTY_MS} ms more.`,
                      simulated: true,
                    },
                    {
                      key: 'cost',
                      label: 'Relative cost',
                      value: relativeCost(setup),
                      unit: '/ 100',
                      hint: 'Region A alone costs 100. Illustrative ratios, not a price list.',
                      simulated: true,
                    },
                  ]
            }
          />

          {disaster && recoverable ? (
            <div className="card p-4">
              <p className="label mb-3">Recovery steps (simulated minutes)</p>
              <ol className="space-y-2">
                {disaster.stages.map((stage, index) => {
                  const before = totalMinutes(disaster.stages.slice(0, index));
                  const progress = Math.min(1, Math.max(0, (elapsed - before) / stage.minutes));
                  return (
                    <li key={stage.label} className="space-y-1">
                      <div className="flex items-baseline justify-between gap-2 text-xs">
                        <span className={cn(progress >= 1 ? 'text-ok' : progress > 0 ? 'text-ink' : 'text-faint')}>
                          {progress >= 1 ? 'Done: ' : progress > 0 ? 'Now: ' : ''}
                          {stage.label}
                        </span>
                        <span className="font-mono text-[11px] text-muted">{formatMinutes(stage.minutes)}</span>
                      </div>
                      <div className="h-1.5 overflow-hidden rounded-full bg-line" aria-hidden>
                        <div className="h-full rounded-full bg-brand" style={{ width: `${progress * 100}%` }} />
                      </div>
                    </li>
                  );
                })}
              </ol>
            </div>
          ) : null}

          <div className="card p-4">
            <p className="label mb-3">Runs so far</p>
            {results.length === 0 ? (
              <p className="text-xs text-faint">
                Strike once, rebuild, change one control and strike again. Each run lands here so you can compare setups.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[480px] text-left text-xs">
                  <thead className="text-faint">
                    <tr>
                      <th className="py-1 pr-3 font-medium">Disaster</th>
                      <th className="py-1 pr-3 font-medium">Strategy</th>
                      <th className="py-1 pr-3 font-medium">Backups</th>
                      <th className="py-1 pr-3 font-medium">Data lost</th>
                      <th className="py-1 font-medium">Time to recover</th>
                    </tr>
                  </thead>
                  <tbody className="font-mono text-[11px] text-muted">
                    {results.map((row) => (
                      <tr key={row.id} className="border-t border-line">
                        <td className="py-1.5 pr-3">{row.kind === 'region' ? 'Region lost' : 'Bad migration'}</td>
                        <td className="py-1.5 pr-3">{row.strategy}</td>
                        <td className="py-1.5 pr-3">{row.backup}</td>
                        <td className={cn('py-1.5 pr-3', row.dataLost === null || row.dataLost > 60 ? 'text-danger' : 'text-ink')}>
                          {formatMinutes(row.dataLost)}
                        </td>
                        <td className={cn('py-1.5', row.timeToRecover === null ? 'text-danger' : 'text-ink')}>
                          {row.timeToRecover === null ? 'never' : formatMinutes(row.timeToRecover)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="mt-3 text-xs text-faint">
              {SIMULATED_HINT} A restore takes {DURATION.restore / 60} h (a 500 GB database), a
              promotion {DURATION.promote} min, a deploy from code {DURATION.deployApp} min, a DNS switch{' '}
              {DURATION.dns} min, and an unrehearsed plan adds {DURATION.surprises} min of surprises. Your real numbers
              come from a restore drill.
            </p>
          </div>
        </>
      }
      controls={
        <>
          {locked ? (
            <p className="text-[11px] text-muted">
              The disaster uses the setup it struck with. Rebuild region A to change the setup.
            </p>
          ) : null}
          <Slider
            label="Backup every"
            value={setup.backupIndex}
            min={0}
            max={BACKUP_OPTIONS.length - 1}
            step={1}
            onChange={change('backupIndex')}
            format={(index) => backupLabel(BACKUP_OPTIONS[index])}
            scale={['5 min', '24 h']}
            disabled={locked}
            hint="With no replica, the backup interval is your worst-case data loss."
          />
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted">Backups stored in</p>
            <SegmentedControl
              size="sm"
              className="w-full"
              value={setup.backupWhere}
              options={[
                { value: 'same', label: 'Region A' },
                { value: 'other', label: 'Region B' },
              ]}
              onChange={(value) => !locked && change('backupWhere')(value)}
            />
          </div>
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted">Database replication to region B</p>
            <SegmentedControl
              size="sm"
              className="w-full"
              value={setup.replication}
              options={[
                { value: 'none', label: 'None' },
                { value: 'async', label: 'Async' },
                { value: 'sync', label: 'Sync' },
              ]}
              onChange={(value) => !locked && change('replication')(value)}
            />
            <p className="text-[11px] text-faint">Async trails by a few seconds. Sync loses nothing but slows every write.</p>
          </div>
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted">App servers in region B</p>
            <SegmentedControl
              size="sm"
              className="w-full"
              value={setup.standby}
              options={[
                { value: 'off', label: 'Off' },
                { value: 'warm', label: 'Warm' },
                { value: 'hot', label: 'Hot' },
              ]}
              onChange={(value) => !locked && change('standby')(value)}
            />
            <p className="text-[11px] text-faint">
              Off: deployed from code when needed. Warm: a small fleet running. Hot: full size, failover automated.
            </p>
          </div>
          <Toggle
            label="Runbook rehearsed"
            checked={setup.rehearsed}
            onChange={change('rehearsed')}
            disabled={locked}
            description="A restore drill has been run and the plan works."
          />
        </>
      }
    >
      <DiagramCanvas
        layout={layout}
        edges={edges}
        particles={particleViews}
        width={CANVAS_W}
        height={CANVAS_H}
        className="bg-canvas"
        underlay={<RegionZones lost={regionLost} />}
      >
        <ArchNode kind="client" title="Users" subtitle="orders, 24/7" placed={layout.users} compact />
        <ArchNode kind="dns" title="DNS" subtitle={serving === 'B' ? 'points at region B' : 'points at region A'} placed={layout.dns} compact />
        <ArchNode
          kind="server"
          title="App servers"
          subtitle="region A"
          placed={layout.appA}
          status={aStatus.status}
          statusLabel={aStatus.label}
          compact
        >
          <NodeStatRow label="Serving" value={serving === 'A' ? 'yes' : 'no'} tone={serving === 'A' ? 'text-ok' : 'text-danger'} />
        </ArchNode>
        <ArchNode
          kind="sql"
          title="Primary DB"
          subtitle="region A"
          placed={layout.dbA}
          status={aStatus.status}
          statusLabel={aStatus.label}
          alert={corrupted}
          compact
        >
          <NodeStatRow label="Last backup" value={`${formatMinutes(Math.max(0, (disaster?.at ?? sim.clock) - sim.lastBackupAt))} ago`} />
          <NodeStatRow label="Write" value={`${writeMs} ms`} tone={effective.replication === 'sync' ? 'text-warn' : 'text-ink'} />
        </ArchNode>
        <ArchNode
          kind="server"
          title="App servers"
          subtitle={`region B - ${effective.standby}`}
          placed={layout.appB}
          status={appBStatus.status}
          statusLabel={appBStatus.label}
          compact
        >
          <NodeStatRow label="Serving" value={serving === 'B' ? 'yes' : 'no'} tone={serving === 'B' ? 'text-ok' : 'text-faint'} />
        </ArchNode>
        <ArchNode
          kind="sql"
          title="Standby DB"
          subtitle="region B"
          placed={layout.dbB}
          status={dbBStatus.status}
          statusLabel={dbBStatus.label}
          compact
        >
          <NodeStatRow label="Behind by" value={dbBBuilt && !regionLost ? replicaLag : '-'} />
          <NodeStatRow label="Holds" value={effective.replication === 'none' && !(regionLost && recovered) ? 'nothing yet' : corrupted ? 'bad rows too' : 'all writes'} tone={corrupted ? 'text-warn' : 'text-ink'} />
        </ArchNode>
        <ArchNode
          kind="storage"
          title="Backups"
          subtitle={`every ${backupLabel(BACKUP_OPTIONS[effective.backupIndex])}, ${effective.backupWhere === 'same' ? 'region A' : 'region B'}`}
          placed={layout.backups}
          status={backupsLost ? 'down' : restoring ? 'starting' : 'healthy'}
          statusLabel={backupsLost ? 'Lost' : restoring ? 'Restoring' : undefined}
          compact
        />
      </DiagramCanvas>
    </LabShell>
  );

  function insightText() {
    if (!disaster) {
      if (setup.replication === 'none' && setup.backupWhere === 'same')
        return 'The backups sit in region A, next to the database they protect. Lose the region and you lose both - try it, then move the backups to region B.';
      if (setup.replication === 'none')
        return `Backups only: if region A died now you would lose ${formatMinutes(riskNow)} of writes, the time since the last backup, and wait about ${formatMinutes(expectedRto)} for a restore. Watch Data at risk climb and drop back to zero at each backup.`;
      if (setup.replication === 'async')
        return `An async replica trails by seconds, so a region loss costs seconds of data instead of the ${backupLabel(backupEvery)} backup interval. Now ship a bad migration: the replica copies the bad rows too, and only the backup can undo them.`;
      return `Sync replication means region B has every acknowledged write, so a region loss costs no data - but each write now waits about ${SYNC_WRITE_PENALTY_MS} ms for region B. Replication still copies a bad migration instantly; try it.`;
    }
    if (!recoverable)
      return 'Nothing survived: the only copies were in the region that burned. Keep at least one copy in another region and another account - this is the most common disaster recovery mistake.';
    if (disaster.kind === 'corruption')
      return disaster.setup.replication === 'none'
        ? `Every health check stayed green while bad data was served (triangles). The fix is a restore of the last good backup, and every write since it - ${formatMinutes(disaster.dataLost)} - is gone, including good writes made before anyone noticed.`
        : `The replica took the bad rows within seconds, so ${strategyName(disaster.setup)} does not help here: the standby is as broken as the primary. Only the backup from before the migration is clean, so recovery costs ${formatMinutes(disaster.dataLost)} of writes and a ${formatMinutes(DURATION.restore)} restore.`;
    if (!recovered)
      return `Region A is gone and requests fail (crosses) until DNS points at region B. The plan has ${disaster.stages.length} steps; the slowest one sets your RTO.`;
    return `${strategyName(disaster.setup)} recovered in ${formatMinutes(totalMinutes(disaster.stages))} and lost ${formatMinutes(disaster.dataLost)} of writes. Rebuild, change one control and compare the rows in Runs so far.`;
  }
}

function activeStage(stages: Stage[], elapsed: number): Stage | null {
  let start = 0;
  for (const stage of stages) {
    if (elapsed < start + stage.minutes) return stage;
    start += stage.minutes;
  }
  return null;
}

export default DisasterRecoveryLab;
