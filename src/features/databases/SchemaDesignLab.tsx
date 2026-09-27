import { useRef } from 'react';
import { ArchNode, DiagramCanvas, NodeStatRow, ParticleLegend, type DiagramEdge, type Layout, type ParticleView } from '@/components/architecture';
import { Insight, LabShell, MetricsPanel, SIMULATED_HINT } from '@/components/learning';
import { Meter, SegmentedControl, Slider, Toggle } from '@/components/ui';
import { advanceParticles, nextParticleId, useEventLog, useTicker, type Particle } from '@/simulations/engine';
import { computeLoad } from '@/simulations/models/load';
import { useLabSetup } from '@/hooks/useLabSetup';
import { useRerender } from '@/hooks/useRerender';
import { clamp, sampleArrivals } from '@/utils/math';
import { formatLatency, formatNumber, formatPercent } from '@/utils/format';
import type { LabFocus, LabProps, RequestOutcome } from '@/types';
import { useLabRunning } from '@/hooks/useLabRunning';

type Schema = 'normalized' | 'denormalized';

interface Setup {
  schema: Schema;
  /** Order page views per second. Each one shows an order with its customer email and total. */
  reads: number;
  /** Customers changing their email, per second. */
  updates: number;
  /** Orders each customer has - how many rows a copied email lives in. */
  ordersPerCustomer: number;
  /** Share of multi-row email changes that stop part way. */
  halfDone: number;
  /** A periodic job that recomputes the copies from the customers table. */
  reconcile: boolean;
}

/** What the lab opens on at /labs/schema-design, with no Lab focus. */
const DEFAULT_SETUP: Setup = {
  schema: 'normalized',
  reads: 600,
  updates: 5,
  ordersPerCustomer: 20,
  halfDone: 0.02,
  reconcile: false,
};

/**
 * The Lab focus of each Concept that hosts this lab - one decision seen from two
 * sides. Database Normalization opens on a denormalized schema that is write-heavy
 * and already contradicting itself, so the learner normalizes it. Denormalization
 * opens on a normalized schema under a read-heavy load that the joins cannot
 * carry, so the learner denormalizes it and then has to keep the copies honest.
 */
const FOCUS_SETUPS: Record<LabFocus<'schema-design'>, Setup> = {
  'database-normalization': {
    schema: 'denormalized',
    reads: 200,
    updates: 20,
    ordersPerCustomer: 100,
    halfDone: 0.03,
    reconcile: false,
  },
  denormalization: {
    schema: 'normalized',
    reads: 1500,
    updates: 5,
    ordersPerCustomer: 20,
    halfDone: 0.03,
    reconcile: false,
  },
};

/*
 * Cost model - simplified on purpose, and labelled as such in the UI.
 * The database is given a budget of row operations per second. A row read costs
 * 1, a row write costs WRITE_WEIGHT (the write also goes to the log and to every
 * index on the table, and holds a lock). An order page in the normalized schema
 * reads the order, joins its customer and sums its line items; in the
 * denormalized schema the email and the total are already on the order row.
 */
const ITEMS_PER_ORDER = 4;
const WRITE_WEIGHT = 4;
const CAPACITY = 8000;
const RECONCILE_EVERY_S = 10;
/** Where a half-done change stopped, as a share of its rows. Illustrative. */
const STOPPED_AT = 0.6;

const rowsPerRead = (schema: Schema) => (schema === 'normalized' ? 2 + ITEMS_PER_ORDER : 1);
const rowsPerUpdate = (schema: Schema, orders: number) => (schema === 'normalized' ? 1 : 1 + orders);

const LAYOUT: Layout = {
  reads: { x: 20, y: 50, w: 210, h: 94 },
  writes: { x: 20, y: 326, w: 210, h: 94 },
  db: { x: 350, y: 150, w: 240, h: 168 },
  customers: { x: 690, y: 20, w: 250, h: 116 },
  orders: { x: 690, y: 180, w: 250, h: 116 },
  items: { x: 690, y: 340, w: 250, h: 116 },
};

interface SimState {
  particles: Particle[];
  /** Customers whose copies of the email disagree with each other. */
  conflicts: number;
  /** Fractional half-done changes not yet counted as a whole customer. */
  pending: number;
  sinceReconcile: number;
  saturated: boolean;
}

const createState = (): SimState => ({ particles: [], conflicts: 0, pending: 0, sinceReconcile: 0, saturated: false });

export function SchemaDesignLab({ focus }: LabProps<'schema-design'>) {
  // The page keys this lab by Concept, so the focus never changes under a mounted lab.
  const start = focus ? FOCUS_SETUPS[focus] : DEFAULT_SETUP;
  // Every control lives in one object, so Reset cannot miss one.
  const { setup, setSetup, change } = useLabSetup(start);
  const { schema, reads, updates, ordersPerCustomer, halfDone, reconcile } = setup;

  const [running, setRunning] = useLabRunning();
  const state = useRef<SimState>(createState());
  const rerender = useRerender(30);
  const { events, log, clear } = useEventLog();

  const denormalized = schema === 'denormalized';
  const readRows = rowsPerRead(schema);
  const updateRows = rowsPerUpdate(schema, ordersPerCustomer);
  const copies = denormalized ? 1 + ordersPerCustomer : 1;
  const reconcileRows = denormalized && reconcile ? updates * (1 + ordersPerCustomer) : 0;
  const readLoad = reads * readRows;
  const writeLoad = updates * updateRows * WRITE_WEIGHT;
  const load = computeLoad(readLoad + writeLoad + reconcileRows, CAPACITY, { baseLatencyMs: 1, kneeAt: 0.7 });
  const pageLatency = load.latencyMs * (0.6 + readRows * 0.4);
  const changeLatency = load.latencyMs * (0.6 + updateRows * 0.4 * WRITE_WEIGHT);
  const readShare = readLoad / Math.max(1, readLoad + writeLoad + reconcileRows);

  const switchSchema = (next: Schema) => {
    if (next === schema) return;
    if (next === 'normalized') {
      const fixed = state.current.conflicts;
      state.current.conflicts = 0;
      state.current.pending = 0;
      log(
        `Normalized: dropped the copied columns. Orders point at customers by customer_id${
          fixed ? `, and the ${fixed} customers with disagreeing copies now have one email each` : ''
        }.`,
        'ok',
      );
    } else {
      log(`Denormalized: copied customer_email and the order total into every orders row (${ordersPerCustomer} per customer).`, 'warn');
    }
    change('schema')(next);
  };

  useTicker(running, (dt) => {
    const sim = state.current;
    const errorOutcome = (fallback: RequestOutcome): RequestOutcome => (Math.random() < load.errorRate ? 'failure' : fallback);

    // Particles are a sample of the traffic, never the traffic itself: the
    // metrics come from the rates above, the dots only show the shape.
    const readDots = sampleArrivals(1.2 + (3.3 * Math.min(reads, 2500)) / 2500, dt);
    for (let index = 0; index < readDots; index += 1) {
      const outcome = errorOutcome('success');
      const targets = denormalized ? ['orders'] : ['orders', 'customers', 'items'];
      for (const table of targets) {
        sim.particles.push({ id: nextParticleId(), route: ['reads', 'db', table], leg: 0, t: 0, speed: 1.1, outcome });
      }
    }

    const spawnChange = (outcome: RequestOutcome, stale: boolean) => {
      sim.particles.push({ id: nextParticleId(), route: ['writes', 'db', 'customers'], leg: 0, t: 0, speed: 0.9, outcome });
      if (!denormalized) return;
      const shown = clamp(Math.round(ordersPerCustomer / 25), 1, 4);
      for (let index = 0; index < shown; index += 1) {
        sim.particles.push({
          id: nextParticleId(),
          route: ['writes', 'db', 'orders'],
          leg: 0,
          t: 0,
          speed: 0.9 - index * 0.1,
          outcome: stale && index >= shown * STOPPED_AT ? 'failure' : outcome,
        });
      }
    };

    const changeDots = sampleArrivals(updates === 0 ? 0 : 0.4 + (2 * Math.min(updates, 50)) / 50, dt);
    for (let index = 0; index < changeDots; index += 1) spawnChange(errorOutcome('warning'), false);

    // Half-done email changes. Only the denormalized schema can be left half
    // done: in the normalized one the change is a single row, which is either
    // written or not.
    if (denormalized && halfDone > 0 && updates > 0) {
      sim.pending += updates * halfDone * dt;
      while (sim.pending >= 1) {
        sim.pending -= 1;
        sim.conflicts += 1;
        const stale = Math.max(1, Math.round(ordersPerCustomer * (1 - STOPPED_AT)));
        const customer = 1000 + Math.floor(Math.random() * 9000);
        log(
          `Email change for customer ${customer} stopped part way: ${stale} of ${ordersPerCustomer} order rows still hold the old email.`,
          'danger',
        );
        spawnChange('warning', true);
      }
    }

    if (denormalized && reconcile) {
      sim.sinceReconcile += dt;
      if (sim.sinceReconcile >= RECONCILE_EVERY_S) {
        sim.sinceReconcile = 0;
        if (sim.conflicts > 0) {
          log(`Reconciliation job recomputed the copies from customers and fixed ${sim.conflicts} customers.`, 'ok');
          sim.conflicts = 0;
        } else {
          log('Reconciliation job ran: no drift found.', 'info');
        }
      }
    } else {
      sim.sinceReconcile = 0;
    }

    if (load.saturated && !sim.saturated) {
      sim.saturated = true;
      log(
        `Database over budget: ${formatNumber(readLoad + writeLoad + reconcileRows)} row operations/sec against ${formatNumber(CAPACITY)} - requests failing.`,
        'danger',
      );
    } else if (!load.saturated && sim.saturated) {
      sim.saturated = false;
      log('Database back under budget.', 'ok');
    }

    sim.particles = advanceParticles(sim.particles, dt).alive.slice(-90);
    rerender();
  });

  const reset = () => {
    setSetup(start);
    state.current = createState();
    clear();
  };

  const sim = state.current;
  const particleViews: ParticleView[] = sim.particles.map((particle) => ({
    id: particle.id,
    from: particle.route[particle.leg],
    to: particle.route[particle.leg + 1],
    t: particle.t,
    outcome: particle.outcome ?? 'success',
  }));

  const edges: DiagramEdge[] = [
    { from: 'reads', to: 'db', tone: 'brand', width: 2 },
    { from: 'writes', to: 'db', tone: 'warn', width: 2 },
    { from: 'db', to: 'customers', tone: denormalized ? 'warn' : 'info' },
    { from: 'db', to: 'orders', tone: denormalized ? 'warn' : 'info', width: denormalized ? 2.5 : 1.75 },
    // The order page never reads order_items once the total is stored on the order.
    { from: 'db', to: 'items', tone: denormalized ? 'muted' : 'info', dashed: denormalized },
  ];

  const customersRows = denormalized ? updates : reads + updates;
  const ordersRows = reads + (denormalized ? updates * ordersPerCustomer : 0);
  const itemsRows = denormalized ? 0 : reads * ITEMS_PER_ORDER;

  function insightFor() {
    if (denormalized && load.saturated) {
      return (
        <>
          Every email change rewrites {formatNumber(updateRows)} rows - the customers row and {ordersPerCustomer} order
          rows that carry a copy - so {updates} changes per second cost {formatNumber(writeLoad)} row operations and the
          database is over its budget. The copy is paying for a read path that only sees {formatNumber(reads)} reads per
          second.{' '}
          {sim.conflicts > 0
            ? `And ${formatNumber(sim.conflicts)} customers already have order rows that disagree about their email. `
            : ''}
          Switch to Normalized: the change becomes one row, and the page pays a join instead.
        </>
      );
    }
    if (!denormalized && load.saturated) {
      return (
        <>
          Every order page reads {readRows} rows - the order, its customer through a join, and {ITEMS_PER_ORDER} line
          items to SUM the total - so {formatNumber(reads)} reads per second cost {formatNumber(readLoad)} row operations.
          Before duplicating anything, check that the join keys are indexed; here they are, and the volume is still too
          much. Switch to Denormalized: the email and the total ride on the order row, and each page reads 1 row.
        </>
      );
    }
    if (denormalized && sim.conflicts > 0 && !reconcile) {
      return (
        <>
          {formatNumber(sim.conflicts)} customers now have order rows that disagree about their email, and no constraint
          noticed: to the database each row is valid on its own. That is the update anomaly - one fact stored{' '}
          {formatNumber(copies)} times, and a change that did not reach every copy. Normalize so the email is stored once,
          or keep the copy and turn on the reconciliation job.
        </>
      );
    }
    if (denormalized && reconcile) {
      return (
        <>
          The reconciliation job recomputes the copies from the customers table every {RECONCILE_EVERY_S} seconds, so
          drift is found and fixed instead of piling up - at a cost of {formatNumber(reconcileRows)} row reads per second.
          Between runs a reader can still see an old email: denormalized data needs an owner, a sync mechanism and a
          reconciliation job.
        </>
      );
    }
    if (denormalized) {
      return (
        <>
          Each order page reads 1 row instead of {rowsPerRead('normalized')}, and each email change writes{' '}
          {formatNumber(updateRows)} rows instead of 1. That trade pays off when reads far outnumber writes - here reads
          are {formatPercent(readShare)} of the load.{' '}
          {halfDone > 0 && updates > 0
            ? `The risk is the copies: at ${formatPercent(halfDone)} of changes left half-done, a customer ends up with disagreeing order rows about every ${Math.max(1, Math.round(1 / (updates * halfDone)))} s.`
            : 'Raise Changes left half-done to see what the copies risk.'}
        </>
      );
    }
    return (
      <>
        Each email is stored once, in customers. A change writes 1 row, so it either happens or it does not - raise
        Changes left half-done and the disagreeing-copies counter stays at 0. The price is on the read side: every order
        page reads {readRows} rows through a join and a SUM. Raise Order page reads to find where that stops being cheap.
      </>
    );
  }

  return (
    <LabShell
      title="Schema Design Lab"
      description="One orders schema, normalized or denormalized. Run order page reads and email changes against it and watch where the rows are read, where they are written, and whether the copies still agree."
      running={running}
      onRunningChange={setRunning}
      onReset={reset}
      events={events}
      legend={<ShapeLegend />}
      insight={<Insight>{insightFor()}</Insight>}
      metrics={
        <>
          <MetricsPanel
            items={[
              {
                key: 'readRows',
                label: 'Rows per order page',
                value: readRows,
                tone: readRows > 1 ? 'warn' : 'ok',
                hint: denormalized
                  ? 'The email and the total are on the order row: one row answers the page.'
                  : `1 order row + 1 customer row (join) + ${ITEMS_PER_ORDER} order_items rows (SUM for the total).`,
              },
              {
                key: 'writeRows',
                label: 'Rows per email change',
                value: formatNumber(updateRows),
                tone: updateRows > 1 ? 'warn' : 'ok',
                hint: denormalized
                  ? `The customers row plus the ${ordersPerCustomer} order rows that carry a copy.`
                  : 'Only the customers row: the orders point at it by customer_id.',
              },
              {
                key: 'copies',
                label: 'Copies of each email',
                value: formatNumber(copies),
                tone: copies > 1 ? 'warn' : 'ok',
                hint: 'Places the same fact is stored. Every copy is one more place an update can miss.',
              },
              {
                key: 'cpu',
                label: 'Database load',
                value: formatPercent(Math.min(load.utilization, 9.99)),
                tone: load.saturated ? 'danger' : load.utilization > 0.7 ? 'warn' : 'ok',
                hint: `Row operations per second against a budget of ${formatNumber(CAPACITY)}. A row write counts ${WRITE_WEIGHT}x a row read.`,
                simulated: true,
              },
              {
                key: 'latency',
                label: 'Order page latency',
                value: formatLatency(pageLatency),
                tone: load.saturated ? 'danger' : 'neutral',
                simulated: true,
              },
              {
                key: 'conflicts',
                label: 'Customers with disagreeing copies',
                value: formatNumber(sim.conflicts),
                tone: sim.conflicts > 0 ? 'danger' : 'ok',
                hint: 'Customers whose order rows show more than one email. A normalized schema cannot get here: there is one copy.',
              },
            ]}
          />
          <div className="card p-4">
            <p className="label mb-3">What the tables hold for customer 42</p>
            <pre className="ascii text-[11px]">{rowsSketch(schema, ordersPerCustomer, sim.conflicts > 0)}</pre>
            <p className="mt-2 text-xs text-faint">
              {SIMULATED_HINT} The database has a budget of {formatNumber(CAPACITY)} row operations
              per second, a row write counts {WRITE_WEIGHT}x a row read, every order has {ITEMS_PER_ORDER} line items,
              and a half-done change is taken to stop after {Math.round(STOPPED_AT * 100)}% of its rows.
            </p>
          </div>
        </>
      }
      controls={
        <>
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted">Schema</p>
            <SegmentedControl
              className="w-full"
              size="sm"
              value={schema}
              options={[
                { value: 'normalized', label: 'Normalized' },
                { value: 'denormalized', label: 'Denormalized' },
              ]}
              onChange={switchSchema}
            />
            <p className="text-[11px] text-faint">
              {denormalized
                ? 'orders carries a copy of customer_email and the order total.'
                : 'Each fact once: customers, orders, order_items, linked by keys.'}
            </p>
          </div>
          <Slider
            label="Order page reads"
            value={reads}
            min={50}
            max={2500}
            step={50}
            onChange={change('reads')}
            format={(value) => `${formatNumber(value)}/sec`}
            tone="brand"
            hint="Each read shows one order with its customer email and total."
          />
          <Slider
            label="Email changes"
            value={updates}
            min={0}
            max={50}
            onChange={change('updates')}
            format={(value) => `${value}/sec`}
            tone="warn"
            hint="Customers changing their email. The fact that is copied in the denormalized schema."
          />
          <Slider
            label="Orders per customer"
            value={ordersPerCustomer}
            min={1}
            max={200}
            onChange={change('ordersPerCustomer')}
            format={(value) => `${value} orders`}
            hint="How many order rows hold a copy of one email once it is denormalized."
          />
          <Slider
            label="Changes left half-done"
            value={halfDone}
            min={0}
            max={0.1}
            step={0.01}
            onChange={change('halfDone')}
            format={(value) => formatPercent(value)}
            tone="danger"
            hint="Email changes that stop part way: a crash between statements, a batch that times out, a tool that forgets the copies. It only matters when there is more than one copy."
          />
          <Toggle
            label="Reconciliation job"
            checked={reconcile}
            onChange={change('reconcile')}
            disabled={!denormalized}
            description={`Every ${RECONCILE_EVERY_S} s, recompute the copies from customers and fix drift. It costs row reads.`}
          />
          <div className="border-t border-line pt-4">
            <p className="label mb-2">Where the load comes from</p>
            <Meter value={readShare} tone="brand" label="Reads" />
            <p className="mt-2 font-mono text-[11px] text-muted">
              reads {formatNumber(readLoad)} + writes {formatNumber(writeLoad)}
              {reconcileRows ? ` + reconcile ${formatNumber(reconcileRows)}` : ''} row ops/sec
            </p>
          </div>
        </>
      }
    >
      <DiagramCanvas layout={LAYOUT} edges={edges} particles={particleViews} height={470} className="bg-canvas">
        <ArchNode kind="client" title="Order page" subtitle={`${formatNumber(reads)} reads/sec`} placed={LAYOUT.reads} compact>
          <NodeStatRow label="Rows per read" value={readRows} tone={readRows > 1 ? 'text-warn' : 'text-ok'} />
        </ArchNode>
        <ArchNode kind="client" title="Email changes" subtitle={`${updates} writes/sec`} placed={LAYOUT.writes} compact>
          <NodeStatRow label="Rows per change" value={formatNumber(updateRows)} tone={updateRows > 1 ? 'text-warn' : 'text-ok'} />
        </ArchNode>
        <ArchNode
          kind="sql"
          title="PostgreSQL"
          subtitle="one database"
          placed={LAYOUT.db}
          status={load.saturated ? 'degraded' : 'healthy'}
          alert={load.saturated}
          compact
        >
          <Meter label="Load (simplified)" value={Math.min(1, load.utilization)} />
          <NodeStatRow
            label="Page latency"
            value={formatLatency(pageLatency)}
            tone={load.saturated ? 'text-danger' : 'text-ink'}
          />
          <NodeStatRow
            label="Change latency"
            value={formatLatency(changeLatency)}
            tone={load.saturated ? 'text-danger' : 'text-ink'}
          />
        </ArchNode>
        <ArchNode kind="storage" title="customers" subtitle="id, name, email" placed={LAYOUT.customers} compact>
          <NodeStatRow label="Rows touched/sec" value={formatNumber(customersRows)} />
          <NodeStatRow label="Holds the email" value="source" />
        </ArchNode>
        <ArchNode
          kind="storage"
          title="orders"
          subtitle={denormalized ? 'copies: customer_email, total' : 'id, customer_id, placed_at'}
          placed={LAYOUT.orders}
          alert={sim.conflicts > 0}
          compact
        >
          <NodeStatRow label="Rows touched/sec" value={formatNumber(ordersRows)} />
          <NodeStatRow
            label={denormalized ? 'Copies per email' : 'Email stored here'}
            value={denormalized ? formatNumber(ordersPerCustomer) : 'no'}
            tone={denormalized ? 'text-warn' : 'text-ok'}
          />
        </ArchNode>
        <ArchNode kind="storage" title="order_items" subtitle="order_id, product, qty, price" placed={LAYOUT.items} compact>
          <NodeStatRow label="Rows read/sec" value={formatNumber(itemsRows)} />
          <NodeStatRow label="Read by order page" value={denormalized ? 'no' : `${ITEMS_PER_ORDER} per page`} />
        </ArchNode>
      </DiagramCanvas>
    </LabShell>
  );
}

/** Shapes, colours and text - status is never colour alone. */
function ShapeLegend() {
  return (
    <ParticleLegend
      outcomes={[
        { outcome: 'success', label: 'Row read' },
        { outcome: 'warning', label: 'Row write' },
        { outcome: 'failure', label: 'Copy left stale, or request failed' },
      ]}
    />
  );
}

/** A fixed-width picture of the rows behind one customer, in the current schema. */
function rowsSketch(schema: Schema, orders: number, stale: boolean) {
  if (schema === 'normalized') {
    return [
      'customers                  orders',
      ' id  email                  id    customer_id  placed_at',
      ' 42  ana@new.example        9001  42           2026-03-02',
      '                            9002  42           2026-05-17',
      '                            ...   42           (' + orders + ' rows)',
      '',
      'The email lives in 1 row. Orders point at it by customer_id,',
      'so a read joins the two tables and a change writes 1 row.',
    ].join('\n');
  }
  return [
    'orders  (customer data copied into every row)',
    ' id    customer_id  customer_email    total',
    ' 9001  42           ana@new.example   85.00',
    ` 9002  42           ${stale ? 'ana@old.example   60.00   <- stale copy' : 'ana@new.example   60.00'}`,
    ` ...   42           (${orders} rows, each with its own copy)`,
    '',
    `The email lives in ${1 + orders} rows (customers + ${orders} orders).`,
    'A read needs 1 row; a change must reach every copy.',
  ].join('\n');
}

export default SchemaDesignLab;
