import { useCallback, useRef, useState } from 'react';
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
import { Insight, LabShell, MetricsPanel, RequestInspector } from '@/components/learning';
import { Meter, SegmentedControl, Slider, Toggle } from '@/components/ui';
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
import type { LabFocus, LabProps, SimulatedRequest } from '@/types';
import { useLabRunning } from '@/hooks/useLabRunning';

/**
 * Simplified numbers, chosen to match the table in the Caching Lesson (hit 1 ms,
 * miss 50 ms): a Redis GET is microseconds of work plus a network hop inside the
 * data centre, and the database query is a typical uncached read. The database
 * latency then grows with load through the computeLoad queueing model.
 */
const CACHE_LATENCY = 1;
const DB_BASE_LATENCY = 50;
const DB_CAPACITY = 900;

/** Requests animated per second, independent of how much traffic is counted. */
const ANIMATED_PER_SECOND = 45;
const PARTICLE_BUDGET = 110;
/** Sized above PARTICLE_BUDGET so no visible particle outlives its record. */
const INSPECTABLE_REQUESTS = 140;

const LAYOUT: Layout = {
  users: { x: 60, y: 210, w: 150, h: 74 },
  api: { x: 280, y: 200, w: 170, h: 94 },
  cache: { x: 520, y: 30, w: 210, h: 204 },
  db: { x: 520, y: 290, w: 210, h: 160 },
};

const EDGES: DiagramEdge[] = [
  { from: 'users', to: 'api', tone: 'brand', width: 2 },
  { from: 'api', to: 'cache', tone: 'ok' },
  // Cache-aside: on a miss the API itself queries the database and then stores
  // the row. A cache -> db edge would describe read-through instead, which the
  // Cache Strategies lab teaches as a different pattern.
  { from: 'api', to: 'db', tone: 'violet', label: 'on miss' },
];

/**
 * The two Redis maxmemory policies the lab models. allkeys-lru is the usual
 * choice for a cache; noeviction is the Redis default, and it refuses new writes
 * once memory is full instead of making room.
 */
type EvictionPolicy = 'allkeys-lru' | 'noeviction';

interface Setup {
  enabled: boolean;
  traffic: number;
  ttl: number;
  /** maxmemory, counted in keys: the lab treats every value as the same size. */
  size: number;
  keyspace: number;
  skew: number;
  policy: EvictionPolicy;
}

/** What the lab opens on at /labs/caching, with no Lab focus. */
const DEFAULT_SETUP: Setup = {
  enabled: true,
  traffic: 1000,
  ttl: 60,
  size: 100,
  keyspace: 500,
  skew: 0.6,
  policy: 'allkeys-lru',
};

/**
 * The Lab focus of each Concept that hosts this lab.
 *
 * Caching opens on a cache that holds the hottest 100 of 500 keys: about 60% of
 * requests hit and 40% miss, so both paths are on screen at once.
 *
 * Redis opens on its memory limit: 150 keys of room for 2,000 distinct keys and
 * a 10 s TTL, so the Memory meter is full, evictions climb and entries expire -
 * and switching the policy to noeviction shows what the Redis default does.
 */
const FOCUS_SETUPS: Record<LabFocus<'caching'>, Setup> = {
  // The same as the default today, on purpose: spelled out so it stays a hit-and-miss mix if the default moves.
  caching: { ...DEFAULT_SETUP },
  redis: { ...DEFAULT_SETUP, ttl: 10, size: 150, keyspace: 2000, policy: 'allkeys-lru' },
};

const POLICIES: { value: EvictionPolicy; label: string }[] = [
  { value: 'allkeys-lru', label: 'allkeys-lru' },
  { value: 'noeviction', label: 'noeviction' },
];

interface CacheEntry {
  key: string;
  expiresAt: number;
  lastUsed: number;
}

interface State {
  entries: Map<string, CacheEntry>;
  particles: Particle[];
  requests: Map<number, SimulatedRequest>;
  /**
   * Rolling rather than cumulative. A lifetime hit rate barely moves once the
   * simulation has been running for a minute, so raising the TTL or the cache
   * size appeared to do nothing - which is the opposite of the lesson.
   */
  hits: RateCounter;
  misses: RateCounter;
  evictions: number;
  expired: number;
  /** SETs refused because memory was full under noeviction (Redis answers with an OOM error). */
  rejected: number;
  lastOomLog: number;
  dbQueries: RateCounter;
  latency: MetricWindow;
}

const createState = (): State => ({
  entries: new Map(),
  particles: [],
  requests: new Map(),
  hits: new RateCounter(3000),
  misses: new RateCounter(3000),
  evictions: 0,
  expired: 0,
  rejected: 0,
  lastOomLog: -Infinity,
  dbQueries: new RateCounter(2000),
  latency: new MetricWindow(400),
});

/**
 * Zipf-ish key selection: a small number of keys account for most requests,
 * which is what makes caching work in the real world.
 */
function pickKey(keyspace: number, skew: number) {
  const random = Math.random() ** (1 + skew * 4);
  return `product:${Math.floor(random * keyspace) + 1}`;
}

export function CachingLab({ focus }: LabProps<'caching'>) {
  // The page keys this lab by Concept, so the focus never changes under a mounted lab.
  const start = focus ? FOCUS_SETUPS[focus] : DEFAULT_SETUP;
  // Every control lives in one object, so Reset cannot miss one.
  const { setup, setSetup, change } = useLabSetup(start);
  const { enabled, traffic, ttl, size, keyspace, skew, policy } = setup;

  const [running, setRunning] = useLabRunning();
  const [inspected, setInspected] = useState<SimulatedRequest | null>(null);

  const state = useRef<State>(createState());
  const rerender = useRerender(30);
  const { events, log, clear } = useEventLog();
  const { points, push, reset: resetSeries } = useSeries(50, 500);

  const reset = useCallback(() => {
    // Back to this Concept's starting setup, not the lab's global default.
    setSetup(start);
    state.current = createState();
    clear();
    resetSeries();
    setInspected(null);
  }, [start, clear, resetSeries, setSetup]);

  const flush = useCallback(() => {
    state.current.entries.clear();
    log('Cache flushed (FLUSHALL) - every request now misses until it warms up again', 'warn');
    rerender();
  }, [log, rerender]);

  useTicker(running, (dt) => {
    const current = state.current;
    const now = performance.now();
    const dbLoad = computeLoad(current.dbQueries.rate(now), DB_CAPACITY, { baseLatencyMs: DB_BASE_LATENCY, kneeAt: 0.6 });

    // Every request is counted, so the database sees the traffic the slider
    // actually asks for. Only a sample of them is animated.
    const arrivals = sampleArrivals(traffic, dt);
    const share = visualShare(traffic, ANIMATED_PER_SECOND);

    // Lowering the memory limit under allkeys-lru makes room at once. Under
    // noeviction Redis never evicts: it only refuses writes until TTLs bring
    // memory back under the limit.
    if (policy === 'allkeys-lru') {
      while (current.entries.size > size) {
        const lru = current.entries.keys().next().value;
        if (lru === undefined) break;
        current.entries.delete(lru);
        current.evictions += 1;
      }
    }

    for (let index = 0; index < arrivals; index += 1) {
      const key = pickKey(keyspace, skew);
      const entry = current.entries.get(key);
      const fresh = Boolean(entry && entry.expiresAt > now);
      const hit = enabled && fresh;

      let latency: number;
      let note: string;
      let stored = false;

      if (hit && entry) {
        current.hits.add(1, now);
        entry.lastUsed = now;
        // A Map iterates in insertion order, so re-inserting the key moves it
        // to the most-recently-used end. That turns eviction below into an O(1)
        // lookup instead of a scan of every entry on every miss.
        current.entries.delete(key);
        current.entries.set(key, entry);
        latency = CACHE_LATENCY * (0.8 + Math.random() * 0.5);
        note = 'Cache HIT - no database query';
      } else {
        current.misses.add(1, now);
        current.dbQueries.add(1, now);
        // With the cache off there is no cache lookup to pay for first.
        latency = (enabled ? CACHE_LATENCY : 0) + dbLoad.latencyMs * (0.8 + Math.random() * 0.5);
        note = enabled ? 'Cache MISS - loaded from the database' : 'Cache disabled - straight to the database';
        if (enabled) {
          if (entry) {
            // Found but past its TTL: Redis deletes an expired key when it is touched.
            current.entries.delete(key);
            current.expired += 1;
          }
          if (current.entries.size >= size) {
            if (policy === 'allkeys-lru') {
              const lru = current.entries.keys().next().value;
              if (lru !== undefined) {
                current.entries.delete(lru);
                current.evictions += 1;
              }
            }
          }
          if (current.entries.size < size) {
            current.entries.set(key, { key, expiresAt: now + ttl * 1000, lastUsed: now });
            stored = true;
          } else {
            // noeviction and full: the SET fails with an OOM error. Cache-aside
            // still answers from the database, it just cannot cache the row.
            current.rejected += 1;
            note = 'Cache MISS - loaded from the database, but the SET was refused (OOM, noeviction)';
            if (now - current.lastOomLog > 2500) {
              current.lastOomLog = now;
              log('Redis at maxmemory with noeviction - SET refused with an OOM error, the row is not cached', 'warn');
            }
          }
        }
      }

      current.latency.push(latency, now);

      if (Math.random() >= share) continue;

      const particleId = nextParticleId();
      current.particles.push({
        id: particleId,
        route: hit
          ? ['users', 'api', 'cache']
          : enabled
            ? ['users', 'api', 'cache', 'api', 'db']
            : ['users', 'api', 'db'],
        leg: 0,
        t: 0,
        speed: 1.3 + Math.random() * 0.3,
        outcome: hit ? 'cache-hit' : dbLoad.saturated ? 'warning' : 'success',
      });

      if (current.requests.size > INSPECTABLE_REQUESTS) {
        const oldest = current.requests.keys().next().value;
        if (oldest !== undefined) current.requests.delete(oldest);
      }
      current.requests.set(particleId, {
        id: particleId,
        createdAt: now,
        currentNode: hit ? 'cache' : 'db',
        status: 'completed',
        outcome: hit ? 'cache-hit' : 'success',
        latency,
        path: hit
          ? ['Client', 'API', 'Redis (HIT)']
          : enabled
            ? ['Client', 'API', 'Redis (MISS)', 'API', 'PostgreSQL', 'API', stored ? 'Redis (SET)' : 'Redis (SET refused)']
            : ['Client', 'API', 'PostgreSQL'],
        method: 'GET',
        endpoint: `/api/${key.replace(':', '/')}`,
        notes: [note, `Key: ${key}`, `TTL: ${ttl}s`, `Policy: ${policy}`],
      });
    }

    // Expire entries so the Keys and Memory figures stay honest. Redis does the
    // same with lazy expiry on access plus a background sweep.
    for (const [key, entry] of current.entries) {
      if (entry.expiresAt <= now) {
        current.entries.delete(key);
        current.expired += 1;
      }
    }

    const { alive } = advanceParticles(current.particles, dt);
    current.particles = alive.length > PARTICLE_BUDGET ? alive.slice(-PARTICLE_BUDGET) : alive;

    const served = current.hits.rate(now) + current.misses.rate(now);
    push(
      {
        hitRate: served ? (current.hits.rate(now) / served) * 100 : 0,
        dbQps: current.dbQueries.rate(now),
        // NaN breaks the chart line while nothing is served, instead of a fake 0 ms.
        latency: current.latency.snapshot(now).avg ?? NaN,
      },
      now,
    );

    if (dbLoad.saturated && Math.random() < dt) {
      log(`Database over capacity: ${formatNumber(current.dbQueries.rate(now))} queries/sec`, 'danger');
    }

    rerender();
  });

  const current = state.current;
  const now = performance.now();
  const servedQps = current.hits.rate(now) + current.misses.rate(now);
  const hitRate = servedQps ? current.hits.rate(now) / servedQps : 0;
  const dbQps = current.dbQueries.rate(now);
  const dbLoad = computeLoad(dbQps, DB_CAPACITY, { baseLatencyMs: DB_BASE_LATENCY, kneeAt: 0.6 });
  const snapshot = current.latency.snapshot(now);
  const memoryUsed = clamp(current.entries.size / size, 0, 1);
  const full = enabled && current.entries.size >= size;

  const particleViews: ParticleView[] = current.particles.map((particle) => ({
    id: particle.id,
    from: particle.route[particle.leg],
    to: particle.route[particle.leg + 1],
    t: particle.t,
    outcome: particle.outcome ?? 'success',
    onClick: () => {
      const request = current.requests.get(particle.id);
      if (request) setInspected(request);
    },
  }));

  return (
    <LabShell
      title="Caching Lab"
      description="Watch two request paths: a hit that returns from memory, and a miss that pays for the database round trip - then stores the result, if Redis has room for it."
      running={running}
      onRunningChange={setRunning}
      onReset={reset}
      legend={
        <ParticleLegend
          outcomes={[
            'cache-hit',
            { outcome: 'success', label: 'Miss, read from the database' },
            { outcome: 'warning', label: 'Miss, database overloaded' },
          ]}
        />
      }
      events={events}
      insight={
        <Insight>
          {!enabled ? (
            <>
              With the cache off, every one of {formatNumber(traffic)} req/sec becomes a database query. The database
              saturates at about {DB_CAPACITY} queries/sec, after which latency climbs sharply. Turn the cache on and
              watch database load fall by roughly the hit rate.
            </>
          ) : policy === 'noeviction' && full ? (
            <>
              Redis is at its memory limit of {formatNumber(size)} keys with noeviction, the Redis default. It does not
              make room: every SET for a new key fails with an OOM error ({formatNumber(current.rejected)} so far), so
              the cache only learns a key when a TTL frees a slot. Reads still work, because cache-aside falls back to
              the database. For a cache, set maxmemory-policy to allkeys-lru.
            </>
          ) : focus === 'redis' && full ? (
            <>
              Redis is at maxmemory: {formatNumber(size)} keys of room for {formatNumber(keyspace)} distinct keys. With
              allkeys-lru it evicts the least recently used key to store each new one ({formatNumber(current.evictions)}{' '}
              evicted), while the {ttl} s TTL removes entries that went stale ({formatNumber(current.expired)} expired).
              Hit rate is {formatPercent(hitRate)}. Switch the policy to noeviction to see what the Redis default does
              when memory is full.
            </>
          ) : hitRate < 0.5 && servedQps > 50 ? (
            <>
              Hit rate is only {formatPercent(hitRate)}. With {formatNumber(keyspace)} distinct keys and room for{' '}
              {formatNumber(size)}, most requests find nothing cached. Either raise the memory limit, raise the TTL, or
              accept that this access pattern is not cacheable.
            </>
          ) : (
            <>
              At {formatPercent(hitRate)} hit rate the database sees about {formatNumber(dbQps)} queries/sec instead of{' '}
              {formatNumber(traffic)}. Average latency is {formatLatency(snapshot.avg)} - the misses dominate it, which
              is why the last few points of hit rate matter so much.
            </>
          )}
        </Insight>
      }
      metrics={
        <>
          <MetricsPanel
            items={[
              { key: 'hitRate', label: 'Hit rate', value: formatPercent(hitRate), tone: hitRate > 0.8 ? 'ok' : hitRate > 0.5 ? 'warn' : 'danger' },
              { key: 'missRate', label: 'Miss rate', value: formatPercent(1 - hitRate) },
              { key: 'dbQueries', label: 'DB queries', value: formatNumber(dbQps), unit: '/s', tone: dbLoad.saturated ? 'danger' : 'neutral' },
              {
                key: 'latency',
                label: 'Avg latency',
                value: formatLatency(snapshot.avg),
                hint: 'Hit about 1 ms, miss about 50 ms plus queueing in the database, meant to show the shape of the curve.',
                simulated: true,
              },
              {
                key: 'p95',
                label: 'P95 latency',
                value: formatLatency(snapshot.p95),
                hint: '95% of requests finished faster than this.',
                simulated: true,
              },
              { key: 'evictions', label: 'Evicted', value: formatNumber(current.evictions), tone: current.evictions > 0 ? 'warn' : 'neutral' },
              {
                key: 'expired',
                label: 'Expired',
                value: formatNumber(current.expired),
                hint: 'Entries removed because their TTL ran out, not because memory was full.',
              },
              {
                key: 'rejected',
                label: 'SET refused',
                value: formatNumber(current.rejected),
                tone: current.rejected > 0 ? 'danger' : 'neutral',
                hint: 'Writes Redis refused with an OOM error because memory was full and the policy is noeviction.',
              },
            ]}
          />
          <div className="card p-4">
            <p className="label mb-3">Hit rate, database load and latency</p>
            <LiveChart
              data={points}
              series={[{ key: 'hitRate', label: 'Hit rate %', color: 'ok' }]}
              height={140}
              yDomain={[0, 100]}
            />
            <LiveChart
              data={points}
              series={[{ key: 'dbQps', label: 'DB queries/sec', color: 'violet' }]}
              variant="line"
              height={150}
            />
            {/* Latency gets its own axis: next to thousands of queries a second, milliseconds lie flat on the floor. */}
            <LiveChart
              data={points}
              series={[{ key: 'latency', label: 'Avg latency (ms)', color: 'brand' }]}
              variant="line"
              height={120}
            />
          </div>
        </>
      }
      footer={<RequestInspector request={inspected} onClose={() => setInspected(null)} />}
      controls={
        <>
          <Toggle
            label="Cache enabled"
            checked={enabled}
            onChange={(value) => {
              change('enabled')(value);
              log(value ? 'Cache enabled' : 'Cache disabled - all reads go to the database', value ? 'ok' : 'warn');
            }}
            description="Turn off to send every read to the database"
          />
          <Slider
            label="Traffic"
            value={traffic}
            min={100}
            max={5000}
            step={100}
            onChange={change('traffic')}
            format={(value) => `${formatNumber(value)} req/sec`}
          />
          <Slider
            label="TTL"
            value={ttl}
            min={1}
            max={300}
            onChange={change('ttl')}
            format={(value) => `${value} s`}
            hint="How long a cached value stays valid. Longer TTL means higher hit rate and staler data."
          />
          <Slider
            label="Memory limit (maxmemory)"
            value={size}
            min={10}
            max={1000}
            step={10}
            onChange={change('size')}
            format={(value) => `${formatNumber(value)} keys`}
            hint="Simplified: every value is the same size, so the limit is counted in keys. Real Redis counts bytes."
          />
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted">Eviction policy (maxmemory-policy)</p>
            <SegmentedControl
              value={policy}
              size="sm"
              options={POLICIES}
              onChange={(value) => {
                change('policy')(value);
                log(
                  value === 'allkeys-lru'
                    ? 'Policy allkeys-lru - when memory is full, the least recently used key is evicted'
                    : 'Policy noeviction - when memory is full, new writes are refused',
                  'info',
                );
              }}
              className="w-full"
            />
            <p className="text-[11px] leading-snug text-faint">
              allkeys-lru makes room by evicting. noeviction, the Redis default, refuses the write instead. Real Redis
              approximates LRU by sampling a few keys; the lab evicts the exact least recently used one.
            </p>
          </div>
          <Slider
            label="Distinct keys"
            value={keyspace}
            min={20}
            max={5000}
            step={20}
            onChange={change('keyspace')}
            format={(value) => `${formatNumber(value)} keys`}
            hint="Size of the working set. A cache only helps when the hot subset fits."
          />
          <Slider
            label="Access skew"
            value={skew}
            min={0}
            max={1}
            step={0.05}
            onChange={change('skew')}
            format={(value) => (value < 0.2 ? 'uniform' : value > 0.7 ? 'very hot keys' : 'moderate')}
            hint="How concentrated traffic is on popular keys. Real traffic is highly skewed."
          />
          <button
            type="button"
            onClick={flush}
            className="w-full rounded-xl border border-danger/40 px-3 py-2 text-xs font-medium text-danger transition-colors hover:bg-danger/10"
          >
            Flush cache (cold start)
          </button>
        </>
      }
    >
      <DiagramCanvas layout={LAYOUT} edges={EDGES} particles={particleViews} height={492} className="bg-canvas">
        <ArchNode kind="client" title="Users" subtitle={`${formatNumber(traffic)} req/sec`} placed={LAYOUT.users} compact />
        <ArchNode kind="server" title="API" subtitle="cache-aside" placed={LAYOUT.api} compact>
          <NodeStatRow label="Avg" value={formatLatency(snapshot.avg)} />
        </ArchNode>
        <ArchNode
          kind="cache"
          title="Redis"
          subtitle={enabled ? `TTL ${ttl}s - ${policy}` : 'disabled'}
          placed={LAYOUT.cache}
          status={enabled ? (policy === 'noeviction' && full ? 'degraded' : 'healthy') : 'down'}
          statusLabel={enabled ? undefined : 'Off'}
        >
          <Meter label="Memory" value={memoryUsed} size="xs" />
          <NodeStatRow label="Keys" value={`${formatNumber(current.entries.size)} / ${formatNumber(size)}`} />
          <NodeStatRow
            label="Hit rate"
            value={formatPercent(hitRate)}
            tone={hitRate > 0.8 ? 'text-ok' : hitRate > 0.5 ? 'text-warn' : 'text-danger'}
          />
          <NodeStatRow
            label={policy === 'noeviction' ? 'SET refused' : 'Evicted'}
            value={formatNumber(policy === 'noeviction' ? current.rejected : current.evictions)}
            tone={policy === 'noeviction' && current.rejected > 0 ? 'text-danger' : undefined}
          />
          <NodeStatRow label="Hit latency" value={`~${CACHE_LATENCY} ms`} />
        </ArchNode>
        <ArchNode
          kind="sql"
          title="PostgreSQL"
          subtitle={`capacity ${DB_CAPACITY} q/s`}
          placed={LAYOUT.db}
          alert={dbLoad.saturated}
          status={dbLoad.errorRate > 0.1 ? 'degraded' : 'healthy'}
        >
          <Meter label="Load" value={dbLoad.cpu} size="xs" />
          <NodeStatRow label="Queries" value={`${formatNumber(dbQps)}/s`} />
          <NodeStatRow label="Latency" value={formatLatency(dbLoad.latencyMs)} />
        </ArchNode>
      </DiagramCanvas>
    </LabShell>
  );
}

export default CachingLab;
