import { useCallback, useRef } from 'react';
import { Split } from 'lucide-react';
import {
  ArchNode,
  DiagramCanvas,
  NodeStatRow,
  ParticleLegend,
  spread,
  type DiagramEdge,
  type Layout,
  type ParticleView,
} from '@/components/architecture';
import { DistributionBar } from '@/components/charts';
import { Insight, LabShell, MetricsPanel } from '@/components/learning';
import { Meter, Select, Slider, Toggle } from '@/components/ui';
import {
  advanceParticles,
  nextParticleId,
  RateCounter,
  useEventLog,
  useTicker,
  visualShare,
  type Particle,
} from '@/simulations/engine';
import { computeLoad } from '@/simulations/models/load';
import { useLabSetup } from '@/hooks/useLabSetup';
import { useRerender } from '@/hooks/useRerender';
import { clamp, sampleArrivals } from '@/utils/math';
import { formatLatency, formatNumber, formatPercent } from '@/utils/format';
import { useLabRunning } from '@/hooks/useLabRunning';

type ShardKey = 'user-id' | 'country' | 'tenant' | 'created-at';

const SHARD_KEYS: { value: ShardKey; label: string }[] = [
  { value: 'user-id', label: 'Hash of user_id' },
  { value: 'country', label: 'Country' },
  { value: 'tenant', label: 'Tenant id' },
  { value: 'created-at', label: 'Range on created_at' },
];

const KEY_NOTE: Record<ShardKey, string> = {
  'user-id':
    'A hash of user_id spreads both data and traffic evenly, and almost every query already knows the user. The cost: a range query, such as users who signed up last week, must ask every shard.',
  country:
    'Country looks natural but traffic is wildly skewed: one large market can send most of your requests to a single shard while the others idle.',
  tenant:
    'Tenant id keeps each customer on one shard, which makes queries single-shard - but one enormous tenant becomes a hot shard that you cannot split without moving them.',
  'created-at':
    'A range on created_at means every new row lands on the newest shard. Historical shards go cold and the newest one absorbs 100% of writes.',
};

/** Relative traffic weight per shard for each key strategy (4 shards). */
const WEIGHTS: Record<ShardKey, number[]> = {
  'user-id': [0.25, 0.25, 0.25, 0.25],
  country: [0.62, 0.18, 0.12, 0.08],
  tenant: [0.46, 0.24, 0.18, 0.12],
  'created-at': [0.04, 0.08, 0.18, 0.7],
};

/**
 * Share of the 10M rows each shard holds (simplified). Data follows the key
 * too: a big country or a big tenant is a big shard, not only a busy one.
 */
const DATA_SHARE: Record<ShardKey, number[]> = {
  'user-id': [0.25, 0.25, 0.25, 0.25],
  country: [0.55, 0.2, 0.15, 0.1],
  tenant: [0.4, 0.25, 0.2, 0.15],
  'created-at': [0.24, 0.28, 0.3, 0.18],
};

const SHARD_CAPACITY = 900;

/**
 * Queries animated per second. A scatter query emits one particle per shard,
 * so the budget sits well above the steady-state population.
 */
const ANIMATED_PER_SECOND = 40;
const PARTICLE_BUDGET = 130;
const SHARD_LABELS: Record<ShardKey, string[]> = {
  'user-id': ['hash 0-63', 'hash 64-127', 'hash 128-191', 'hash 192-255'],
  country: ['US', 'DE + FR', 'BR + IN', 'rest of world'],
  tenant: ['tenants 1-40', 'tenants 41-120', 'tenants 121-400', 'tenants 401+'],
  'created-at': ['2023', '2024', '2025', '2026 (current)'],
};

interface State {
  particles: Particle[];
  rates: RateCounter[];
  /** Rolling, so the cross-shard slider moves the metric within a window. */
  crossShard: RateCounter;
  total: RateCounter;
}

const createState = (): State => ({
  particles: [],
  rates: [0, 1, 2, 3].map(() => new RateCounter(2000)),
  crossShard: new RateCounter(3000),
  total: new RateCounter(3000),
});

/** Every control of the Lab. Reset returns to this one object, so it cannot miss a control. */
const DEFAULT_SETUP: { sharded: boolean; traffic: number; shardKey: ShardKey; crossShardRatio: number } = {
  sharded: true,
  traffic: 2000,
  shardKey: 'user-id',
  crossShardRatio: 0.05,
};

export function ShardingLab() {
  const [running, setRunning] = useLabRunning();
  const { setup, setSetup, change } = useLabSetup(DEFAULT_SETUP);
  const { sharded, traffic, shardKey, crossShardRatio } = setup;

  const state = useRef<State>(createState());
  const rerender = useRerender(30);
  const { events, log, clear } = useEventLog();

  const reset = useCallback(() => {
    state.current = createState();
    setSetup(DEFAULT_SETUP);
    clear();
  }, [clear, setSetup]);

  const weights = WEIGHTS[shardKey];
  const shardCount = sharded ? 4 : 1;

  useTicker(running, (dt) => {
    const current = state.current;
    const now = performance.now();
    // Every query is counted against shard capacity; only a sample is animated,
    // so the canvas budget cannot cap what the shards are seen to receive.
    const arrivals = sampleArrivals(traffic, dt);
    const share = visualShare(traffic, ANIMATED_PER_SECOND);

    for (let index = 0; index < arrivals; index += 1) {
      current.total.add(1, now);
      const animate = Math.random() < share;

      if (!sharded) {
        current.rates[0].add(1, now);
        if (animate) {
          current.particles.push({
            id: nextParticleId(),
            route: ['client', 'router', 'shard0'],
            leg: 0,
            t: 0,
            speed: 1.3,
            outcome: 'success',
          });
        }
        continue;
      }

      const scatter = Math.random() < crossShardRatio;
      if (scatter) {
        current.crossShard.add(1, now);
        for (let shard = 0; shard < 4; shard += 1) {
          current.rates[shard].add(1, now);
          if (!animate) continue;
          current.particles.push({
            id: nextParticleId(),
            route: ['client', 'router', `shard${shard}`],
            leg: 0,
            t: 0,
            speed: 1.2,
            outcome: 'warning',
          });
        }
        continue;
      }

      const roll = Math.random();
      let cumulative = 0;
      let target = 0;
      for (let shard = 0; shard < weights.length; shard += 1) {
        cumulative += weights[shard];
        if (roll <= cumulative) {
          target = shard;
          break;
        }
      }
      current.rates[target].add(1, now);
      if (!animate) continue;
      current.particles.push({
        id: nextParticleId(),
        route: ['client', 'router', `shard${target}`],
        leg: 0,
        t: 0,
        speed: 1.3 + Math.random() * 0.3,
        outcome: 'success',
      });
    }

    const { alive } = advanceParticles(current.particles, dt);
    current.particles = alive.length > PARTICLE_BUDGET ? alive.slice(-PARTICLE_BUDGET) : alive;

    const hot = current.rates.findIndex((rate) => rate.rate(now) > SHARD_CAPACITY);
    if (hot >= 0 && Math.random() < dt * 0.6) {
      log(`Shard ${String.fromCharCode(65 + hot)} over capacity - hot shard limiting the cluster`, 'danger');
    }

    rerender();
  });

  const current = state.current;
  const now = performance.now();
  const shardRates = current.rates.map((rate) => rate.rate(now));
  const effectiveRates = sharded ? shardRates : [shardRates[0], 0, 0, 0];
  const loads = effectiveRates.map((rate) => computeLoad(rate, SHARD_CAPACITY, { baseLatencyMs: 60, kneeAt: 0.65 }));
  const maxRate = Math.max(...effectiveRates.slice(0, shardCount));
  const avgRate = effectiveRates.slice(0, shardCount).reduce((sum, rate) => sum + rate, 0) / shardCount;
  const skew = avgRate > 0 ? maxRate / avgRate : 1;
  const worstLatency = Math.max(...loads.slice(0, shardCount).map((load) => load.latencyMs));
  const totalQps = current.total.rate(now);
  const crossShardShare = totalQps ? current.crossShard.rate(now) / totalQps : 0;

  const xs = spread(shardCount, 480, sharded ? 190 : 260, 30);
  const layout: Layout = {
    client: { x: 390, y: 14, w: 180, h: 73 },
    router: { x: 370, y: 140, w: 220, h: 128 },
  };
  for (let index = 0; index < shardCount; index += 1) {
    layout[`shard${index}`] = { x: xs[index], y: 330, w: sharded ? 190 : 260, h: 181 };
  }

  const edges: DiagramEdge[] = [
    { from: 'client', to: 'router', tone: 'brand', width: 2 },
    ...Array.from({ length: shardCount }, (_, index) => ({
      from: 'router',
      to: `shard${index}`,
      tone: (effectiveRates[index] > SHARD_CAPACITY ? 'danger' : 'ok') as 'danger' | 'ok',
      width: 1.5 + (avgRate > 0 ? (effectiveRates[index] / Math.max(maxRate, 1)) * 2 : 0),
    })),
  ];

  const particleViews: ParticleView[] = current.particles
    .filter((particle) => layout[particle.route[particle.route.length - 1]])
    .map((particle) => ({
      id: particle.id,
      from: particle.route[particle.leg],
      to: particle.route[particle.leg + 1],
      t: particle.t,
      outcome: particle.outcome ?? 'success',
    }));

  return (
    <LabShell
      title="Database Sharding Lab"
      description="Split 10 million users across shards. Change the shard key and watch a badly chosen one concentrate traffic on a single node."
      running={running}
      onRunningChange={setRunning}
      onReset={reset}
      legend={
        <ParticleLegend
          outcomes={[
            { outcome: 'success', label: 'Query to one shard' },
            { outcome: 'warning', label: 'Scatter-gather query' },
          ]}
        />
      }
      events={events}
      insight={
        <Insight title={sharded ? SHARD_KEYS.find((item) => item.value === shardKey)?.label : 'Single database'}>
          {!sharded ? (
            <>
              One database absorbs all {formatNumber(traffic)} req/sec. Above roughly {SHARD_CAPACITY} req/sec it
              saturates: latency climbs and requests start failing. Turn sharding on to split the data by key.
            </>
          ) : (
            <>
              {KEY_NOTE[shardKey]} Current skew is {skew.toFixed(2)}x - a perfectly balanced key would be 1.00x, and the
              cluster is limited by its hottest shard, not by its average.
            </>
          )}
        </Insight>
      }
      metrics={
        <>
          <MetricsPanel
            items={[
              { key: 'rps', label: 'Traffic', value: formatNumber(traffic), unit: 'req/s', tone: 'brand' },
              { key: 'shards', label: 'Shards', value: shardCount, hint: 'Independent database instances.' },
              {
                key: 'skew',
                label: 'Load skew',
                value: `${skew.toFixed(2)}x`,
                tone: skew > 1.5 ? 'danger' : skew > 1.2 ? 'warn' : 'ok',
                hint: 'Hottest shard divided by the average. 1.00x is perfectly balanced.',
              },
              {
                key: 'hot',
                label: 'Hottest shard',
                value: formatNumber(maxRate),
                unit: 'req/s',
                tone: maxRate > SHARD_CAPACITY ? 'danger' : 'ok',
                hint: 'The shard receiving the most traffic - it sets the cluster limit.',
              },
              {
                key: 'latency',
                label: 'Worst latency',
                value: formatLatency(worstLatency),
                tone: worstLatency > 300 ? 'danger' : 'neutral',
                hint: 'Latency on the slowest shard, from a queueing model capped at 4 s.',
                simulated: true,
              },
              {
                key: 'crossShard',
                label: 'Cross-shard',
                value: formatPercent(crossShardShare, 1),
                tone: crossShardShare > 0.15 ? 'warn' : 'ok',
                hint: 'Queries that must scatter to every shard and gather the results.',
              },
            ]}
          />
          <div className="card p-4">
            <p className="label mb-3">Traffic per shard</p>
            <DistributionBar
              items={Array.from({ length: shardCount }, (_, index) => ({
                label: sharded ? `Shard ${String.fromCharCode(65 + index)}` : 'Single DB',
                value: effectiveRates[index],
                ratio: clamp(effectiveRates[index] / SHARD_CAPACITY, 0, 1),
                hot: effectiveRates[index] > SHARD_CAPACITY,
                suffix: 'req/s',
              }))}
              formatValue={(value) => formatNumber(value)}
            />
            <p className="mt-3 text-xs text-faint">
              Each shard absorbs about {SHARD_CAPACITY} req/sec in this simplified model. Adding shards only helps if the
              key spreads traffic - a hot shard means the extra nodes sit idle.
            </p>
          </div>
        </>
      }
      controls={
        <>
          <Toggle
            label="Sharding enabled"
            checked={sharded}
            onChange={(value) => {
              change('sharded')(value);
              state.current = createState();
              log(value ? 'Sharding enabled - router active' : 'Sharding disabled - single database', 'info');
            }}
            description="Off: one database holds all 10M users"
          />
          <Slider
            label="Traffic"
            value={traffic}
            min={200}
            max={8000}
            step={100}
            onChange={change('traffic')}
            format={(value) => `${formatNumber(value)} req/sec`}
          />
          <Select
            label="Shard by"
            value={shardKey}
            options={SHARD_KEYS}
            onChange={(value) => {
              change('shardKey')(value);
              state.current = createState();
              log(`Shard key: ${SHARD_KEYS.find((item) => item.value === value)?.label}`, 'info');
            }}
            hint="The column that decides which shard owns a row."
          />
          <Slider
            label="Cross-shard queries"
            value={crossShardRatio}
            min={0}
            max={0.4}
            step={0.01}
            onChange={change('crossShardRatio')}
            format={(value) => formatPercent(value, 0)}
            tone={crossShardRatio > 0.15 ? 'danger' : 'warn'}
            hint="Queries without the shard key must ask every shard and merge the answers."
          />
          <div className="border-t border-line pt-4">
            <p className="label mb-2">Cluster balance</p>
            {Array.from({ length: shardCount }, (_, index) => (
              <Meter
                key={index}
                label={sharded ? `Shard ${String.fromCharCode(65 + index)}` : 'Single DB'}
                value={clamp(effectiveRates[index] / SHARD_CAPACITY, 0, 1)}
                size="xs"
                className="mb-1.5"
              />
            ))}
          </div>
          <div className="flex items-start gap-2 text-[11px] text-muted">
            <Split className="mt-0.5 h-3.5 w-3.5 shrink-0 text-faint" />
            <span>
              Sharding is a one-way door. Try vertical scaling, read replicas, caching and query tuning first - they
              usually buy years of headroom.
            </span>
          </div>
        </>
      }
    >
      <DiagramCanvas layout={layout} edges={edges} particles={particleViews} height={526} className="bg-canvas">
        <ArchNode
          kind="client"
          title="Application"
          subtitle={`${formatNumber(traffic)} req/sec`}
          placed={layout.client}
          compact
        />
        <ArchNode
          kind="api-gateway"
          title={sharded ? 'Shard router' : 'Connection pool'}
          subtitle={sharded ? SHARD_KEYS.find((item) => item.value === shardKey)?.label : 'no routing'}
          placed={layout.router}
        >
          <NodeStatRow label="Shards" value={shardCount} />
          <NodeStatRow
            label="Scatter-gather"
            value={formatPercent(crossShardShare, 1)}
            tone={crossShardShare > 0.15 ? 'text-warn' : 'text-ok'}
          />
        </ArchNode>
        {Array.from({ length: shardCount }, (_, index) => (
          <ArchNode
            key={index}
            kind="sql"
            title={sharded ? `Shard ${String.fromCharCode(65 + index)}` : 'users database'}
            subtitle={sharded ? SHARD_LABELS[shardKey][index] : '10M users'}
            placed={layout[`shard${index}`]}
            alert={effectiveRates[index] > SHARD_CAPACITY}
            status={loads[index].errorRate > 0.2 ? 'degraded' : 'healthy'}
          >
            <Meter label="Load" value={loads[index].cpu} size="xs" />
            <NodeStatRow label="Traffic" value={`${formatNumber(effectiveRates[index])}/s`} />
            <NodeStatRow label="Latency" value={formatLatency(loads[index].latencyMs)} />
            <NodeStatRow
              label="Rows"
              value={sharded ? `${(10 * DATA_SHARE[shardKey][index]).toFixed(1)}M` : '10M'}
            />
          </ArchNode>
        ))}
      </DiagramCanvas>
    </LabShell>
  );
}

export default ShardingLab;
