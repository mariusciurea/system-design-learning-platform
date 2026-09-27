import { useCallback, useRef } from 'react';
import { Eraser, Rocket } from 'lucide-react';
import {
  ArchNode,
  DiagramCanvas,
  NodeStatRow,
  ParticleLegend,
  type DiagramEdge,
  type Layout,
  type ParticleView,
} from '@/components/architecture';
import { DistributionBar, LiveChart } from '@/components/charts';
import { Insight, LabShell, MetricsPanel, SIMULATED_HINT } from '@/components/learning';
import { Button, Meter, SegmentedControl, Select, Slider, Toggle } from '@/components/ui';
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
import { useLabSetup } from '@/hooks/useLabSetup';
import { useRerender } from '@/hooks/useRerender';
import { sampleArrivals } from '@/utils/math';
import { LATENCY_TEXT, formatLatency, formatNumber, formatPercent, latencyTone } from '@/utils/format';
import type { LabFocus, LabProps, RequestOutcome } from '@/types';
import {
  BACKBONE_FACTOR,
  CACHE_CONTROL_OPTIONS,
  CACHE_KEY_OPTIONS,
  CATALOGUE,
  EDGE_CAPACITY,
  ORIGIN_MS,
  REVALIDATE_MS,
  UTM_VARIANTS,
  cacheKeyFor,
  lookup,
  pickObject,
  rtt,
  urlFor,
  type CacheControl,
  type CacheKey,
  type EdgeFootprint,
  type Entry,
} from './cdnModel';
import { useLabRunning } from '@/hooks/useLabRunning';

type EdgeId = 'eu-edge' | 'us-edge' | 'ap-edge';

interface Region {
  id: string;
  name: string;
  edgeId: EdgeId;
  /** Distance from these users to their nearest edge, to the US edge, and to the origin. */
  edgeKm: number;
  usEdgeKm: number;
  originKm: number;
  shareOfTraffic: number;
}

const REGIONS: Region[] = [
  { id: 'eu-users', name: 'Europe', edgeId: 'eu-edge', edgeKm: 300, usEdgeKm: 6000, originKm: 6200, shareOfTraffic: 0.35 },
  { id: 'us-users', name: 'North America', edgeId: 'us-edge', edgeKm: 250, usEdgeKm: 250, originKm: 900, shareOfTraffic: 0.4 },
  { id: 'ap-users', name: 'Asia Pacific', edgeId: 'ap-edge', edgeKm: 400, usEdgeKm: 11200, originKm: 11500, shareOfTraffic: 0.25 },
];

const EDGES: { id: EdgeId; name: string; originKm: number; purgeDelayMs: number }[] = [
  { id: 'eu-edge', name: 'Europe Edge', originKm: 6000, purgeDelayMs: 500 },
  { id: 'us-edge', name: 'US Edge', originKm: 700, purgeDelayMs: 900 },
  { id: 'ap-edge', name: 'Asia Pacific Edge', originKm: 11000, purgeDelayMs: 1800 },
];

const LAYOUT: Layout = {
  origin: { x: 380, y: 12, w: 200, h: 151 },
  'eu-edge': { x: 60, y: 211, w: 190, h: 173 },
  'us-edge': { x: 385, y: 211, w: 190, h: 173 },
  'ap-edge': { x: 710, y: 211, w: 190, h: 173 },
  'eu-users': { x: 75, y: 440, w: 160, h: 94 },
  'us-users': { x: 400, y: 440, w: 160, h: 94 },
  'ap-users': { x: 725, y: 440, w: 160, h: 94 },
};

/** Requests animated per second, independent of how much traffic is counted. */
const ANIMATED_PER_SECOND = 45;
const PARTICLE_BUDGET = 120;

interface Setup {
  cdnEnabled: boolean;
  traffic: number;
  edges: EdgeFootprint;
  cacheControl: CacheControl;
  ttlSec: number;
  cacheKey: CacheKey;
}

/** What the lab opens on at /labs/cdn, with no Lab focus: no CDN yet, three edges ready. */
const DEFAULT_SETUP: Setup = {
  cdnEnabled: false,
  traffic: 2000,
  edges: 'nearby',
  cacheControl: 'immutable',
  ttlSec: 30,
  cacheKey: 'path',
};

/**
 * The Lab focus of each Concept that hosts this lab. CDN opens on distance: the
 * CDN off, so the first thing the learner does is turn it on and watch Asia
 * Pacific drop from about 240 ms to about 13 ms. CDN Caching opens on the cache
 * policy: a short s-maxage on a URL that does not change between deploys, so
 * Deploy shows stale copies and Purge shows the fix and its price.
 */
const FOCUS_SETUPS: Record<LabFocus<'cdn'>, Setup> = {
  cdn: { ...DEFAULT_SETUP, cdnEnabled: false, edges: 'nearby', cacheControl: 'immutable' },
  'cdn-caching': { ...DEFAULT_SETUP, cdnEnabled: true, cacheControl: 'ttl', ttlSec: 30, cacheKey: 'path' },
};

interface EdgeStats {
  store: Map<string, Entry>;
  requests: RateCounter;
  hits: RateCounter;
  stale: RateCounter;
}

interface State {
  particles: Particle[];
  edges: Record<EdgeId, EdgeStats>;
  regionLatency: Record<string, MetricWindow>;
  originRate: RateCounter;
  revalidations: RateCounter;
  totalRate: RateCounter;
  hitRate: RateCounter;
  staleRate: RateCounter;
  latency: MetricWindow;
  /** The deploy the origin currently serves. */
  version: number;
  /** Purges on their way to each edge: a purge reaches locations one by one. */
  pendingPurges: { edgeId: EdgeId; at: number }[];
}

const createEdge = (): EdgeStats => ({
  store: new Map(),
  requests: new RateCounter(2000),
  hits: new RateCounter(2000),
  stale: new RateCounter(2000),
});

const createState = (version = 1): State => ({
  particles: [],
  edges: { 'eu-edge': createEdge(), 'us-edge': createEdge(), 'ap-edge': createEdge() },
  regionLatency: Object.fromEntries(REGIONS.map((region) => [region.id, new MetricWindow(200)])),
  originRate: new RateCounter(2000),
  revalidations: new RateCounter(2000),
  totalRate: new RateCounter(2000),
  hitRate: new RateCounter(2000),
  staleRate: new RateCounter(2000),
  latency: new MetricWindow(500),
  version,
  pendingPurges: [],
});

const regionFor = (roll: number) => {
  let cumulative = 0;
  return (
    REGIONS.find((item) => {
      cumulative += item.shareOfTraffic;
      return roll <= cumulative;
    }) ?? REGIONS[0]
  );
};

export function CdnLab({ focus }: LabProps<'cdn'>) {
  // The page keys this lab by Concept, so the focus never changes under a mounted lab.
  const start = focus ? FOCUS_SETUPS[focus] : DEFAULT_SETUP;
  // Every control lives in one object, so Reset cannot miss one.
  const { setup, setSetup, change } = useLabSetup(start);
  const { cdnEnabled, traffic, edges: footprint, cacheControl, ttlSec, cacheKey } = setup;
  const [running, setRunning] = useLabRunning();
  const state = useRef<State>(createState());
  const rerender = useRerender(30);
  const { events, log, clear } = useEventLog();
  const { points, push, reset: resetSeries } = useSeries(60, 500);

  const reset = useCallback(() => {
    // Back to this Concept's starting setup, not the lab's global default.
    setSetup(start);
    state.current = createState();
    clear();
    resetSeries();
  }, [start, clear, resetSeries, setSetup]);

  const toggleCdn = (value: boolean) => {
    change('cdnEnabled')(value);
    // Keep the deployed version; start the edges empty and the counters fresh.
    state.current = createState(state.current.version);
    resetSeries();
    log(
      value
        ? 'CDN enabled - users are routed to the nearest edge, which starts empty'
        : 'CDN disabled - every request travels to the origin',
      value ? 'ok' : 'warn',
    );
  };

  const changeFootprint = (value: EdgeFootprint) => {
    change('edges')(value);
    // An edge that is taken out of service loses what it held.
    state.current.edges['eu-edge'] = createEdge();
    state.current.edges['ap-edge'] = createEdge();
    log(
      value === 'us-only'
        ? 'Only the US edge is left - Europe and Asia Pacific users now cross an ocean to reach it'
        : 'Edges in Europe and Asia Pacific are back, empty at first',
      value === 'us-only' ? 'warn' : 'ok',
    );
  };

  const deploy = () => {
    const current = state.current;
    current.version += 1;
    log(
      cacheControl === 'immutable'
        ? `Deployed v${current.version} with new hashed URLs - edges fetch each new file once, nothing is stale`
        : cacheControl === 'ttl'
          ? `Deployed v${current.version} at the same URLs - edges keep serving v${current.version - 1} until each copy expires (up to ${ttlSec} s) or you purge`
          : `Deployed v${current.version} - every request already goes to the origin, so users see it at once`,
      cacheControl === 'ttl' ? 'warn' : 'ok',
    );
  };

  const purge = () => {
    const current = state.current;
    const now = performance.now();
    current.pendingPurges = EDGES.map((edge) => ({ edgeId: edge.id, at: now + edge.purgeDelayMs }));
    log('Purge sent to every edge location - it arrives at each one at a different moment', 'info');
  };

  useTicker(running, (dt) => {
    const current = state.current;
    const now = performance.now();

    if (current.pendingPurges.length) {
      const due = current.pendingPurges.filter((purgeItem) => purgeItem.at <= now);
      current.pendingPurges = current.pendingPurges.filter((purgeItem) => purgeItem.at > now);
      for (const purgeItem of due) {
        const edge = EDGES.find((item) => item.id === purgeItem.edgeId);
        const dropped = current.edges[purgeItem.edgeId].store.size;
        current.edges[purgeItem.edgeId].store.clear();
        log(`${edge?.name ?? purgeItem.edgeId} purged: dropped ${formatNumber(dropped)} objects, next requests miss`, 'info');
      }
    }

    // Every request is counted, so "Total traffic" matches the slider above it.
    const arrivals = sampleArrivals(traffic, dt);
    const share = visualShare(traffic, ANIMATED_PER_SECOND);

    for (let index = 0; index < arrivals; index += 1) {
      const region = regionFor(Math.random());
      current.totalRate.add(1, now);

      let latency: number;
      let route: string[];
      let outcome: RequestOutcome;

      if (!cdnEnabled) {
        latency = rtt(region.originKm) + ORIGIN_MS;
        route = [region.id, 'origin'];
        outcome = 'success';
        current.originRate.add(1, now);
      } else {
        const edgeId: EdgeId = footprint === 'nearby' ? region.edgeId : 'us-edge';
        const userKm = footprint === 'nearby' ? region.edgeKm : region.usEdgeKm;
        const edge = EDGES.find((item) => item.id === edgeId) ?? EDGES[1];
        const stats = current.edges[edgeId];
        stats.requests.add(1, now);

        const url = urlFor(pickObject(), current.version, cacheControl);
        const result = lookup(stats.store, cacheKeyFor(url, cacheKey), cacheControl, ttlSec, current.version, now);
        const originLeg = rtt(edge.originKm) * BACKBONE_FACTOR;

        if (result.kind === 'hit') {
          latency = rtt(userKm) + 1;
          route = [region.id, edgeId];
          outcome = result.stale ? 'warning' : 'cache-hit';
          stats.hits.add(1, now);
          current.hitRate.add(1, now);
          if (result.stale) {
            stats.stale.add(1, now);
            current.staleRate.add(1, now);
          }
        } else {
          latency = rtt(userKm) + originLeg + (result.kind === 'revalidated' ? REVALIDATE_MS : ORIGIN_MS);
          route = [region.id, edgeId, 'origin'];
          outcome = 'success';
          current.originRate.add(1, now);
          if (result.kind === 'revalidated') current.revalidations.add(1, now);
        }
      }

      current.regionLatency[region.id].push(latency, now);
      current.latency.push(latency, now);

      if (Math.random() >= share) continue;
      current.particles.push({
        id: nextParticleId(),
        route,
        leg: 0,
        t: 0,
        speed: 0.9 + Math.random() * 0.3,
        outcome,
      });
    }

    const { alive } = advanceParticles(current.particles, dt);
    current.particles = alive.length > PARTICLE_BUDGET ? alive.slice(-PARTICLE_BUDGET) : alive;

    const total = current.totalRate.rate(now);
    push(
      {
        hit: total ? (current.hitRate.rate(now) / total) * 100 : NaN,
        stale: total ? (current.staleRate.rate(now) / total) * 100 : NaN,
      },
      now,
    );
    rerender();
  });

  const current = state.current;
  const now = performance.now();
  const snapshot = current.latency.snapshot(now);
  // Per-region averages over the same MetricWindow horizon; null when a region saw no request (lab paused).
  const regionLatency = (id: string) => current.regionLatency[id].snapshot(now).avg;
  const originQps = current.originRate.rate(now);
  const totalQps = current.totalRate.rate(now);
  const hitShare = totalQps > 0 ? Math.min(1, current.hitRate.rate(now) / totalQps) : 0;
  const staleShare = totalQps > 0 ? Math.min(1, current.staleRate.rate(now) / totalQps) : 0;
  const revalidateQps = current.revalidations.rate(now);
  const offload = totalQps > 0 ? Math.max(0, 1 - originQps / totalQps) : 0;
  const purging = new Set(current.pendingPurges.map((item) => item.edgeId));
  const edgeInUse = (id: EdgeId) => cdnEnabled && (footprint === 'nearby' || id === 'us-edge');
  const originEveryRequest = cacheControl === 'no-store' || cacheControl === 'no-cache';

  const edges: DiagramEdge[] = !cdnEnabled
    ? REGIONS.map<DiagramEdge>((region) => ({
        from: region.id,
        to: 'origin',
        tone: region.originKm > 5000 ? 'warn' : 'brand',
        width: 2,
      }))
    : [
        ...REGIONS.map<DiagramEdge>((region) => ({
          from: region.id,
          to: footprint === 'nearby' ? region.edgeId : 'us-edge',
          tone: footprint === 'nearby' || region.id === 'us-users' ? 'ok' : 'warn',
          width: 2,
        })),
        ...EDGES.filter((edge) => edgeInUse(edge.id)).map<DiagramEdge>((edge) => ({
          from: edge.id,
          to: 'origin',
          tone: originEveryRequest ? 'warn' : 'muted',
          dashed: !originEveryRequest,
          label: originEveryRequest ? 'every request' : 'on miss',
        })),
      ];

  const particleViews: ParticleView[] = current.particles.map((particle) => ({
    id: particle.id,
    from: particle.route[particle.leg],
    to: particle.route[particle.leg + 1],
    t: particle.t,
    outcome: particle.outcome ?? 'success',
  }));

  const farRtt = rtt(11500) + ORIGIN_MS;

  const insight = !cdnEnabled ? (
    <>
      Every request travels to the origin. Asia Pacific users pay about {formatLatency(farRtt)} per request purely in
      network distance - no amount of backend optimisation changes that. Turn the CDN on.
    </>
  ) : footprint === 'us-only' ? (
    <>
      One edge location, next to the origin. Hits are {formatPercent(hitShare)}, yet Europe and Asia Pacific users still
      cross an ocean for every request, so their latency barely moves. A CDN buys distance only where it has an edge
      near the users - switch back to three edge locations.
    </>
  ) : cacheControl === 'no-store' ? (
    <>
      The header private, no-store forbids a shared cache to keep a copy, so every request goes on to the origin and
      the hit rate is 0%. Misses are still a little faster than with no CDN, because the edge keeps warm connections to
      the origin - but the origin carries all the traffic. Right for per-user data, wasteful for public files.
    </>
  ) : cacheControl === 'no-cache' ? (
    <>
      The header no-cache does not mean do not cache: the edge keeps the copy but asks the origin before every use.
      Most answers are a small 304 Not Modified ({formatNumber(revalidateQps)} per second), yet each still costs a trip
      to the origin and the origin sees every request. Right for HTML, far too cautious for hashed files.
    </>
  ) : cacheKey === 'cookie' ? (
    <>
      The Cookie header is in the cache key, and every visitor has a different cookie, so every request looks new: hit
      rate {formatPercent(hitShare)} and the edges fill with copies of the same files. Static files do not vary by
      user - key them on host and path only.
    </>
  ) : staleShare > 0.005 ? (
    <>
      {formatPercent(staleShare)} of responses are still the old version: the URL did not change, so each edge keeps
      serving its copy until it expires - up to {ttlSec} s - or a purge removes it. Press Purge, or switch to hashed
      URLs so a deploy never has to purge at all.
    </>
  ) : cacheKey === 'utm' ? (
    <>
      Every tracking parameter is in the key, so each file exists in up to {UTM_VARIANTS} copies per edge, each one
      fetched from the origin on its own. Hit rate {formatPercent(hitShare)}; ignore utm_ parameters in the key and
      it climbs back.
    </>
  ) : cacheControl === 'ttl' ? (
    <>
      s-maxage={ttlSec}: each edge asks the origin about each file at most once every {ttlSec} s, which gives{' '}
      {formatPercent(hitShare)} hits. Rare files expire before anyone asks again, so a shorter TTL or less traffic
      lowers the hit rate. Press Deploy new version to see what a TTL costs.
    </>
  ) : (
    <>
      Hashed URLs with a one-year max-age: after the first request for each file, {formatPercent(hitShare)} of requests
      are answered at the edge and {formatPercent(offload)} never reach the origin. A deploy changes the URLs, so
      nothing is ever stale and nothing needs a purge.
    </>
  );

  return (
    <LabShell
      title="CDN Lab"
      description="Three regions, one origin, and an edge cache in each region. Turn the CDN on to beat distance, then change the cache policy, deploy and purge to see what decides the hit rate."
      running={running}
      onRunningChange={setRunning}
      onReset={reset}
      legend={
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
          <ParticleLegend outcomes={['cache-hit', 'success', 'warning']} />
          <span className="text-[11px] text-faint">
            Diamond: answered by the edge. Circle: went to the origin. Triangle: an edge served an old version.
          </span>
        </div>
      }
      events={events}
      actions={
        <>
          <Button onClick={deploy}>
            <Rocket className="h-4 w-4" />
            Deploy new version
          </Button>
          <Button onClick={purge} disabled={!cdnEnabled}>
            <Eraser className="h-4 w-4" />
            Purge all edges
          </Button>
        </>
      }
      insight={<Insight>{insight}</Insight>}
      metrics={
        <>
          <MetricsPanel
            items={[
              { key: 'latency', label: 'Avg latency', value: formatLatency(snapshot.avg), tone: latencyTone(snapshot.avg, 120), hint: 'Round trip from distance to the edge or origin.', simulated: true },
              { key: 'p95', label: 'P95 latency', value: formatLatency(snapshot.p95), hint: '95% of requests finish faster than this.', simulated: true },
              { key: 'hitRate', label: 'Edge hit rate', value: cdnEnabled ? formatPercent(hitShare) : '0%', tone: hitShare > 0.85 ? 'ok' : hitShare > 0.5 ? 'warn' : 'danger', hint: 'Requests answered from an edge copy without asking the origin.' },
              { key: 'rps', label: 'Total traffic', value: formatNumber(totalQps), unit: 'req/s' },
              {
                key: 'dbQueries',
                label: 'Origin traffic',
                value: formatNumber(originQps),
                unit: 'req/s',
                tone: offload > 0.8 ? 'ok' : 'warn',
                hint: 'Requests that reached your origin servers, 304 revalidations included.',
              },
              {
                key: 'offload',
                label: 'Origin offload',
                value: formatPercent(offload),
                tone: 'brand',
                hint: 'Share of traffic absorbed by edge caches - this is what you stop paying for.',
              },
              {
                key: 'stale',
                label: 'Old version served',
                value: formatPercent(staleShare),
                tone: staleShare > 0.005 ? 'warn' : 'ok',
                hint: 'Responses carrying the bytes of an earlier deploy, because an edge copy has not expired yet.',
              },
            ]}
          />
          <div className="card p-4">
            <p className="label mb-3">Edge hit rate and old versions served (%)</p>
            <LiveChart
              data={points}
              series={[
                { key: 'hit', label: 'Edge hit rate', color: 'ok' },
                { key: 'stale', label: 'Old version served', color: 'warn' },
              ]}
              variant="line"
              height={150}
              yDomain={[0, 100]}
            />
            <p className="mt-2 text-xs text-faint">
              {SIMULATED_HINT} {formatNumber(CATALOGUE)} files with a few popular and most rare,
              one store of up to {formatNumber(EDGE_CAPACITY)} objects per edge, and a purge that reaches the edges
              within two seconds. Real purges take from under a second to tens of seconds, depending on the vendor.
            </p>
          </div>
          <div className="card p-4">
            <p className="label mb-3">Latency by region</p>
            <DistributionBar
              items={REGIONS.map((region) => {
                const value = regionLatency(region.id);
                return {
                  label: region.name,
                  // NaN renders as a dash below, with an empty bar.
                  value: value ?? NaN,
                  ratio: value === null ? 0 : Math.min(1, value / 250),
                  hot: value !== null && value > 150,
                  suffix: value === null ? undefined : 'ms',
                };
              })}
              formatValue={(value) => (Number.isFinite(value) ? Math.round(value).toString() : '-')}
            />
            <p className="mt-3 text-xs text-faint">
              Distance is a hard floor: about {Math.round(rtt(11500))} ms round trip between Asia Pacific and a US
              origin, before your application does any work at all. Every latency in this lab, Edge RTT included,
              comes from a simplified distance model, not a measurement.
            </p>
          </div>
        </>
      }
      controls={
        <>
          <p className="label">Network</p>
          <Toggle
            label="CDN enabled"
            checked={cdnEnabled}
            onChange={toggleCdn}
            description="Route users to an edge instead of the origin"
          />
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted">Edge locations</p>
            <SegmentedControl
              size="sm"
              value={footprint}
              onChange={changeFootprint}
              options={[
                { value: 'nearby', label: 'EU, US and Asia' },
                { value: 'us-only', label: 'US only' },
              ]}
            />
          </div>
          <Slider
            label="Traffic"
            value={traffic}
            min={200}
            max={20000}
            step={200}
            onChange={change('traffic')}
            format={(value) => `${formatNumber(value)} req/sec`}
            hint="More traffic per edge means rare files are asked for again before their copy expires."
          />

          <p className="label pt-2">Cache policy (set by the origin)</p>
          <Select
            label="Cache-Control"
            value={cacheControl}
            options={CACHE_CONTROL_OPTIONS}
            onChange={change('cacheControl')}
            hint="The response header that tells the edge whether it may keep a copy, and for how long."
          />
          <Slider
            label="Edge TTL (s-maxage)"
            value={ttlSec}
            min={1}
            max={120}
            step={1}
            onChange={change('ttlSec')}
            disabled={cacheControl !== 'ttl'}
            format={(value) => `${value} s`}
            hint="How long an edge may answer from its copy before it has to ask the origin again."
            tone={ttlSec >= 20 ? 'ok' : 'warn'}
          />
          <Select
            label="Cache key"
            value={cacheKey}
            options={CACHE_KEY_OPTIONS}
            onChange={change('cacheKey')}
            hint="What makes two requests count as the same object. Everything added here multiplies the copies."
          />
          <div className="border-t border-line pt-4">
            <p className="label mb-2">Origin load</p>
            <Meter value={totalQps > 0 ? Math.min(1, originQps / totalQps) : 0} label="Share reaching origin" tone="violet" />
            <p className="mt-2 text-[11px] text-faint">
              With no CDN this is 100%. Every point of hit rate is origin capacity and bandwidth you do not buy.
            </p>
          </div>
        </>
      }
    >
      <DiagramCanvas layout={LAYOUT} edges={edges} particles={particleViews} height={548} className="bg-canvas">
        <ArchNode kind="server" title="Origin Server" subtitle="us-east" placed={LAYOUT.origin}>
          <NodeStatRow label="Incoming" value={`${formatNumber(originQps)}/s`} />
          <NodeStatRow label="Offloaded" value={formatPercent(offload)} tone={offload > 0.8 ? 'text-ok' : 'text-warn'} />
          <NodeStatRow label="Deployed" value={`v${current.version}`} />
        </ArchNode>

        {EDGES.map((edge) => {
          const inUse = edgeInUse(edge.id);
          const stats = current.edges[edge.id];
          const requests = stats.requests.rate(now);
          // Read the counters on every render so their windows start together;
          // two rolling windows can still drift by a bucket, so a ratio above
          // 100% is clamped rather than shown as a hit rate no cache can have.
          const edgeHitRate = requests ? Math.min(1, stats.hits.rate(now) / requests) : 0;
          const edgeStale = requests ? stats.stale.rate(now) / requests : 0;
          const nearest = REGIONS.find((region) => region.edgeId === edge.id);
          const servesKm = footprint === 'us-only' && edge.id === 'us-edge' ? null : nearest?.edgeKm ?? 0;
          return (
            <ArchNode
              key={edge.id}
              kind="cdn"
              title={edge.name}
              subtitle={
                !cdnEnabled
                  ? 'not in use'
                  : !inUse
                    ? 'not deployed'
                    : servesKm === null
                      ? 'serves every region'
                      : `${servesKm} km from users`
              }
              placed={LAYOUT[edge.id]}
              status={!inUse ? 'down' : purging.has(edge.id) ? 'degraded' : 'healthy'}
              statusLabel={!inUse ? 'Off' : purging.has(edge.id) ? 'Purge pending' : undefined}
            >
              <NodeStatRow
                label="Hit rate"
                value={inUse ? formatPercent(edgeHitRate) : '-'}
                tone={
                  !inUse ? 'text-ink' : edgeHitRate > 0.8 ? 'text-ok' : edgeHitRate > 0.5 ? 'text-warn' : 'text-danger'
                }
              />
              <NodeStatRow label="Edge RTT" value={formatLatency(rtt(nearest?.edgeKm ?? 0))} />
              <NodeStatRow label="Stored" value={inUse ? formatNumber(stats.store.size) : '-'} />
              <NodeStatRow
                label="Old version"
                value={inUse ? formatPercent(edgeStale) : '-'}
                tone={edgeStale > 0.005 ? 'text-warn' : 'text-faint'}
              />
            </ArchNode>
          );
        })}

        {REGIONS.map((region) => {
          const latency = regionLatency(region.id);
          return (
            <ArchNode
              key={region.id}
              kind="client"
              title={region.name}
              subtitle={`${formatPercent(region.shareOfTraffic)} of traffic`}
              placed={LAYOUT[region.id]}
              compact
            >
              <NodeStatRow label="Latency" value={formatLatency(latency)} tone={LATENCY_TEXT[latencyTone(latency, 150)]} />
            </ArchNode>
          );
        })}
      </DiagramCanvas>
    </LabShell>
  );
}

export default CdnLab;
