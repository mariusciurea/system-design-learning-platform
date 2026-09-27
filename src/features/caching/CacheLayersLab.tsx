import { useCallback, useRef } from 'react';
import {
  ArchNode,
  DiagramCanvas,
  NodeStatRow,
  ParticleLegend,
  type DiagramEdge,
  type Layout,
  type ParticleView,
} from '@/components/architecture';
import { LiveChart } from '@/components/charts';
import { Insight, LabShell, MetricsPanel, SIMULATED_HINT } from '@/components/learning';
import { Meter, Slider, Toggle } from '@/components/ui';
import {
  advanceParticles,
  MetricWindow,
  nextParticleId,
  RateCounter,
  useEventLog,
  useSeries,
  useTicker,
  visualShare,
  type Particle,
} from '@/simulations/engine';
import { computeLoad } from '@/simulations/models/load';
import { useLabSetup } from '@/hooks/useLabSetup';
import { useRerender } from '@/hooks/useRerender';
import { clamp, sampleArrivals } from '@/utils/math';
import { formatLatency, formatNumber, formatPercent } from '@/utils/format';
import type { LabFocus, LabProps, RequestOutcome } from '@/types';
import {
  BASE_PAGES,
  DB_WORK_CAPACITY_MS,
  HOT_PRODUCTS,
  INSTANCES,
  LOCAL_CAPACITY,
  LOCAL_HIT_MS,
  NETWORK_MS,
  PAGE_KB,
  PAGES_PER_PRODUCT,
  PRODUCTS,
  VIEW_PAGES,
  createModel,
  expireLocals,
  hotDisagreements,
  read,
  refreshView,
  staleEntries,
  trimBuffer,
  write,
  type CacheLayersSetup,
  type ModelState,
} from './cacheLayersModel';
import { useLabRunning } from '@/hooks/useLabRunning';

type Setup = CacheLayersSetup;

/** What the lab opens on at /labs/cache-layers, with no Lab focus: every layer on. */
const DEFAULT_SETUP: Setup = {
  reads: 1000,
  writes: 2,
  localCache: true,
  localTtl: 10,
  bufferPages: 8000,
  view: true,
  refreshSec: 30,
};

/**
 * The Lab focus of each Concept that hosts this lab.
 * Database caching opens on the two database layers: no app cache, the materialized view on,
 * and a buffer pool too small for the orders table - small enough only for the view. Turning
 * the view off shows what it was saving: every read sums the order rows again, the working set
 * outgrows the pool and pages come from disk. Raising the buffer pool is the other fix.
 * Application caching opens with a long local TTL, a database that fits in memory (so the
 * database is not the story) and enough orders that the three copies drift apart.
 */
const FOCUS_SETUPS: Record<LabFocus<'cache-layers'>, Setup> = {
  'database-caching': { ...DEFAULT_SETUP, localCache: false, view: true, bufferPages: 4000 },
  'application-caching': { ...DEFAULT_SETUP, localTtl: 30, writes: 5, view: false, bufferPages: 24000 },
};

const APPS = Array.from({ length: INSTANCES }, (_, index) => `app${index + 1}`);

const LAYOUT: Layout = {
  users: { x: 4, y: 222, w: 130, h: 74 },
  lb: { x: 148, y: 216, w: 164, h: 86 },
  app1: { x: 330, y: 20, w: 190, h: 140 },
  app2: { x: 330, y: 190, w: 190, h: 140 },
  app3: { x: 330, y: 360, w: 190, h: 140 },
  engine: { x: 556, y: 186, w: 176, h: 148 },
  orders: { x: 770, y: 20, w: 180, h: 116 },
  buffer: { x: 770, y: 186, w: 180, h: 148 },
  view: { x: 770, y: 384, w: 180, h: 116 },
};

const ANIMATED_PER_SECOND = 40;
const PARTICLE_BUDGET = 120;
const PARTICLE_SPEED = 2.2;

interface State {
  model: ModelState;
  particles: Particle[];
  reads: RateCounter;
  localHits: RateCounter;
  stale: RateCounter;
  staleFromView: RateCounter;
  dbQueries: RateCounter;
  timeouts: RateCounter;
  pageReads: RateCounter;
  diskReads: RateCounter;
  /** Milliseconds of database work per second. */
  work: RateCounter;
  latency: MetricWindow;
  instanceReads: RateCounter[];
  instanceHits: RateCounter[];
  lastOverloadLog: number;
}

const counter = () => new RateCounter(3000);

const createState = (): State => ({
  model: createModel(performance.now()),
  particles: [],
  reads: counter(),
  localHits: counter(),
  stale: counter(),
  staleFromView: counter(),
  dbQueries: counter(),
  timeouts: counter(),
  pageReads: counter(),
  diskReads: counter(),
  work: counter(),
  latency: new MetricWindow(600),
  instanceReads: APPS.map(counter),
  instanceHits: APPS.map(counter),
  lastOverloadLog: 0,
});

/** Simplified queueing: the pooled database work against what 4 cores can do. */
const dbLoadFor = (workPerSecond: number) =>
  computeLoad(workPerSecond, DB_WORK_CAPACITY_MS, { baseLatencyMs: 1, kneeAt: 0.7, maxLatencyMs: 60 });

/** Sub-millisecond latencies are the point of an in-process cache, so show them. */
const formatMs = (ms: number | null) => (ms !== null && ms < 1 ? `${ms.toFixed(2)} ms` : formatLatency(ms));

const pagesAsMb = (pages: number) => `${formatNumber((pages * PAGE_KB) / 1024)} MB`;

export function CacheLayersLab({ focus }: LabProps<'cache-layers'>) {
  // The page keys this lab by Concept, so the focus never changes under a mounted lab.
  const start = focus ? FOCUS_SETUPS[focus] : DEFAULT_SETUP;
  // Every control lives in one object, so Reset cannot miss one.
  const { setup, setSetup, change } = useLabSetup(start);
  const [running, setRunning] = useLabRunning();

  const state = useRef<State>(createState());
  const rerender = useRerender(30);
  const { events, log, clear } = useEventLog();
  const { points, push, reset: resetSeries } = useSeries(60, 500);

  const reset = useCallback(() => {
    setSetup(start);
    state.current = createState();
    clear();
    resetSeries();
  }, [start, clear, resetSeries, setSetup]);

  const spawn = (route: string[], outcome: RequestOutcome) => {
    state.current.particles.push({ id: nextParticleId(), route, leg: 0, t: 0, speed: PARTICLE_SPEED, outcome });
  };

  /** The refresh reads the orders table, recomputes the totals and writes the new view. */
  const runRefresh = (now: number) => {
    const current = state.current;
    current.work.add(refreshView(current.model, now), now);
    spawn(['orders', 'buffer', 'engine', 'buffer', 'view'], 'success');
  };

  useTicker(running, (dt) => {
    const current = state.current;
    const { model } = current;
    const now = performance.now();
    const load = dbLoadFor(current.work.rate(now));

    trimBuffer(model, setup.bufferPages);

    if (setup.view && now - model.viewRefreshedAt >= setup.refreshSec * 1000) {
      runRefresh(now);
      log(`View refreshed: every total is current again, for the next ${setup.refreshSec} s`, 'ok');
    }

    const arrivals = sampleArrivals(setup.reads, dt);
    const share = visualShare(setup.reads + setup.writes, ANIMATED_PER_SECOND);
    for (let index = 0; index < arrivals; index += 1) {
      const result = read(model, setup, now);
      const app = APPS[result.instance];
      current.reads.add(1, now);
      current.instanceReads[result.instance].add(1, now);
      if (result.stale) current.stale.add(1, now);
      if (result.staleFrom === 'view') current.staleFromView.add(1, now);

      let outcome: RequestOutcome;
      let route: string[];
      if (result.localHit) {
        current.localHits.add(1, now);
        current.instanceHits[result.instance].add(1, now);
        current.latency.push(LOCAL_HIT_MS, now);
        outcome = result.stale ? 'warning' : 'cache-hit';
        route = ['users', 'lb', app];
      } else {
        current.dbQueries.add(1, now);
        current.pageReads.add(result.pagesRead, now);
        current.diskReads.add(result.pagesFromDisk, now);
        current.work.add(result.workMs, now);
        const timedOut = Math.random() < load.errorRate;
        if (timedOut) current.timeouts.add(1, now);
        current.latency.push(NETWORK_MS + result.workMs * load.latencyMs, now);
        outcome = timedOut ? 'failure' : result.stale ? 'warning' : 'success';
        route = ['users', 'lb', app, 'engine', 'buffer'];
        if (result.pagesFromDisk > 0) route.push(result.usedView ? 'view' : 'orders');
      }
      if (Math.random() < share) spawn(route, outcome);
    }

    const orders = sampleArrivals(setup.writes, dt);
    for (let index = 0; index < orders; index += 1) {
      const result = write(model);
      current.work.add(result.workMs, now);
      if (Math.random() < share) spawn(['users', 'lb', APPS[result.instance], 'engine', 'buffer'], 'success');
    }

    expireLocals(model, now);

    const { alive } = advanceParticles(current.particles, dt);
    current.particles = alive.length > PARTICLE_BUDGET ? alive.slice(-PARTICLE_BUDGET) : alive;

    const reads = current.reads.rate(now);
    const pages = current.pageReads.rate(now);
    push(
      {
        localHit: reads ? (current.localHits.rate(now) / reads) * 100 : NaN,
        bufferHit: pages ? (1 - current.diskReads.rate(now) / pages) * 100 : NaN,
        stale: reads ? (current.stale.rate(now) / reads) * 100 : NaN,
        latency: current.latency.snapshot(now).avg ?? NaN,
      },
      now,
    );

    if (load.saturated && now - current.lastOverloadLog > 4000) {
      current.lastOverloadLog = now;
      log('Database over capacity: queries queue up and some time out', 'danger');
    }

    rerender();
  });

  // Everything below reads the model; nothing here writes to it.
  const current = state.current;
  const { model } = current;
  const now = performance.now();
  const readRate = current.reads.rate(now);
  const localHitRate = readRate ? current.localHits.rate(now) / readRate : 0;
  const staleRate = readRate ? current.stale.rate(now) / readRate : 0;
  const staleFromView = readRate ? current.staleFromView.rate(now) / readRate : 0;
  const pageRate = current.pageReads.rate(now);
  const diskRate = current.diskReads.rate(now);
  const bufferHitRatio = pageRate ? 1 - diskRate / pageRate : null;
  const dbQps = current.dbQueries.rate(now);
  const timeouts = current.timeouts.rate(now);
  const load = dbLoadFor(current.work.rate(now));
  const snapshot = current.latency.snapshot(now);
  const disagreements = setup.localCache ? hotDisagreements(model, now) : 0;
  const viewAge = Math.max(0, (now - model.viewRefreshedAt) / 1000);
  let staleViewRows = 0;
  if (setup.view) for (let product = 0; product < PRODUCTS; product += 1) if (model.viewVersion[product] < model.version[product]) staleViewRows += 1;

  const particleViews: ParticleView[] = current.particles.map((particle) => ({
    id: particle.id,
    from: particle.route[particle.leg],
    to: particle.route[particle.leg + 1],
    t: particle.t,
    outcome: particle.outcome ?? 'success',
  }));

  const edges: DiagramEdge[] = [
    { from: 'users', to: 'lb', tone: 'brand', width: 2 },
    ...APPS.map((app): DiagramEdge => ({ from: 'lb', to: app, tone: 'brand' })),
    ...APPS.map((app): DiagramEdge => ({ from: app, to: 'engine', tone: 'violet' })),
    { from: 'engine', to: 'buffer', tone: 'ok' },
    // Base-table pages come from disk only while the view is off; the refresh still reads them.
    { from: 'buffer', to: 'orders', tone: 'muted', dashed: true, faded: setup.view },
    { from: 'buffer', to: 'view', tone: 'muted', dashed: true, faded: !setup.view },
  ];

  return (
    <LabShell
      title="Cache Layers Lab"
      description="One product page, read through three cache layers: the in-process cache of each app instance, the database buffer pool, and a materialized view. Switch each one on or off."
      running={running}
      onRunningChange={setRunning}
      onReset={reset}
      legend={
        <div className="space-y-1.5">
          <ParticleLegend outcomes={['cache-hit', 'success', 'warning', 'failure']} />
          <p className="text-[11px] text-faint">
            Diamond: answered from the in-process cache. Circle: a database read or a new order. Triangle: a stale
            read - the reader got an older total than the orders table holds. Cross: timed out.
          </p>
        </div>
      }
      events={events}
      insight={
        <Insight>
          {insightFor({
            setup,
            saturated: load.saturated,
            localHitRate,
            staleRate,
            staleFromView,
            disagreements,
            bufferHitRatio,
          })}
        </Insight>
      }
      metrics={
        <>
          <MetricsPanel
            items={[
              {
                key: 'localHit',
                label: 'In-process hits',
                value: setup.localCache ? formatPercent(localHitRate) : 'off',
                tone: setup.localCache ? 'ok' : 'neutral',
                hint: 'Share of reads answered from the memory of the app instance, with no database query.',
              },
              {
                key: 'bufferHit',
                label: 'Buffer pool hit ratio',
                value: bufferHitRatio === null ? '-' : formatPercent(bufferHitRatio, 1),
                tone: bufferHitRatio === null ? 'neutral' : bufferHitRatio >= 0.99 ? 'ok' : bufferHitRatio >= 0.95 ? 'warn' : 'danger',
                hint: 'Share of page reads found in RAM. Over 99% is healthy; under 95% is worth a look.',
              },
              { key: 'dbQueries', label: 'DB queries', value: formatNumber(dbQps), unit: '/s', tone: load.saturated ? 'danger' : 'neutral' },
              {
                key: 'latency',
                label: 'Avg latency',
                value: formatMs(snapshot.avg),
                hint: 'Fixed costs per layer plus a queueing model of the database.',
                simulated: true,
              },
              {
                key: 'stale',
                label: 'Stale reads',
                value: formatPercent(staleRate, 1),
                tone: staleRate > 0.05 ? 'warn' : 'ok',
                hint: 'Reads that returned an older units-sold total than the orders table holds right now.',
              },
              {
                key: 'disagree',
                label: 'Instances disagree',
                value: setup.localCache ? `${disagreements} of ${HOT_PRODUCTS}` : '-',
                tone: disagreements > 0 ? 'warn' : 'neutral',
                hint: `Of the ${HOT_PRODUCTS} most read products, how many have live copies with different totals on different instances.`,
              },
              ...(timeouts > 0
                ? [{ key: 'failed', label: 'Timeouts', value: formatNumber(timeouts), unit: '/s', tone: 'danger' as const, simulated: true }]
                : []),
            ]}
          />
          <div className="card p-4">
            <p className="label mb-3">Hit rates and stale reads (%)</p>
            <LiveChart
              data={points}
              series={[
                { key: 'localHit', label: 'In-process hits', color: 'ok' },
                { key: 'bufferHit', label: 'Buffer pool hits', color: 'info' },
                { key: 'stale', label: 'Stale reads', color: 'warn' },
              ]}
              variant="line"
              height={160}
              yDomain={[0, 100]}
            />
            <p className="mt-2 text-xs text-faint">
              {SIMULATED_HINT} A toy database of {formatNumber(PRODUCTS)} products whose orders
              fill {formatNumber(BASE_PAGES)} pages of {PAGE_KB} KB ({pagesAsMb(BASE_PAGES)}), {PAGES_PER_PRODUCT} pages
              per product, and a view of {VIEW_PAGES} pages. Costs are fixed: about {LOCAL_HIT_MS} ms for an in-process
              hit, {NETWORK_MS} ms network to the database, and a page from disk 40 times slower than one from RAM.
              CPU and disk are pooled into one database capacity.
            </p>
          </div>
        </>
      }
      controls={
        <>
          <p className="label">App instances</p>
          <Toggle
            label="In-process cache"
            checked={setup.localCache}
            onChange={(value) => {
              change('localCache')(value);
              log(
                value
                  ? `In-process cache on: each of the ${INSTANCES} instances keeps its own copy`
                  : 'In-process cache off: every read queries the database',
                value ? 'ok' : 'warn',
              );
            }}
            description={`An LRU map of up to ${LOCAL_CAPACITY} totals inside each instance`}
          />
          <Slider
            label="Local TTL"
            value={setup.localTtl}
            min={1}
            max={60}
            onChange={change('localTtl')}
            disabled={!setup.localCache}
            format={(value) => `${value} s`}
            hint="How long a local copy is used before the instance asks the database again. It is also the longest a copy can stay stale."
          />
          <button
            type="button"
            disabled={!setup.localCache}
            onClick={() => {
              for (const local of model.locals) local.clear();
              log('Deploy: every instance restarted with an empty in-process cache', 'warn');
            }}
            className="w-full rounded-xl border border-line px-3 py-2 text-xs font-medium text-muted transition-colors hover:border-brand/50 hover:text-ink disabled:opacity-40"
          >
            Deploy the app (empty local caches)
          </button>

          <p className="label pt-2">Database</p>
          <Slider
            label="Buffer pool"
            value={setup.bufferPages}
            min={500}
            max={24000}
            step={500}
            onChange={change('bufferPages')}
            format={(value) => `${formatNumber(value)} pages`}
            hint={`Pages of ${PAGE_KB} KB the database keeps in RAM (${pagesAsMb(setup.bufferPages)} here). The orders table is ${formatNumber(BASE_PAGES)} pages.`}
          />
          <Toggle
            label="Materialized view"
            checked={setup.view}
            onChange={(value) => {
              change('view')(value);
              if (value) {
                runRefresh(performance.now());
                log(`View created: totals per product precomputed in ${VIEW_PAGES} pages`, 'ok');
              } else log('View dropped: every read sums the order rows again', 'warn');
            }}
            description="Read one precomputed total instead of summing the order rows"
          />
          <Slider
            label="View refresh every"
            value={setup.refreshSec}
            min={5}
            max={120}
            step={5}
            onChange={change('refreshSec')}
            disabled={!setup.view}
            format={(value) => `${value} s`}
            hint="Between two refreshes the view does not see new orders. Each refresh recomputes every total."
          />
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => {
                model.buffer.clear();
                log('Database restarted: the buffer pool is empty and every page comes from disk', 'warn');
              }}
              className="rounded-xl border border-danger/40 px-3 py-2 text-xs font-medium text-danger transition-colors hover:bg-danger/10"
            >
              Restart database
            </button>
            <button
              type="button"
              disabled={!setup.view}
              onClick={() => {
                runRefresh(performance.now());
                log('View refreshed by hand', 'ok');
              }}
              className="rounded-xl border border-line px-3 py-2 text-xs font-medium text-muted transition-colors hover:border-brand/50 hover:text-ink disabled:opacity-40"
            >
              Refresh view now
            </button>
          </div>

          <p className="label pt-2">Traffic</p>
          <Slider
            label="Reads"
            value={setup.reads}
            min={100}
            max={3000}
            step={100}
            onChange={change('reads')}
            format={(value) => `${formatNumber(value)}/s`}
            hint="Product page reads per second, sent round robin to the instances."
          />
          <Slider
            label="New orders"
            value={setup.writes}
            min={0}
            max={50}
            onChange={change('writes')}
            format={(value) => `${value}/s`}
            hint="Each order changes the units-sold total of one product. The instance that takes it drops its own copy; the others are not told."
          />
        </>
      }
    >
      <DiagramCanvas layout={LAYOUT} edges={edges} particles={particleViews} height={520} className="bg-canvas">
        <ArchNode kind="client" title="Users" subtitle={`${formatNumber(setup.reads)} reads/s`} placed={LAYOUT.users} compact />
        <ArchNode kind="load-balancer" title="Load balancer" subtitle="2 nodes, round robin" placed={LAYOUT.lb} compact />
        {APPS.map((app, index) => {
          const reads = current.instanceReads[index].rate(now);
          const hits = current.instanceHits[index].rate(now);
          const stale = setup.localCache ? staleEntries(model, index, now) : 0;
          const localHitRate = setup.localCache && reads ? hits / reads : null;
          return (
            <ArchNode
              key={app}
              kind="server"
              title={`App ${index + 1}`}
              subtitle={setup.localCache ? `in-process LRU, TTL ${setup.localTtl} s` : 'no local cache'}
              placed={LAYOUT[app]}
              alert={stale > 0}
              compact
            >
              <NodeStatRow
                label="Local hits"
                value={localHitRate === null ? '-' : formatPercent(localHitRate)}
                tone={
                  localHitRate === null
                    ? 'text-ink'
                    : localHitRate > 0.8
                      ? 'text-ok'
                      : localHitRate > 0.5
                        ? 'text-warn'
                        : 'text-danger'
                }
              />
              <NodeStatRow label="Entries" value={setup.localCache ? `${model.locals[index].size} / ${LOCAL_CAPACITY}` : '-'} />
              <NodeStatRow label="Stale copies" value={setup.localCache ? stale : '-'} tone={stale > 0 ? 'text-warn' : 'text-ink'} />
            </ArchNode>
          );
        })}
        <ArchNode
          kind="sql"
          title="Query engine"
          subtitle="prepared plans reused"
          placed={LAYOUT.engine}
          alert={load.saturated}
          status={load.errorRate > 0.05 ? 'degraded' : 'healthy'}
          compact
        >
          <Meter label="Load" value={load.cpu} size="xs" />
          <NodeStatRow label="Queries" value={`${formatNumber(dbQps)}/s`} />
          <NodeStatRow label="Reads" value={setup.view ? 'sales_view' : 'SUM over orders'} />
        </ArchNode>
        <ArchNode
          kind="storage"
          title="Orders table"
          subtitle="on disk"
          placed={LAYOUT.orders}
          compact
        >
          <NodeStatRow label="Size" value={`${formatNumber(BASE_PAGES)} pages`} />
          <NodeStatRow label="Disk reads" value={setup.view ? '-' : `${formatNumber(diskRate)}/s`} />
        </ArchNode>
        <ArchNode
          kind="cache"
          title="Buffer pool"
          subtitle={`RAM, ${pagesAsMb(setup.bufferPages)}`}
          placed={LAYOUT.buffer}
          alert={bufferHitRatio !== null && bufferHitRatio < 0.95}
          compact
        >
          <Meter label="Filled" value={clamp(model.buffer.size / setup.bufferPages, 0, 1)} tone="info" size="xs" />
          <NodeStatRow
            label="Hit ratio"
            value={bufferHitRatio === null ? '-' : formatPercent(bufferHitRatio, 1)}
            tone={bufferHitRatio !== null && bufferHitRatio < 0.95 ? 'text-danger' : 'text-ok'}
          />
          <NodeStatRow label="Pages" value={`${formatNumber(model.buffer.size)} / ${formatNumber(setup.bufferPages)}`} />
        </ArchNode>
        <ArchNode
          kind="storage"
          title="Sales view"
          subtitle="materialized, on disk"
          placed={LAYOUT.view}
          status={setup.view ? 'healthy' : 'down'}
          statusLabel={setup.view ? undefined : 'Not used'}
          compact
        >
          <NodeStatRow label="Refreshed" value={setup.view ? `${Math.floor(viewAge)} s ago` : '-'} />
          <NodeStatRow
            label="Stale rows"
            value={setup.view ? `${staleViewRows} / ${PRODUCTS}` : '-'}
            tone={staleViewRows > 0 ? 'text-warn' : 'text-ink'}
          />
        </ArchNode>
      </DiagramCanvas>
    </LabShell>
  );
}

interface InsightInput {
  setup: Setup;
  saturated: boolean;
  localHitRate: number;
  staleRate: number;
  staleFromView: number;
  disagreements: number;
  bufferHitRatio: number | null;
}

function insightFor({ setup, saturated, localHitRate, staleRate, staleFromView, disagreements, bufferHitRatio }: InsightInput) {
  if (saturated) {
    return (
      <>
        The database is over capacity, so queries wait in line and some time out. Each layer takes work away: a
        bigger buffer pool turns disk reads into memory reads, the view replaces summing {PAGES_PER_PRODUCT} pages
        with reading one row, and the in-process cache stops the query from being sent at all.
      </>
    );
  }
  if (setup.localCache) {
    return (
      <>
        {formatPercent(localHitRate)} of reads never leave the app instance - no network, no query. But each of the{' '}
        {INSTANCES} instances has its own copy: right now they disagree on {disagreements} of the {HOT_PRODUCTS} most
        read products, so a user who refreshes the page can see the total go down and back up as the load balancer
        picks another instance. {formatPercent(staleRate, 1)} of reads were stale. A shorter local TTL narrows the
        window; it costs hit rate.
      </>
    );
  }
  if (setup.view) {
    return (
      <>
        Each read now touches 1 page of the view instead of {PAGES_PER_PRODUCT} pages of the orders table, so the whole
        view ({VIEW_PAGES} pages) stays in the buffer pool and the database does a fraction of the work. The price is
        freshness: the view is only as current as its last refresh, and {formatPercent(staleFromView, 1)} of reads got
        an old total. Hot products get the most orders, so they go stale first. Turn the view off to see what it
        saves at a buffer pool of {formatNumber(setup.bufferPages)} pages.
      </>
    );
  }
  if (bufferHitRatio !== null && bufferHitRatio < 0.99) {
    return (
      <>
        Only {formatPercent(bufferHitRatio, 1)} of page reads are found in RAM: the pages the product pages need do not
        fit in a buffer pool of {formatNumber(setup.bufferPages)} pages, so the rest come from disk, about 40 times
        slower here. Nothing in the code changed - the working set outgrew memory. Raise the buffer pool, or turn on
        the view to shrink the working set to {VIEW_PAGES} pages.
      </>
    );
  }
  return (
    <>
      The working set fits: almost every page is found in the buffer pool and no read waits for disk. This is the
      cache the database already runs for you. Adding another cache in front of it now buys less and adds staleness.
    </>
  );
}

export default CacheLayersLab;
