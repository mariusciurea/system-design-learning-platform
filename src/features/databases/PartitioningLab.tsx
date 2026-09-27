import { useReducer, useRef, useState } from 'react';
import { Eraser, Scissors } from 'lucide-react';
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
import { Button, Meter, SegmentedControl, Select, Slider } from '@/components/ui';
import { advanceParticles, nextParticleId, useEventLog, useTicker, visualShare, type Particle } from '@/simulations/engine';
import { computeLoad } from '@/simulations/models/load';
import { useRerender } from '@/hooks/useRerender';
import { sampleArrivals } from '@/utils/math';
import { formatLatency, formatPercent } from '@/utils/format';
import { useLabRunning } from '@/hooks/useLabRunning';

type Scheme = 'none' | 'range' | 'list' | 'hash';
type QueryId = 'recent' | 'august' | 'region' | 'tenant' | 'status';

interface Setup {
  scheme: Scheme;
  query: QueryId;
  qps: number;
}

/** What the lab opens on: range partitions by month, and a query that prunes to one of them. */
const DEFAULT_SETUP: Setup = { scheme: 'range', query: 'recent', qps: 3 };

const SCHEMES: { value: Scheme; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'range', label: 'Range' },
  { value: 'list', label: 'List' },
  { value: 'hash', label: 'Hash' },
];

/** The partition key each scheme uses in this lab. */
const KEY: Record<Scheme, string> = {
  none: 'nothing',
  range: 'RANGE (created_at), one partition a month',
  list: 'LIST (region)',
  hash: 'HASH (tenant_id), MODULUS 6',
};

const QUERIES: { value: QueryId; label: string; sql: string; column: string }[] = [
  { value: 'recent', label: 'Dashboard: last 7 days', sql: "WHERE created_at >= now() - interval '7 days'", column: 'created_at' },
  { value: 'august', label: 'Report: August', sql: "WHERE created_at >= '2026-08-01' AND created_at < '2026-09-01'", column: 'created_at' },
  { value: 'region', label: 'Report: region DE', sql: "WHERE region = 'DE'", column: 'region' },
  { value: 'tenant', label: 'Report: tenant 42', sql: 'WHERE tenant_id = 42', column: 'tenant_id' },
  { value: 'status', label: 'Report: failed events', sql: "WHERE status = 'failed'", column: 'status' },
];

interface Part {
  id: string;
  title: string;
  table: string;
  /** Fixed place on the canvas, so dropping a partition leaves its slot empty. */
  slot: number;
  /** Live rows, in millions. */
  live: number;
  /** Deleted rows still on disk, in millions: a DELETE leaves them until VACUUM FULL. */
  dead: number;
}

interface Month {
  id: string;
  label: string;
  rows: number;
}

interface DeleteJob {
  month: Month;
  /** Rows (millions) still to delete from each target partition. */
  remaining: Record<string, number>;
  done: number;
}

interface State {
  parts: Part[];
  /** Months of data still in the table, oldest first. */
  months: Month[];
  particles: Particle[];
  job: DeleteJob | null;
  /** Emits a DELETE particle every few frames. */
  jobEmit: number;
  /** Write-ahead log written by retention work, GB. */
  walGb: number;
  freedGb: number;
  timedOut: number;
  queries: number;
}

// Simplified numbers, not measurements. They keep the ratios the Lesson quotes.
/** 400 bytes a row: 1 million rows take 0.4 GB. */
const GB_PER_M_ROWS = 0.4;
/** About 100 bytes of write-ahead log for every deleted row: 0.1 GB per million. */
const WAL_GB_PER_M_ROWS = 0.1;
/** A bulk DELETE removes about 5 million rows an hour (20 million in about 4 hours). */
const DELETE_M_ROWS_PER_HOUR = 5;
/** One real second of the lab stands for one hour of the DELETE. */
const SIM_HOURS_PER_SECOND = 1;
/** Rows (millions) the machine can scan per second before queries queue. */
const SCAN_CAPACITY = 600;
/** Scan capacity the running DELETE takes away: finding, marking and logging each row. */
const DELETE_LOAD = 220;
/** Fixed planning cost of a query, plus a small cost for every partition it has to open. */
const PLAN_MS = 2;
const PER_PARTITION_MS = 3;
/** Scan time per million rows read, at no load. */
const MS_PER_M_ROWS = 1.6;

const MONTHS: Month[] = [
  { id: 'apr', label: 'April', rows: 30 },
  { id: 'may', label: 'May', rows: 30 },
  { id: 'jun', label: 'June', rows: 30 },
  { id: 'jul', label: 'July', rows: 30 },
  { id: 'aug', label: 'August', rows: 30 },
  { id: 'sep', label: 'September', rows: 18 },
];
const TOTAL_ROWS = MONTHS.reduce((sum, month) => sum + month.rows, 0);

const RANGE_TABLE: Record<string, string> = {
  apr: 'events_2026_04',
  may: 'events_2026_05',
  jun: 'events_2026_06',
  jul: 'events_2026_07',
  aug: 'events_2026_08',
  sep: 'events_2026_09',
};

/** Region shares of the rows for list partitioning. Skewed on purpose: regions are never even. */
const REGIONS: { id: string; title: string; share: number }[] = [
  { id: 'de', title: "Region 'DE'", share: 40 },
  { id: 'fr', title: "Region 'FR'", share: 20 },
  { id: 'us', title: "Region 'US'", share: 50 },
  { id: 'br', title: "Region 'BR'", share: 22 },
  { id: 'jp', title: "Region 'JP'", share: 16 },
  { id: 'rest', title: 'Other (DEFAULT)', share: 20 },
];

const REGION_TOTAL = REGIONS.reduce((sum, region) => sum + region.share, 0);

/** Tenant 42 hashes to remainder 2 in this lab. */
const TENANT_42_PARTITION = 'h2';

function createParts(scheme: Scheme): Part[] {
  if (scheme === 'none') return [{ id: 'events', title: 'events', table: 'one table, no partitions', slot: 0, live: TOTAL_ROWS, dead: 0 }];
  if (scheme === 'range')
    return MONTHS.map((month, slot) => ({
      id: month.id,
      title: `${month.label.slice(0, 3)} 2026`,
      table: RANGE_TABLE[month.id],
      slot,
      live: month.rows,
      dead: 0,
    }));
  if (scheme === 'list')
    return REGIONS.map((region, slot) => ({
      id: region.id,
      title: region.title,
      table: `events_${region.id === 'rest' ? 'default' : region.id}`,
      slot,
      live: (TOTAL_ROWS * region.share) / REGION_TOTAL,
      dead: 0,
    }));
  return Array.from({ length: 6 }, (_, slot) => ({
    id: `h${slot}`,
    title: `Hash remainder ${slot}`,
    table: `events_h${slot}`,
    slot,
    live: TOTAL_ROWS / 6,
    dead: 0,
  }));
}

const createState = (scheme: Scheme): State => ({
  parts: createParts(scheme),
  months: MONTHS.map((month) => ({ ...month })),
  particles: [],
  job: null,
  jobEmit: 0,
  walGb: 0,
  freedGb: 0,
  timedOut: 0,
  queries: 0,
});

/** The partitions a query must read. Everything else is pruned by the planner. */
function partitionsRead(scheme: Scheme, query: QueryId, parts: Part[]): Part[] {
  let only: string | null = null;
  if (scheme === 'range' && query === 'recent') only = 'sep';
  if (scheme === 'range' && query === 'august') only = 'aug';
  if (scheme === 'list' && query === 'region') only = 'de';
  if (scheme === 'hash' && query === 'tenant') only = TENANT_42_PARTITION;
  return only ? parts.filter((part) => part.id === only) : parts;
}

/** Two columns of three partition slots, left and right of the planner. */
const SLOTS = [0, 1, 2, 3, 4, 5].map((slot) => ({
  x: slot < 3 ? 30 : 690,
  y: 118 + (slot % 3) * 124,
  w: 240,
  h: 116,
}));

const BASE_LAYOUT: Layout = {
  app: { x: 390, y: 10, w: 180, h: 73 },
  planner: { x: 360, y: 236, w: 240, h: 128 },
};

const PARTICLE_BUDGET = 90;

export function PartitioningLab() {
  const [setup, setSetup] = useState<Setup>(DEFAULT_SETUP);
  const { scheme, query, qps } = setup;
  const [running, setRunning] = useLabRunning();
  const state = useRef<State>(createState(DEFAULT_SETUP.scheme));
  const rerender = useRerender(30);
  // Button actions must repaint even when the throttled rerender skips a frame.
  const [, bump] = useReducer((value: number) => value + 1, 0);
  const { events, log, clear } = useEventLog();

  const current = state.current;
  const read = partitionsRead(scheme, query, current.parts);
  const readIds = new Set(read.map((part) => part.id));
  const rowsRead = read.reduce((sum, part) => sum + part.live + part.dead, 0);
  const baseLatency = PLAN_MS + PER_PARTITION_MS * read.length + MS_PER_M_ROWS * rowsRead;
  const load = computeLoad(qps * rowsRead + (current.job ? DELETE_LOAD : 0), SCAN_CAPACITY, {
    baseLatencyMs: baseLatency,
    kneeAt: 0.7,
    maxLatencyMs: 8000,
  });

  useTicker(running, (dt) => {
    const sim = state.current;
    const arrivals = sampleArrivals(qps, dt);
    const share = visualShare(qps, 5);
    for (let index = 0; index < arrivals; index += 1) {
      sim.queries += 1;
      const failed = Math.random() < load.errorRate;
      if (failed) sim.timedOut += 1;
      if (Math.random() >= share) continue;
      for (const part of read) {
        sim.particles.push({
          id: nextParticleId(),
          route: ['app', 'planner', part.id],
          leg: 0,
          t: 0,
          speed: 1.4 + Math.random() * 0.3,
          outcome: failed ? 'failure' : 'success',
        });
      }
    }

    const job = sim.job;
    if (job) {
      const total = Object.values(job.remaining).reduce((sum, rows) => sum + rows, 0);
      const step = Math.min(total, DELETE_M_ROWS_PER_HOUR * SIM_HOURS_PER_SECOND * dt);
      for (const part of sim.parts) {
        const left = job.remaining[part.id];
        if (!left) continue;
        const moved = Math.min(left, (step * left) / total);
        part.live = Math.max(0, part.live - moved);
        part.dead += moved;
        job.remaining[part.id] = left - moved;
      }
      job.done += step;
      sim.walGb += step * WAL_GB_PER_M_ROWS;
      sim.jobEmit += dt;
      const targets = Object.keys(job.remaining).filter((id) => job.remaining[id] > 0.001);
      if (sim.jobEmit > 0.18 && targets.length) {
        sim.jobEmit = 0;
        sim.particles.push({
          id: nextParticleId(),
          route: ['app', 'planner', targets[Math.floor(Math.random() * targets.length)]],
          leg: 0,
          t: 0,
          speed: 1.2,
          outcome: 'warning',
        });
      }
      if (total - step <= 0.001) {
        sim.job = null;
        sim.months = sim.months.filter((month) => month.id !== job.month.id);
        const hours = job.month.rows / DELETE_M_ROWS_PER_HOUR;
        log(
          `DELETE of ${job.month.label} finished after about ${hours.toFixed(0)} h: ${job.month.rows}M rows gone, ${(
            job.month.rows * WAL_GB_PER_M_ROWS
          ).toFixed(1)} GB of WAL written, and the ${(job.month.rows * GB_PER_M_ROWS).toFixed(0)} GB stays on disk as dead space`,
          'warn',
        );
      }
    }

    const { alive } = advanceParticles(sim.particles, dt);
    sim.particles = alive.length > PARTICLE_BUDGET ? alive.slice(-PARTICLE_BUDGET) : alive;
    rerender();
  });

  const reset = () => {
    setSetup(DEFAULT_SETUP);
    state.current = createState(DEFAULT_SETUP.scheme);
    clear();
    bump();
  };

  const changeScheme = (next: Scheme) => {
    setSetup((value) => ({ ...value, scheme: next }));
    state.current = createState(next);
    log(next === 'none' ? 'events is one table again - nothing to prune' : `events re-created, partitioned by ${KEY[next]}`, 'info');
  };

  const oldestMonth = current.months[0];
  const oldestPart = scheme === 'range' ? current.parts[0] : undefined;
  const canDrop = Boolean(oldestPart) && current.parts.length > 2 && !current.job;
  const canDelete = current.months.length > 2 && !current.job && Boolean(oldestMonth);

  const dropOldest = () => {
    const sim = state.current;
    const part = sim.parts[0];
    if (!part || sim.job) return;
    const gb = (part.live + part.dead) * GB_PER_M_ROWS;
    sim.parts = sim.parts.slice(1);
    sim.months = sim.months.filter((month) => month.id !== part.id);
    sim.freedGb += gb;
    sim.particles = sim.particles.filter((particle) => !particle.route.includes(part.id));
    log(
      `DROP TABLE ${part.table}: a few ms, ${Math.round(part.live)}M live rows gone and ${gb.toFixed(0)} GB back to the disk at once`,
      'ok',
    );
    bump();
  };

  const deleteOldest = () => {
    const sim = state.current;
    const month = sim.months[0];
    if (!month || sim.job) return;
    // Range: the DELETE is pruned to the partition that holds the month. Otherwise
    // the rows of that month are spread over every partition (or the one table).
    const targets = scheme === 'range' ? sim.parts.filter((part) => part.id === month.id) : sim.parts;
    const liveTotal = targets.reduce((sum, part) => sum + part.live, 0);
    const remaining: Record<string, number> = {};
    for (const part of targets) remaining[part.id] = liveTotal ? (month.rows * part.live) / liveTotal : 0;
    sim.job = { month, remaining, done: 0 };
    log(
      `DELETE FROM events WHERE created_at < ${month.label} end: ${month.rows}M rows, about ${(
        month.rows / DELETE_M_ROWS_PER_HOUR
      ).toFixed(0)} h of work (compressed to seconds here)`,
      'warn',
    );
    bump();
  };

  // Layout: the partition nodes that still exist, in their fixed slots.
  const layout: Layout = { ...BASE_LAYOUT };
  if (scheme === 'none') layout.events = { x: 660, y: 242, w: 270, h: 116 };
  else for (const part of current.parts) layout[part.id] = SLOTS[part.slot];

  const jobTargets = current.job ? new Set(Object.keys(current.job.remaining)) : new Set<string>();
  const edges: DiagramEdge[] = [
    { from: 'app', to: 'planner', tone: 'brand', width: 2 },
    ...current.parts.map<DiagramEdge>((part) => {
      const scanned = readIds.has(part.id);
      if (jobTargets.has(part.id)) return { from: 'planner', to: part.id, tone: 'warn', width: 2 };
      return scanned
        ? { from: 'planner', to: part.id, tone: load.saturated ? 'danger' : 'ok', width: 2 }
        : { from: 'planner', to: part.id, tone: 'muted', dashed: true };
    }),
  ];

  const particles: ParticleView[] = current.particles
    .filter((particle) => layout[particle.route[particle.route.length - 1]])
    .map((particle) => ({
      id: particle.id,
      from: particle.route[particle.leg],
      to: particle.route[particle.leg + 1],
      t: particle.t,
      outcome: particle.outcome ?? 'success',
    }));

  const diskGb = current.parts.reduce((sum, part) => sum + (part.live + part.dead) * GB_PER_M_ROWS, 0);
  const deadGb = current.parts.reduce((sum, part) => sum + part.dead * GB_PER_M_ROWS, 0);
  const selected = QUERIES.find((item) => item.value === query) ?? QUERIES[0];
  const pruned = scheme !== 'none' && read.length < current.parts.length;
  const timeoutShare = current.queries ? current.timedOut / current.queries : 0;

  const insight = (() => {
    if (current.job)
      return (
        <>
          The DELETE walks {scheme === 'range' ? 'one partition' : scheme === 'none' ? 'the whole table' : 'every partition'}{' '}
          row by row, writes WAL for each row and competes with the queries for the machine - watch the load rise. When it
          ends the rows are gone but the space stays on disk as dead rows, which every scan still reads past.
        </>
      );
    if (scheme === 'none')
      return (
        <>
          One table of {TOTAL_ROWS}M rows: every query reads all of it under this model, whatever it filters on. Switch to
          Range and run the dashboard query to see the planner skip five of the six partitions.
        </>
      );
    if (pruned)
      return (
        <>
          The query filters on {selected.column}, the partition key, so the planner prunes {current.parts.length - read.length}{' '}
          of {current.parts.length} partitions (dashed wires) and reads {Math.round(rowsRead)}M rows instead of{' '}
          {Math.round(current.parts.reduce((sum, part) => sum + part.live + part.dead, 0))}M. Now pick a query on another
          column and watch every wire light up.
        </>
      );
    return (
      <>
        This query filters on {selected.column}, but the table is partitioned by {KEY[scheme]}. The planner cannot rule
        any partition out, so it opens all {current.parts.length} - a little slower than one plain table, because every
        partition adds its own planning cost. Pruning needs the partition key in the WHERE clause.
      </>
    );
  })();

  return (
    <LabShell
      title="Partitioning Lab"
      description="One database, one events table split into partitions. Run queries and watch the planner prune, then remove an old month with DROP or with DELETE."
      running={running}
      onRunningChange={setRunning}
      onReset={reset}
      legend={
        <ParticleLegend
          outcomes={[
            { outcome: 'success', label: 'Query' },
            { outcome: 'warning', label: 'DELETE batch' },
            { outcome: 'failure', label: 'Query timed out' },
          ]}
        />
      }
      events={events}
      insight={<Insight>{insight}</Insight>}
      metrics={
        <MetricsPanel
          items={[
            {
              key: 'partitions',
              label: 'Partitions read',
              value: `${read.length} / ${current.parts.length}`,
              tone: pruned ? 'ok' : scheme === 'none' ? 'neutral' : 'warn',
              hint: 'Partitions the planner could not prune for this query.',
            },
            {
              key: 'rows',
              label: 'Rows read per query',
              value: `${Math.round(rowsRead)}M`,
              tone: rowsRead > 60 ? 'warn' : 'ok',
              hint: 'Live and dead rows in the partitions read. Every query here is a report that scans what it cannot prune.',
              simulated: true,
            },
            {
              key: 'latency',
              label: 'Query latency',
              value: formatLatency(load.latencyMs),
              tone: load.latencyMs > 1000 ? 'danger' : load.latencyMs > 300 ? 'warn' : 'ok',
              hint: `${PLAN_MS} ms to plan, ${PER_PARTITION_MS} ms per partition opened, ${MS_PER_M_ROWS} ms per million rows, then queueing.`,
              simulated: true,
            },
            {
              key: 'load',
              label: 'Database load',
              value: formatPercent(Math.min(load.utilization, 9.99), 0),
              tone: load.saturated ? 'danger' : load.utilization > 0.7 ? 'warn' : 'ok',
              hint: `Rows scanned per second against about ${SCAN_CAPACITY}M a second, plus the running DELETE.`,
              simulated: true,
            },
            {
              key: 'disk',
              label: 'Disk used',
              value: `${diskGb.toFixed(0)} GB`,
              sub: deadGb > 0.5 ? `${deadGb.toFixed(0)} GB dead` : undefined,
              tone: deadGb > 0.5 ? 'warn' : 'neutral',
              hint: `About ${GB_PER_M_ROWS} GB per million rows. Deleted rows keep their space until VACUUM FULL rewrites the table.`,
              simulated: true,
            },
            {
              key: 'wal',
              label: 'WAL from retention',
              value: `${current.walGb.toFixed(1)} GB`,
              tone: current.walGb > 1 ? 'warn' : 'neutral',
              hint: 'Write-ahead log written to remove old data. Replicas must replay all of it.',
              simulated: true,
            },
          ]}
        />
      }
      controls={
        <>
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted">Partition events by</p>
            <SegmentedControl value={scheme} options={SCHEMES} onChange={changeScheme} size="sm" />
            <p className="text-[11px] text-faint">{scheme === 'none' ? 'One plain table.' : `PARTITION BY ${KEY[scheme]}`}</p>
          </div>
          <Select
            label="Query"
            value={query}
            options={QUERIES.map(({ value, label }) => ({ value, label }))}
            onChange={(value) => {
              setSetup((current) => ({ ...current, query: value }));
              state.current.particles = [];
            }}
            hint="Pruning happens only when the query filters on the partition key."
          />
          <p className="rounded-lg border border-line bg-elevated px-2.5 py-2 font-mono text-[11px] text-muted">
            SELECT ... FROM events {selected.sql}
          </p>
          <Slider
            label="Queries per second"
            value={qps}
            min={1}
            max={10}
            step={1}
            onChange={(value) => setSetup((current) => ({ ...current, qps: value }))}
            format={(value) => `${value} q/s`}
          />
          <div className="space-y-2 border-t border-line pt-4">
            <p className="label">Retention: remove the oldest month</p>
            <Button className="w-full" variant="primary" size="sm" disabled={!canDrop} onClick={dropOldest}>
              <Scissors className="h-3.5 w-3.5" />
              {oldestPart ? `DROP TABLE ${oldestPart.table}` : 'DROP needs range partitions'}
            </Button>
            <Button className="w-full" size="sm" disabled={!canDelete} onClick={deleteOldest}>
              <Eraser className="h-3.5 w-3.5" />
              {oldestMonth ? `DELETE the ${oldestMonth.label} rows` : 'Nothing old left'}
            </Button>
            {current.job ? (
              <Meter
                label={`DELETE ${current.job.month.label}: ${(current.job.done / DELETE_M_ROWS_PER_HOUR).toFixed(1)} h of ~${(
                  current.job.month.rows / DELETE_M_ROWS_PER_HOUR
                ).toFixed(0)} h`}
                value={current.job.done / current.job.month.rows}
                size="xs"
              />
            ) : null}
            <p className="text-[11px] text-faint">
              {scheme === 'range'
                ? 'Each month is its own partition, so it can be dropped whole. DROP takes milliseconds; DELETE takes hours.'
                : 'Only range partitions by time hold one month in one piece. Here the old rows are spread everywhere, so DELETE is the only way.'}{' '}
              Simplified: one lab second stands for one hour of DELETE.
            </p>
          </div>
          {current.freedGb > 0 ? (
            <p className="text-[11px] text-ok">DROP has freed {current.freedGb.toFixed(0)} GB so far, with no WAL flood.</p>
          ) : null}
          {timeoutShare > 0.01 ? (
            <p className="text-[11px] text-danger">{formatPercent(timeoutShare, 0)} of queries have timed out so far.</p>
          ) : null}
        </>
      }
    >
      <DiagramCanvas
        layout={layout}
        edges={edges}
        particles={particles}
        height={502}
        className="bg-canvas"
        underlay={
          <g>
            <rect
              x={14}
              y={88}
              width={932}
              height={404}
              rx={16}
              fill="none"
              strokeDasharray="6 5"
              strokeWidth={1.5}
              className="stroke-line"
            />
            <text x={30} y={108} className="fill-faint font-mono" style={{ fontSize: 11 }}>
              One PostgreSQL instance on one machine - events is one logical table
            </text>
          </g>
        }
      >
        <ArchNode kind="server" title="App server" subtitle={`${qps} queries/sec`} placed={layout.app} compact />
        <ArchNode
          kind="sql"
          title="Query planner"
          subtitle={scheme === 'none' ? 'events, not partitioned' : `events by ${scheme}`}
          placed={layout.planner}
          alert={load.saturated}
          status={load.saturated ? 'degraded' : 'healthy'}
          statusLabel={load.saturated ? 'Overloaded' : undefined}
        >
          <NodeStatRow label="Partitions read" value={`${read.length} / ${current.parts.length}`} tone={pruned ? 'text-ok' : 'text-ink'} />
          <NodeStatRow label="Latency" value={formatLatency(load.latencyMs)} />
        </ArchNode>
        {current.parts.map((part) => {
          const scanned = readIds.has(part.id);
          const deleting = jobTargets.has(part.id);
          return (
            <ArchNode
              key={part.id}
              kind="storage"
              title={part.title}
              subtitle={part.table}
              placed={layout[part.id]}
              status={deleting ? 'degraded' : 'healthy'}
              statusLabel={deleting ? 'DELETE running' : scanned ? 'Read by the query' : 'Pruned - not read'}
              className={scanned || deleting ? undefined : 'opacity-60'}
              compact
            >
              <NodeStatRow label="Live rows" value={`${part.live.toFixed(part.live < 10 ? 1 : 0)}M`} />
              <NodeStatRow
                label="On disk"
                value={`${((part.live + part.dead) * GB_PER_M_ROWS).toFixed(1)} GB`}
                tone={part.dead > 0.5 ? 'text-warn' : 'text-ink'}
              />
            </ArchNode>
          );
        })}
      </DiagramCanvas>
    </LabShell>
  );
}

export default PartitioningLab;
