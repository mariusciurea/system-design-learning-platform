import { useMemo, useRef, type ReactNode } from 'react';
import { DatabaseZap } from 'lucide-react';
import {
  ArchNode,
  DiagramCanvas,
  NodeStatRow,
  ParticleLegend,
  type DiagramEdge,
  type Layout,
  type ParticleView,
} from '@/components/architecture';
import { Insight, LabShell, SIMULATED_HINT } from '@/components/learning';
import { Button, InfoTip, SegmentedControl, Slider, Toggle } from '@/components/ui';
import { advanceParticles, nextParticleId, useEventLog, useTicker, type Particle } from '@/simulations/engine';
import { useLabSetup } from '@/hooks/useLabSetup';
import { useRerender } from '@/hooks/useRerender';
import { cn } from '@/utils/cn';
import { formatCompact, formatLatency, formatNumber, formatPercent, formatSeconds } from '@/utils/format';
import type { LabFocus, LabProps, RequestOutcome } from '@/types';
import {
  CRASH_RATE,
  MAX_PARTITIONS,
  ORDER_SIZES,
  ORDER_WRITES_PER_SEC,
  PARTITION_CAPACITY,
  SQL_CHECKOUT_CAPACITY,
  SQL_KEY_CAPACITY,
  evaluateCheckout,
  evaluateKey,
  evaluateReport,
  evaluateSchema,
  type Setup,
  type View,
  type Workload,
} from './dataModelsModel';
import { useLabRunning } from '@/hooks/useLabRunning';

const WORKLOADS: { value: Workload; label: string; blurb: string }[] = [
  { value: 'key', label: 'Key get/put at scale', blurb: 'Read or write one cart by its user id.' },
  { value: 'checkout', label: 'Checkout transaction', blurb: 'Join the cart with prices, reserve stock, insert the order.' },
  { value: 'report', label: 'Join-heavy report', blurb: 'Revenue per product category, last 30 days.' },
  { value: 'schema', label: 'Schema change', blurb: 'Widen orders.total_cents from integer to bigint.' },
];

const VIEWS: { value: View; label: string }[] = [
  { value: 'relational', label: 'Relational' },
  { value: 'both', label: 'Both' },
  { value: 'document', label: 'Document' },
];

/** What the lab opens on at /labs/data-models, with no Lab focus. */
const DEFAULT_SETUP: Setup = {
  view: 'both',
  workload: 'key',
  keyOps: 30_000,
  checkouts: 1_000,
  sizeIndex: 1,
  partitions: 3,
  hotKey: false,
  crashRate: CRASH_RATE,
  docTransactions: false,
  onlineMigration: false,
};

/**
 * The Lab focus of each Concept that hosts this lab. SQL Databases opens on the
 * relational side running a checkout - a join and a transaction in one; NoSQL
 * Databases opens on the document side with key traffic one primary could not
 * take; Relational vs Non-Relational opens on both sides with that same key
 * traffic, so switching the workload to the report flips which side struggles.
 */
const FOCUS_SETUPS: Record<LabFocus<'data-models'>, Setup> = {
  'sql-databases': { ...DEFAULT_SETUP, view: 'relational', workload: 'checkout', crashRate: 0.05 },
  'nosql-databases': { ...DEFAULT_SETUP, view: 'document', workload: 'key', keyOps: 120_000, partitions: 4 },
  'relational-vs-non-relational': { ...DEFAULT_SETUP, view: 'both', workload: 'key', keyOps: 80_000, partitions: 3 },
};

const TABLES = [
  { id: 'carts', title: 'carts' },
  { id: 'products', title: 'products' },
  { id: 'orders', title: 'orders' },
] as const;

const CANVAS_HEIGHT = 450;
/** A migration plays in this many real seconds, whatever its simulated length. */
const DEMO_SECONDS = 8;
const partitionId = (index: number) => `p${index}`;

/**
 * Node boxes for the view. Both stores side by side share the 960px canvas; a
 * single store moves to the middle.
 */
function buildLayout(view: View, partitions: number): Layout {
  const layout: Layout = { app: { x: 390, y: 16, w: 180, h: 74 } };
  const sqlShift = view === 'relational' ? 245 : 0;
  const docShift = view === 'document' ? -245 : 0;
  if (view !== 'document') {
    layout.pg = { x: 135 + sqlShift, y: 150, w: 200, h: 116 };
    TABLES.forEach((table, index) => {
      layout[table.id] = { x: 25 + index * 150 + sqlShift, y: 320, w: 120, h: 74 };
    });
  }
  if (view !== 'relational') {
    for (let index = 0; index < partitions; index += 1) {
      layout[partitionId(index)] = {
        x: 496 + (index % 3) * 154 + docShift,
        y: 150 + Math.floor(index / 3) * 140,
        w: 146,
        h: 116,
      };
    }
  }
  return layout;
}

interface SimState {
  particles: Particle[];
  /** Fractional particles owed to each side, so low visual rates still emit. */
  owed: { sql: number; doc: number };
  /** Progress 0..1 of a running migration, or null. */
  migration: number | null;
  /** The document store has seen the new shape, so old and new orders now differ. */
  docTwoShapes: boolean;
  partialOrders: number;
  rolledBackSql: number;
  rolledBackDoc: number;
  overloaded: { sql: boolean; doc: boolean };
}

const createState = (): SimState => ({
  particles: [],
  owed: { sql: 0, doc: 0 },
  migration: null,
  docTwoShapes: false,
  partialOrders: 0,
  rolledBackSql: 0,
  rolledBackDoc: 0,
  overloaded: { sql: false, doc: false },
});

/** Picks a partition index by share of traffic. */
function pickPartition(shares: number[]) {
  let roll = Math.random();
  for (let index = 0; index < shares.length; index += 1) {
    roll -= shares[index];
    if (roll <= 0) return index;
  }
  return shares.length - 1;
}

const randomPartition = (count: number) => Math.floor(Math.random() * count);

/**
 * The same shop data - carts, products, orders - in one PostgreSQL primary and in
 * a document store split over partitions, under four workloads. Each workload is
 * what one side makes easy and the other side makes hard.
 */
export function DataModelsLab({ focus }: LabProps<'data-models'>) {
  // The page keys this lab by Concept, so the focus never changes under a mounted lab.
  const start = focus ? FOCUS_SETUPS[focus] : DEFAULT_SETUP;
  // Every control lives in one object, so Reset cannot miss one.
  const { setup, setSetup, change } = useLabSetup(start);
  const { view, workload, keyOps, checkouts, sizeIndex, partitions, hotKey, crashRate, docTransactions, onlineMigration } =
    setup;
  const [running, setRunning] = useLabRunning();
  const state = useRef<SimState>(createState());
  const rerender = useRerender(30);
  const { events, log, clear } = useEventLog();

  const showSql = view !== 'document';
  const showDoc = view !== 'relational';

  const key = useMemo(() => evaluateKey(setup), [setup]);
  const checkout = useMemo(() => evaluateCheckout(setup), [setup]);
  const report = useMemo(() => evaluateReport(setup), [setup]);
  const schema = useMemo(() => evaluateSchema(setup), [setup]);
  const layout = useMemo(() => buildLayout(view, partitions), [view, partitions]);

  const chooseWorkload = (next: Workload) => {
    if (next === workload) return;
    const sim = state.current;
    sim.particles = [];
    sim.migration = null;
    sim.partialOrders = 0;
    sim.rolledBackSql = 0;
    sim.rolledBackDoc = 0;
    sim.overloaded = { sql: false, doc: false };
    change('workload')(next);
    log(`Workload: ${WORKLOADS.find((item) => item.value === next)?.label}`, 'info');
  };

  const reset = () => {
    // Back to this Concept's starting setup, not the lab's global default.
    setSetup(start);
    state.current = createState();
    clear();
  };

  const runMigration = () => {
    if (state.current.migration !== null) return;
    state.current.migration = 0;
    setRunning(true);
    if (showSql) {
      log(
        onlineMigration
          ? `PostgreSQL: add column, backfill ${formatCompact(schema.orders)} rows in small batches, then switch`
          : `PostgreSQL: ALTER TABLE orders ALTER COLUMN total_cents TYPE bigint - rewriting ${formatCompact(schema.orders)} rows under an ACCESS EXCLUSIVE lock`,
        onlineMigration ? 'info' : 'warn',
      );
    }
    if (showDoc) {
      state.current.docTwoShapes = true;
      log('Document store: nothing to run. New orders carry the bigint field; old ones keep the integer.', 'info');
    }
  };

  useTicker(running, (dt) => {
    const sim = state.current;
    const spawn = (route: string[], outcome: RequestOutcome, speed = 1.6, delay = 0) => {
      sim.particles.push({ id: nextParticleId(), route, leg: 0, t: -delay, speed, outcome });
    };
    const owed = (side: 'sql' | 'doc', perSecond: number) => {
      sim.owed[side] += perSecond * dt;
      const whole = Math.floor(sim.owed[side]);
      sim.owed[side] -= whole;
      return whole;
    };

    if (workload === 'key') {
      if (showSql) {
        for (let index = owed('sql', 9); index > 0; index -= 1) {
          const failed = Math.random() < key.sql.errorRate;
          spawn(
            failed ? ['app', 'pg'] : ['app', 'pg', 'carts'],
            failed ? 'failure' : key.sql.utilization > 0.85 ? 'warning' : 'success',
          );
        }
      }
      if (showDoc) {
        for (let index = owed('doc', 9); index > 0; index -= 1) {
          const target = pickPartition(key.shares);
          const load = key.partitions[target];
          const failed = Math.random() < load.errorRate;
          spawn(['app', partitionId(target)], failed ? 'failure' : load.utilization > 0.85 ? 'warning' : 'success');
        }
      }
      trackOverload(key.sql.saturated, key.doc.busiest >= 1);
    } else if (workload === 'checkout') {
      if (showSql) {
        for (let index = owed('sql', 2.4); index > 0; index -= 1) {
          if (Math.random() < checkout.sql.errorRate) spawn(['app', 'pg'], 'failure');
          else if (Math.random() < crashRate) {
            // The step after the stock update fails: the transaction rolls back as a whole,
            // and the customer can simply retry.
            spawn(['app', 'pg', 'carts', 'pg', 'products'], 'warning', 2.4);
          } else spawn(['app', 'pg', 'carts', 'pg', 'products', 'pg', 'orders', 'pg', 'app'], 'success', 2.4);
        }
      }
      if (showDoc) {
        for (let index = owed('doc', 2.4); index > 0; index -= 1) {
          const cart = partitionId(randomPartition(partitions));
          const product = partitionId(randomPartition(partitions));
          const order = partitionId(randomPartition(partitions));
          if (Math.random() < checkout.doc.errorRate) spawn(['app', cart], 'failure');
          else if (Math.random() < crashRate) {
            // Without a transaction the stock write already happened and stays; with one, it is undone.
            spawn(['app', cart, 'app', product], docTransactions ? 'warning' : 'failure', 2.4);
          } else spawn(['app', cart, 'app', product, 'app', order, 'app'], 'success', 2.4);
        }
      }
      // Only a store on screen runs checkouts, so a hidden side counts nothing
      // and does not come back with a total it was never seen building.
      const done = checkouts * dt * crashRate;
      if (showSql) sim.rolledBackSql += done * (1 - checkout.sql.errorRate);
      if (showDoc && docTransactions) sim.rolledBackDoc += done * (1 - checkout.doc.errorRate);
      else if (showDoc) {
        const before = Math.floor(sim.partialOrders / 100);
        sim.partialOrders += done * (1 - checkout.doc.errorRate);
        if (Math.floor(sim.partialOrders / 100) > before)
          log(`${formatNumber(sim.partialOrders)} half-done checkouts: stock reserved, no order written`, 'danger');
      }
      trackOverload(checkout.sql.saturated, checkout.doc.busiest >= 1);
    } else if (workload === 'report') {
      if (showSql && owed('sql', 0.7) > 0) {
        // One query: the database joins orders with products and returns 20 rows.
        spawn(['app', 'pg', 'orders', 'pg', 'products', 'pg', 'app'], 'success', 2.2);
      }
      if (showDoc && owed('doc', 0.7) > 0) {
        // Scatter to every partition, gather every matching order back, then look up products.
        for (let index = 0; index < partitions; index += 1) {
          for (let wave = 0; wave < 3; wave += 1) spawn(['app', partitionId(index), 'app'], 'success', 1.6, wave * 0.35);
        }
        for (let lookup = 0; lookup < 2; lookup += 1)
          spawn(['app', partitionId(randomPartition(partitions)), 'app'], 'warning', 1.6, 1.4 + lookup * 0.3);
      }
    } else {
      const migrating = sim.migration !== null;
      if (showSql) {
        for (let index = owed('sql', 4); index > 0; index -= 1) {
          // A blocking ALTER holds an ACCESS EXCLUSIVE lock: order writes wait at the database.
          if (migrating && !onlineMigration) spawn(['app', 'pg'], 'warning', 0.8);
          else spawn(['app', 'pg', 'orders'], 'success');
        }
        if (migrating && Math.random() < dt * (onlineMigration ? 3 : 6))
          spawn(['pg', 'orders'], onlineMigration ? 'success' : 'warning', 1.2);
      }
      if (showDoc) {
        for (let index = owed('doc', 4); index > 0; index -= 1) spawn(['app', partitionId(randomPartition(partitions))], 'success');
      }
      if (sim.migration !== null) {
        sim.migration += dt / DEMO_SECONDS;
        if (sim.migration >= 1) {
          sim.migration = null;
          if (showSql)
            log(
              onlineMigration
                ? `PostgreSQL: backfill done and switched after ${formatSeconds(schema.sqlSeconds)}; no write waited`
                : `PostgreSQL: rewrite done after ${formatSeconds(schema.sqlSeconds)}; about ${formatNumber(schema.sqlBlockedWrites)} order writes waited on the lock`,
              onlineMigration ? 'ok' : 'danger',
            );
        }
      }
    }

    const { alive } = advanceParticles(sim.particles, dt);
    sim.particles = alive.slice(-140);
    rerender();

    function trackOverload(sqlOver: boolean, docOver: boolean) {
      if (showSql && sqlOver !== sim.overloaded.sql) {
        sim.overloaded.sql = sqlOver;
        log(sqlOver ? 'PostgreSQL primary over capacity - requests failing' : 'PostgreSQL primary back under capacity', sqlOver ? 'danger' : 'ok');
      }
      if (showDoc && docOver !== sim.overloaded.doc) {
        sim.overloaded.doc = docOver;
        log(docOver ? 'A document-store partition is over capacity - its keys fail' : 'Every partition back under capacity', docOver ? 'danger' : 'ok');
      }
    }
  });

  const sim = state.current;
  const migrating = sim.migration !== null;
  const locked = migrating && !onlineMigration && workload === 'schema';

  // Recomputed on every render: the ticker re-renders at a capped frame rate.
  const particleViews: ParticleView[] = sim.particles
    .filter((particle) => particle.route.every((id) => layout[id]))
    .map((particle) => ({
      id: particle.id,
      from: particle.route[particle.leg],
      to: particle.route[particle.leg + 1],
      t: particle.t,
      outcome: particle.outcome ?? 'success',
    }));

  const edges = useMemo<DiagramEdge[]>(() => {
    const list: DiagramEdge[] = [];
    if (showSql) {
      list.push({ from: 'app', to: 'pg', tone: 'brand', width: 2 });
      for (const table of TABLES) list.push({ from: 'pg', to: table.id, tone: 'default' });
    }
    if (showDoc) {
      for (let index = 0; index < partitions; index += 1) list.push({ from: 'app', to: partitionId(index), tone: 'brand' });
    }
    return list;
  }, [showSql, showDoc, partitions]);

  const sqlNodeStats = (): ReactNode => {
    if (workload === 'key') return <LoadRows utilization={key.sql.utilization} latencyMs={key.sql.latencyMs} />;
    if (workload === 'checkout') return <LoadRows utilization={checkout.sql.utilization} latencyMs={checkout.sql.latencyMs} />;
    if (workload === 'report')
      return (
        <>
          <NodeStatRow label="Rows joined" value={formatCompact(report.matched)} />
          <NodeStatRow label="Rows returned" value={formatNumber(report.sqlRowsShipped)} tone="text-ok" />
        </>
      );
    return (
      <>
        <NodeStatRow label="Lock on orders" value={locked ? 'exclusive' : 'none'} tone={locked ? 'text-danger' : 'text-ok'} />
        <NodeStatRow label="Migration" value={migrating ? formatPercent(sim.migration ?? 0) : 'idle'} />
      </>
    );
  };

  const partitionStats = (index: number): ReactNode => {
    if (workload === 'key')
      return <LoadRows utilization={key.partitions[index].utilization} share={key.shares[index]} />;
    if (workload === 'checkout')
      return <LoadRows utilization={checkout.partitions[index].utilization} latencyMs={checkout.partitions[index].latencyMs} />;
    if (workload === 'report')
      return (
        <>
          <NodeStatRow label="Scanned" value={formatCompact(ORDER_SIZES[sizeIndex] / partitions)} />
          <NodeStatRow label="Sent to app" value={formatCompact(report.docRowsShipped / partitions)} tone="text-warn" />
        </>
      );
    return (
      <>
        <NodeStatRow label="Lock" value="none" tone="text-ok" />
        <NodeStatRow label="Order shapes" value={sim.docTwoShapes ? '2' : '1'} tone={sim.docTwoShapes ? 'text-warn' : 'text-ink'} />
      </>
    );
  };

  const sqlBusy =
    workload === 'key' ? key.sql.saturated : workload === 'checkout' ? checkout.sql.saturated : locked;
  const hotIndex = hotKey && workload === 'key' && partitions > 1 ? 0 : -1;

  return (
    <LabShell
      title="Data Models Lab"
      description="The same shop data - carts, products, orders - in one relational database and in a partitioned document store. Run a workload and watch what each side makes cheap and what it makes expensive."
      running={running}
      onRunningChange={setRunning}
      onReset={reset}
      legend={
        <div className="space-y-1.5">
          <ParticleLegend outcomes={['success', 'warning', 'failure']} />
          <p className="text-[11px] text-faint">{legendNote(workload)}</p>
        </div>
      }
      events={events}
      actions={
        workload === 'schema' ? (
          <Button variant="primary" onClick={runMigration} disabled={migrating}>
            <DatabaseZap className="h-4 w-4" />
            {migrating ? 'Migration running' : 'Run the migration'}
          </Button>
        ) : null
      }
      insight={<Insight>{insightFor(setup, { key, checkout, report, schema })}</Insight>}
      metrics={
        <CompareTable
          showSql={showSql}
          showDoc={showDoc}
          rows={metricRows(setup, { key, checkout, report, schema }, sim)}
        />
      }
      controls={
        <>
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted">Stores shown</p>
            <SegmentedControl size="sm" className="w-full" value={view} options={VIEWS} onChange={change('view')} />
          </div>
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted">Workload</p>
            <div role="group" aria-label="Workload" className="space-y-1.5">
              {WORKLOADS.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  onClick={() => chooseWorkload(item.value)}
                  aria-pressed={workload === item.value}
                  className={cn(
                    'w-full rounded-lg border px-3 py-2 text-left transition-colors',
                    workload === item.value ? 'border-brand bg-brand/10' : 'border-line hover:border-brand/50',
                  )}
                >
                  <span className={cn('block text-xs font-medium', workload === item.value ? 'text-brand' : 'text-ink')}>
                    {item.label}
                  </span>
                  <span className="block text-[11px] text-faint">{item.blurb}</span>
                </button>
              ))}
            </div>
          </div>
          {workload === 'key' ? (
            <Slider
              label="Key get/put per second"
              value={keyOps}
              min={5_000}
              max={200_000}
              step={5_000}
              onChange={change('keyOps')}
              format={(value) => formatNumber(value)}
              tone={(showSql && key.sql.saturated) || (showDoc && key.doc.busiest >= 1) ? 'danger' : 'brand'}
              hint={`Simplified capacity: one PostgreSQL primary about ${formatCompact(SQL_KEY_CAPACITY)}, each partition about ${formatCompact(PARTITION_CAPACITY)} per second.`}
            />
          ) : null}
          {workload === 'checkout' ? (
            <>
              <Slider
                label="Checkouts per second"
                value={checkouts}
                min={100}
                max={6_000}
                step={100}
                onChange={change('checkouts')}
                format={(value) => formatNumber(value)}
                hint={`Simplified capacity: one PostgreSQL primary about ${formatCompact(SQL_CHECKOUT_CAPACITY)} checkout transactions per second.`}
              />
              <Slider
                label="Fails half-way"
                value={crashRate}
                min={0}
                max={0.2}
                step={0.01}
                onChange={change('crashRate')}
                format={(value) => formatPercent(value)}
                tone="danger"
                hint="Share of checkouts where a step fails after the stock was reserved - the app crashes, or the order write times out."
              />
            </>
          ) : null}
          {workload === 'report' || workload === 'schema' ? (
            <Slider
              label="Orders stored"
              value={sizeIndex}
              min={0}
              max={ORDER_SIZES.length - 1}
              onChange={change('sizeIndex')}
              format={(value) => formatCompact(ORDER_SIZES[value])}
              scale={[formatCompact(ORDER_SIZES[0]), formatCompact(ORDER_SIZES[ORDER_SIZES.length - 1])]}
            />
          ) : null}
          {showDoc ? (
            <Slider
              label="Document store partitions"
              value={partitions}
              min={1}
              max={MAX_PARTITIONS}
              onChange={change('partitions')}
              format={(value) => `${value} ${value === 1 ? 'machine' : 'machines'}`}
              hint="Each partition is its own machine holding the keys that hash to it."
            />
          ) : null}
          {showDoc && workload === 'key' ? (
            <Toggle
              label="One hot key"
              checked={hotKey}
              onChange={change('hotKey')}
              description="Half of all traffic asks for the same cart"
            />
          ) : null}
          {showDoc && workload === 'checkout' ? (
            <Toggle
              label="Multi-document transaction"
              checked={docTransactions}
              onChange={change('docTransactions')}
              description="All-or-nothing, but every written item is prepared and committed"
            />
          ) : null}
          {showSql && workload === 'schema' ? (
            <Toggle
              label="Online migration"
              checked={onlineMigration}
              onChange={change('onlineMigration')}
              description="Add a column, backfill in batches, switch - instead of one ALTER"
              disabled={migrating}
            />
          ) : null}
        </>
      }
    >
      <DiagramCanvas
        layout={layout}
        edges={edges}
        particles={particleViews}
        height={CANVAS_HEIGHT}
        className="bg-canvas"
        underlay={<GroupFrames view={view} partitions={partitions} />}
      >
        <ArchNode kind="server" title="Application" subtitle="shop backend" placed={layout.app} compact />
        {showSql ? (
          <>
            <ArchNode
              kind="sql"
              title="PostgreSQL"
              subtitle="one primary, 3 tables"
              placed={layout.pg}
              status={sqlBusy ? 'degraded' : 'healthy'}
              alert={sqlBusy}
              compact
            >
              {sqlNodeStats()}
            </ArchNode>
            {TABLES.map((table) => (
              <ArchNode
                key={table.id}
                kind="storage"
                title={table.title}
                subtitle="table"
                placed={layout[table.id]}
                alert={table.id === 'orders' && migrating}
                compact
              />
            ))}
          </>
        ) : null}
        {showDoc
          ? Array.from({ length: partitions }, (_, index) => {
              const over =
                workload === 'key'
                  ? key.partitions[index].saturated
                  : workload === 'checkout'
                    ? checkout.partitions[index].saturated
                    : false;
              return (
                <ArchNode
                  key={partitionId(index)}
                  kind="nosql"
                  title={`Partition ${index + 1}`}
                  subtitle={index === hotIndex ? 'holds the hot key' : 'keys by hash'}
                  placed={layout[partitionId(index)]}
                  status={over ? 'degraded' : 'healthy'}
                  alert={over || index === hotIndex}
                  compact
                >
                  {partitionStats(index)}
                </ArchNode>
              );
            })
          : null}
      </DiagramCanvas>
    </LabShell>
  );
}

function LoadRows({ utilization, latencyMs, share }: { utilization: number; latencyMs?: number; share?: number }) {
  return (
    <>
      <NodeStatRow
        label="Load"
        value={formatPercent(Math.min(utilization, 9.99))}
        tone={utilization >= 1 ? 'text-danger' : utilization > 0.7 ? 'text-warn' : 'text-ok'}
      />
      {latencyMs !== undefined ? <NodeStatRow label="Latency" value={formatLatency(latencyMs)} /> : null}
      {share !== undefined ? <NodeStatRow label="Share of keys" value={formatPercent(share)} /> : null}
    </>
  );
}

/** Dashed frames that say how many machines each store is. Labels sit at the bottom, clear of the wires. */
function GroupFrames({ view, partitions }: { view: View; partitions: number }) {
  const frames: { x: number; label: string }[] = [];
  if (view !== 'document') frames.push({ x: view === 'relational' ? 257 : 12, label: 'One machine: every table, every write' });
  if (view !== 'relational')
    frames.push({
      x: view === 'document' ? 243 : 488,
      label: `${partitions} ${partitions === 1 ? 'machine' : 'machines'}: one per partition`,
    });
  return (
    <g>
      {frames.map((frame) => (
        <g key={frame.label}>
          <rect
            x={frame.x}
            y={124}
            width={frame.x === 12 || frame.x === 257 ? 446 : 470}
            height={310}
            rx={14}
            fill="none"
            strokeDasharray="6 6"
            className="stroke-line"
            strokeWidth={1.5}
          />
          <text x={frame.x + 12} y={427} className="fill-faint" style={{ fontSize: 11 }}>
            {frame.label}
          </text>
        </g>
      ))}
    </g>
  );
}

function legendNote(workload: Workload) {
  switch (workload) {
    case 'key':
      return 'Each dot is one get or put. Triangle: the machine is past 85% load and requests queue.';
    case 'checkout':
      return 'Triangle: a checkout that failed half-way and was undone, so the customer retries. Cross: it failed half-way and the stock write stayed, or the machine was over capacity.';
    case 'report':
      return 'Document side: dots coming back are orders shipped to the app; triangles are the product lookups your code adds.';
    default:
      return 'Triangle on the relational side: an order write waiting on the table lock.';
  }
}

interface Results {
  key: ReturnType<typeof evaluateKey>;
  checkout: ReturnType<typeof evaluateCheckout>;
  report: ReturnType<typeof evaluateReport>;
  schema: ReturnType<typeof evaluateSchema>;
}

interface Cell {
  value: ReactNode;
  tone?: 'ok' | 'warn' | 'danger';
}

interface Row {
  label: string;
  hint: string;
  sql: Cell;
  doc: Cell;
}

const loadTone = (utilization: number): Cell['tone'] => (utilization >= 1 ? 'danger' : utilization > 0.7 ? 'warn' : 'ok');

function metricRows(setup: Setup, results: Results, sim: SimState): Row[] {
  const { key, checkout, report, schema } = results;
  switch (setup.workload) {
    case 'key':
      return [
        {
          label: 'Latency',
          hint: 'Average time for one get or put.',
          sql: { value: formatLatency(key.sql.latencyMs), tone: key.sql.latencyMs > 20 ? 'danger' : undefined },
          doc: { value: formatLatency(key.doc.latencyMs), tone: key.doc.latencyMs > 20 ? 'danger' : undefined },
        },
        {
          label: 'Busiest machine',
          hint: 'Load on the machine with the most traffic. Above 100% it cannot keep up.',
          sql: { value: formatPercent(key.sql.utilization), tone: loadTone(key.sql.utilization) },
          doc: { value: formatPercent(key.doc.busiest), tone: loadTone(key.doc.busiest) },
        },
        {
          label: 'Failed requests',
          hint: 'Share of gets and puts rejected because a machine was over capacity.',
          sql: { value: formatPercent(key.sql.errorRate, 1), tone: key.sql.errorRate > 0 ? 'danger' : 'ok' },
          doc: { value: formatPercent(key.doc.errorRate, 1), tone: key.doc.errorRate > 0 ? 'danger' : 'ok' },
        },
        {
          label: 'Machines taking writes',
          hint: 'Read replicas could add read capacity to the relational side; every write still goes to the one primary.',
          sql: { value: '1 primary' },
          doc: { value: `${setup.partitions}` },
        },
      ];
    case 'checkout':
      return [
        {
          label: 'Latency per checkout',
          hint: 'Time for the whole checkout, all steps.',
          sql: { value: formatLatency(checkout.sql.latencyMs) },
          doc: { value: formatLatency(checkout.doc.latencyMs) },
        },
        {
          label: 'Busiest machine',
          hint: 'Load on the machine with the most traffic. Above 100% it cannot keep up.',
          sql: { value: formatPercent(checkout.sql.utilization), tone: loadTone(checkout.sql.utilization) },
          doc: { value: formatPercent(checkout.doc.busiest), tone: loadTone(checkout.doc.busiest) },
        },
        {
          label: 'All-or-nothing',
          hint: 'Whether a checkout that fails half-way leaves anything behind.',
          sql: { value: 'yes, one transaction', tone: 'ok' },
          doc: setup.docTransactions
            ? { value: `yes, ${checkout.docOps} ops per checkout`, tone: 'warn' }
            : { value: 'no, separate writes', tone: 'danger' },
        },
        {
          label: 'Half-done checkouts',
          hint: 'Stock reserved but no order written, counted while that store is on screen and running checkouts. Each one is a support ticket or a clean-up job.',
          sql: { value: `0 (${formatNumber(sim.rolledBackSql)} rolled back)`, tone: 'ok' },
          doc: setup.docTransactions
            ? { value: `0 (${formatNumber(sim.rolledBackDoc)} rolled back)`, tone: 'ok' }
            : { value: formatNumber(sim.partialOrders), tone: sim.partialOrders > 0 ? 'danger' : 'ok' },
        },
      ];
    case 'report':
      return [
        {
          label: 'Report time',
          hint: 'Time to produce revenue per category for the last 30 days.',
          sql: { value: formatSeconds(report.sqlSeconds), tone: report.sqlSeconds > 5 ? 'warn' : 'ok' },
          doc: {
            value: formatSeconds(report.docSeconds),
            tone: report.docSeconds > 5 ? 'danger' : report.docSeconds > 1 ? 'warn' : 'ok',
          },
        },
        {
          label: 'Rows sent to the app',
          hint: 'What crosses the network to the application before the answer exists.',
          sql: { value: formatNumber(report.sqlRowsShipped), tone: 'ok' },
          doc: { value: formatCompact(report.docRowsShipped), tone: 'danger' },
        },
        {
          label: 'Round trips',
          hint: 'Requests the application makes to the store.',
          sql: { value: formatNumber(report.sqlRoundTrips) },
          doc: { value: formatNumber(report.docRoundTrips) },
        },
        {
          label: 'Join done by',
          hint: 'Who writes and maintains the join and the grouping.',
          sql: { value: 'the database', tone: 'ok' },
          doc: { value: 'your code', tone: 'warn' },
        },
      ];
    default:
      return [
        {
          label: 'Migration time',
          hint: 'How long the change takes from start to done.',
          sql: { value: formatSeconds(schema.sqlSeconds) },
          doc: { value: 'nothing to run', tone: 'ok' },
        },
        {
          label: 'Order writes blocked',
          hint: `Time new orders wait on the table lock, and how many queue up at ${ORDER_WRITES_PER_SEC} orders per second.`,
          sql: setup.onlineMigration
            ? { value: 'none', tone: 'ok' }
            : { value: `${formatSeconds(schema.sqlBlockedSeconds)} (${formatCompact(schema.sqlBlockedWrites)})`, tone: 'danger' },
          doc: { value: 'none', tone: 'ok' },
        },
        {
          label: 'Order shapes your code reads',
          hint: 'How many versions of an order the application must understand afterwards.',
          sql: { value: '1', tone: 'ok' },
          doc: { value: '2, until you backfill', tone: 'warn' },
        },
        {
          label: 'Type enforced by',
          hint: 'Who stops a wrong value from being stored.',
          sql: { value: 'the database', tone: 'ok' },
          doc: { value: 'your code', tone: 'warn' },
        },
      ];
  }
}

const TONE_TEXT = { ok: 'text-ok', warn: 'text-warn', danger: 'text-danger' } as const;

function CompareTable({ rows, showSql, showDoc }: { rows: Row[]; showSql: boolean; showDoc: boolean }) {
  return (
    <div className="card p-4">
      <p className="label mb-3">{showSql && showDoc ? 'Same workload, both stores' : 'Workload results'}</p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[280px] text-left text-xs">
          <thead>
            <tr className="border-b border-line text-faint">
              <th className="py-2 pr-3 font-medium">Metric</th>
              {showSql ? <th className="py-2 pr-3 font-medium">Relational</th> : null}
              {showDoc ? <th className="py-2 font-medium">Document store</th> : null}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.label} className="border-b border-line/60 last:border-0">
                <td className="py-2 pr-3 text-muted">
                  <span className="inline-flex items-center gap-1.5">
                    {row.label}
                    <InfoTip content={row.hint} />
                  </span>
                </td>
                {showSql ? (
                  <td className={cn('py-2 pr-3 font-mono font-semibold', row.sql.tone ? TONE_TEXT[row.sql.tone] : 'text-ink')}>
                    {row.sql.value}
                  </td>
                ) : null}
                {showDoc ? (
                  <td className={cn('py-2 font-mono font-semibold', row.doc.tone ? TONE_TEXT[row.doc.tone] : 'text-ink')}>
                    {row.doc.value}
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-[11px] text-faint">
        {SIMULATED_HINT} Capacities and speeds are illustrative round numbers, chosen so each workload shows its shape -
        not a benchmark of PostgreSQL or of any document store.
      </p>
    </div>
  );
}

function insightFor(setup: Setup, results: Results): ReactNode {
  const { view, workload, keyOps, partitions, hotKey, docTransactions, onlineMigration, crashRate } = setup;
  const { key, checkout, report, schema } = results;
  const sqlSide = view !== 'document';
  const docSide = view !== 'relational';

  if (workload === 'key') {
    if (docSide && hotKey && partitions > 1)
      return (
        <>
          Half of all requests ask for one cart, and one key lives on one partition, so Partition 1 carries{' '}
          {formatNumber(keyOps / 2)} requests per second at {formatPercent(key.partitions[0].utilization)} load while the
          others idle. Adding partitions no longer helps: a single key cannot be split. The fix is a better partition key or
          a cache in front of the hot one.
        </>
      );
    if (view === 'document')
      return (
        <>
          Every get or put names its key, the key hashes to one partition, and only that machine does any work. {partitions}{' '}
          partitions share {formatNumber(keyOps)} requests per second, so the busiest runs at{' '}
          {formatPercent(key.doc.busiest)}. Push the traffic up until one saturates, then add a partition: capacity grows with
          the machine count. Now turn on One hot key.
        </>
      );
    if (key.sql.saturated)
      return (
        <>
          At {formatNumber(keyOps)} requests per second the single PostgreSQL primary is past its (simplified){' '}
          {formatCompact(SQL_KEY_CAPACITY)} ceiling and {formatPercent(key.sql.errorRate, 1)} of requests fail
          {docSide ? `, while the document store spreads the same keys over ${partitions} machines` : ''}. This workload
          never joins anything, so splitting it by key is easy. A relational database can scale it too - read replicas for
          reads, sharding for writes - but that is work you add, not the default shape.
          {docSide ? ' Now pick Join-heavy report and see which side struggles.' : ''}
        </>
      );
    return (
      <>
        Below about {formatCompact(SQL_KEY_CAPACITY)} requests per second both stores answer a key lookup in about a
        millisecond - neither is the fast one here. Raise the traffic past what one primary can take and watch where the
        difference really is: how many machines can share the writes.
      </>
    );
  }

  if (workload === 'checkout') {
    const sqlText = (
      <>
        PostgreSQL runs the checkout as one transaction: it joins the cart with product prices, reserves stock and inserts
        the order. In {formatPercent(crashRate)} of checkouts a step fails half-way; the whole transaction rolls
        back (the triangles), so a reserved item without an order can never exist.{' '}
      </>
    );
    if (!docSide)
      return (
        <>
          {sqlText}Push Checkouts per second past about {formatCompact(SQL_CHECKOUT_CAPACITY)}: every write goes through the
          one primary, which is the limit that later forces replicas or sharding. Then pick Join-heavy report, the other
          thing relational stores are built for.
        </>
      );
    if (docTransactions)
      return (
        <>
          {sqlSide ? sqlText : null}With a multi-document transaction the document store is all-or-nothing too, but each
          checkout now costs {checkout.docOps} operations instead of 4 and about {formatLatency(checkout.doc.latencyMs)}, because
          every written item is prepared and then committed. Document stores offer this, and their own docs advise designing
          the documents so you rarely need it.
        </>
      );
    return (
      <>
        {sqlSide ? sqlText : null}The document store has no join, so the app reads the cart, then the products, then writes
        stock and the order as separate operations on different partitions. When a checkout fails between those writes (the
        crosses), the stock stays reserved with no order - the half-done count keeps growing. Turn on Multi-document
        transaction and compare the cost.
      </>
    );
  }

  if (workload === 'report') {
    const huge = report.sqlSeconds > 5;
    return (
      <>
        Revenue per category needs every recent order joined with its product.{' '}
        {sqlSide ? (
          <>
            PostgreSQL does the join inside the database and sends back {report.sqlRowsShipped} rows in{' '}
            {formatSeconds(report.sqlSeconds)}.{' '}
          </>
        ) : null}
        {docSide ? (
          <>
            The document store here has no join (simplified: some offer a limited one, such as MongoDB $lookup), so the app
            pulls {formatCompact(report.docRowsShipped)} orders from every partition, looks up products in batches, and joins in
            its own code: {formatSeconds(report.docSeconds)}. More partitions only speed up the scan, not the shipping.{' '}
          </>
        ) : null}
        {huge
          ? 'At this size neither belongs on a live page: reports like this move to a read replica or a separate analytics store.'
          : 'Raise Orders stored and watch both grow - one by rows joined, the other by rows shipped.'}
      </>
    );
  }

  return (
    <>
      {sqlSide ? (
        onlineMigration ? (
          <>
            The online path adds a new bigint column (instant), copies values in small batches and then switches over. No
            write waits, but it takes {formatSeconds(schema.sqlSeconds)} and several deploys instead of one statement.{' '}
          </>
        ) : (
          <>
            Changing a column type makes PostgreSQL rewrite the whole table under an ACCESS EXCLUSIVE lock: about{' '}
            {formatSeconds(schema.sqlBlockedSeconds)} in this model, while every order write waits. Press Run the migration,
            then try Online migration.{' '}
          </>
        )
      ) : null}
      {docSide ? (
        <>
          The document store has no ALTER: new orders simply carry the new field. Nothing is locked, but old and new orders
          now differ, your code must read both, and nothing in the database stops a third shape.
        </>
      ) : null}
    </>
  );
}

export default DataModelsLab;
