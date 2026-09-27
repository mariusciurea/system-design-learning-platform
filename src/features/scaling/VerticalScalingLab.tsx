import { useCallback, useRef, useState } from 'react';
import { ArrowBigUpDash, ArrowDownToLine, Cpu, MemoryStick } from 'lucide-react';
import { ArchNode, DiagramCanvas, NodeStatRow, ParticleLegend, type DiagramEdge, type Layout, type ParticleView } from '@/components/architecture';
import { LiveChart } from '@/components/charts';
import { Insight, LabShell, MetricsPanel } from '@/components/learning';
import { Button, Meter, Slider } from '@/components/ui';
import { advanceParticles, nextParticleId, useEventLog, useSeries, useTicker, type Particle } from '@/simulations/engine';
import { computeLoad, type LoadResponse } from '@/simulations/models/load';
import { MACHINE_TIERS } from '@/simulations/models/machine';
import { useRerender } from '@/hooks/useRerender';
import { sampleArrivals } from '@/utils/math';
import { formatLatency, formatNumber, formatPercent } from '@/utils/format';
import { useLabRunning } from '@/hooks/useLabRunning';

const LAYOUT: Layout = {
  users: { x: 380, y: 20, w: 200, h: 73 },
  server: { x: 340, y: 150, w: 280, h: 216 },
  db: { x: 390, y: 410, w: 180, h: 78 },
};

const EDGES: DiagramEdge[] = [
  { from: 'users', to: 'server', tone: 'brand', width: 2 },
  { from: 'server', to: 'db', tone: 'default' },
];

/**
 * How long a resize keeps the one machine offline. Compressed so it fits a lab session: a real
 * stop, resize and start of a cloud instance takes minutes, and the UI says so.
 */
const RESTART_SECONDS = 3;

/** What the single machine looks like while it restarts: nothing is served. */
const RESTARTING_LOAD: LoadResponse = { utilization: 0, cpu: 0, latencyMs: 0, errorRate: 1, saturated: false };

/**
 * Vertical scaling: one machine, a traffic slider, and an upgrade button.
 * The teaching moment is that upgrading fixes capacity but never redundancy.
 */
export function VerticalScalingLab() {
  const [running, setRunning] = useLabRunning();
  const [traffic, setTraffic] = useState(450);
  const [tierIndex, setTierIndex] = useState(0);
  const particles = useRef<Particle[]>([]);
  const rerender = useRerender(30);
  const { events, log, clear } = useEventLog();
  const { points, push, reset: resetSeries } = useSeries(50, 500);
  const saturatedSince = useRef<number | null>(null);
  /** Seconds of restart left after a resize. Counted down by the ticker, so pausing freezes it too. */
  const restartLeft = useRef(0);

  const tier = MACHINE_TIERS[tierIndex];
  const restarting = restartLeft.current > 0;
  const capacityLoad = computeLoad(traffic, tier.capacity, { baseLatencyMs: 30, kneeAt: 0.6 });
  const load = restarting ? RESTARTING_LOAD : capacityLoad;

  /**
   * Every resize goes through here - the Upgrade/Downgrade buttons and a jump straight to a tier on
   * the ladder log the same way. Out-of-range indexes are ignored.
   */
  const selectTier = useCallback(
    (index: number) => {
      if (index === tierIndex || index < 0 || index >= MACHINE_TIERS.length) return;
      const next = MACHINE_TIERS[index];
      setTierIndex(index);
      restartLeft.current = RESTART_SECONDS;
      if (index > tierIndex) {
        log(`Upgraded to ${next.name}: ${next.cpu} vCPU, ${next.ramGb} GB, ~${next.capacity} req/sec`, 'ok');
      } else {
        log(`Downgraded to ${next.name} (~${next.capacity} req/sec)`, 'info');
      }
      log('Resizing restarts the only server - every request fails until it is back', 'danger');
    },
    [tierIndex, log],
  );

  const upgrade = useCallback(() => selectTier(tierIndex + 1), [selectTier, tierIndex]);
  const downgrade = useCallback(() => selectTier(tierIndex - 1), [selectTier, tierIndex]);

  const reset = useCallback(() => {
    particles.current = [];
    restartLeft.current = 0;
    saturatedSince.current = null;
    setTierIndex(0);
    setTraffic(450);
    clear();
    resetSeries();
  }, [clear, resetSeries]);

  useTicker(running, (dt) => {
    const now = performance.now();
    if (restartLeft.current > 0) {
      restartLeft.current -= dt;
      if (restartLeft.current <= 0) {
        restartLeft.current = 0;
        log(`Server back up on ${tier.name} - serving traffic again`, 'ok');
      }
    }
    // Dots per second grow with traffic but are capped, and the cap on live dots is above what one
    // trip needs - a tighter cap dropped dots before they ever reached the server.
    const arrivals = sampleArrivals(Math.min(traffic / 12, 70), dt);
    for (let index = 0; index < arrivals; index += 1) {
      const failed = Math.random() < load.errorRate;
      particles.current.push({
        id: nextParticleId(),
        route: failed ? ['users', 'server'] : ['users', 'server', 'db'],
        leg: 0,
        t: 0,
        speed: 1.1 + Math.random() * 0.5,
        outcome: failed ? 'failure' : load.cpu > 0.85 ? 'warning' : 'success',
      });
    }

    const { alive } = advanceParticles(particles.current, dt);
    particles.current = alive.slice(-150);

    // Judged on the tier capacity, not the restart: a restart is not "back under capacity".
    if (capacityLoad.saturated && saturatedSince.current === null) {
      saturatedSince.current = now;
      log(`Traffic ${formatNumber(traffic)} req/sec exceeds capacity ${formatNumber(tier.capacity)} - requests failing`, 'danger');
    } else if (!capacityLoad.saturated && saturatedSince.current !== null) {
      saturatedSince.current = null;
      log('Back under capacity - latency and errors recovering', 'ok');
    }

    push({ cpu: load.cpu * 100, latency: load.latencyMs, errors: load.errorRate * 100 }, now);
    rerender();
  });

  // Recomputed on every render: the ticker re-renders at a capped frame rate.
  const particleViews: ParticleView[] = particles.current.map((particle) => ({
    id: particle.id,
    from: particle.route[particle.leg],
    to: particle.route[particle.leg + 1],
    t: particle.t,
    outcome: particle.outcome ?? 'success',
  }));

  const comparison = MACHINE_TIERS[Math.min(tierIndex + 1, MACHINE_TIERS.length - 1)];
  const nextLoad = computeLoad(traffic, comparison.capacity, { baseLatencyMs: 30, kneeAt: 0.6 });

  return (
    <LabShell
      title="Vertical Scaling Lab"
      description="Push traffic past what one machine can serve, then buy a bigger machine and watch what improves - and what does not."
      running={running}
      onRunningChange={setRunning}
      onReset={reset}
      legend={
        <ParticleLegend
          outcomes={[
            'success',
            { outcome: 'warning', label: 'Slow: CPU above 85%' },
            { outcome: 'failure', label: 'Request failed' },
          ]}
        />
      }
      events={events}
      actions={
        <>
          <Button variant="secondary" onClick={downgrade} disabled={tierIndex === 0}>
            <ArrowDownToLine className="h-4 w-4" />
            Downgrade server
          </Button>
          <Button variant="primary" onClick={upgrade} disabled={tierIndex >= MACHINE_TIERS.length - 1}>
            <ArrowBigUpDash className="h-4 w-4" />
            Upgrade server
          </Button>
        </>
      }
      insight={
        <Insight>
          {restarting ? (
            <>
              The server is restarting on the new machine size, and every request fails: there is no second machine to
              take them. A bigger machine buys capacity, never availability - it is still a single point of failure. The
              restart is shortened to {RESTART_SECONDS}s here; a real resize takes minutes.
            </>
          ) : load.saturated ? (
            <>
              The machine is over capacity: CPU is pinned, latency is climbing through queueing, and{' '}
              {formatPercent(load.errorRate, 1)} of requests are being rejected. Upgrading to {comparison.name} would
              bring latency to roughly {formatLatency(nextLoad.latencyMs)} - but the server is still a single point of
              failure, and the relative cost goes from ${tier.costPerMonth} to ${comparison.costPerMonth} per month.
            </>
          ) : (
            <>
              At {formatPercent(load.cpu)} CPU{' '}
              {load.cpu > 0.6
                ? 'the machine is past the knee - requests have started to queue and latency is climbing.'
                : 'there is headroom.'}{' '}
              Latency barely moves until utilization passes about 60% - then queueing takes over and it rises
              sharply. That knee is why capacity planning targets 60-70%, not 95%.
            </>
          )}
        </Insight>
      }
      metrics={
        <>
          <MetricsPanel
            items={[
              { key: 'rps', label: 'Traffic', value: formatNumber(traffic), unit: 'req/s', tone: 'brand' },
              {
                key: 'utilization',
                label: 'Capacity',
                value: formatNumber(tier.capacity),
                unit: 'req/s',
                hint: 'Requests per second this machine tier can serve before it saturates.',
                simulated: true,
              },
              {
                key: 'cpu',
                label: 'CPU',
                value: formatPercent(load.cpu),
                tone: load.cpu > 0.9 ? 'danger' : load.cpu > 0.7 ? 'warn' : 'ok',
                simulated: true,
              },
              {
                key: 'latency',
                label: 'Latency',
                value: restarting ? 'offline' : formatLatency(load.latencyMs),
                tone: restarting || load.latencyMs > 500 ? 'danger' : 'neutral',
                hint: 'Time to serve one request, from a queueing model.',
                simulated: true,
              },
              {
                key: 'errorRate',
                label: 'Error rate',
                value: formatPercent(load.errorRate, 1),
                tone: load.errorRate > 0 ? 'danger' : 'ok',
                simulated: true,
              },
              {
                key: 'cost',
                label: 'Relative cost',
                value: `$${formatNumber(tier.costPerMonth)}`,
                unit: '/mo',
                hint: 'Only for comparing tiers with each other - not a price list.',
                simulated: true,
              },
            ]}
          />
          <div className="card p-4">
            <p className="label mb-3">Utilization, latency and errors</p>
            <LiveChart
              data={points}
              series={[
                { key: 'cpu', label: 'CPU %', color: 'brand' },
                { key: 'errors', label: 'Errors %', color: 'danger' },
              ]}
              height={140}
              yDomain={[0, 100]}
            />
            <LiveChart
              data={points}
              series={[{ key: 'latency', label: 'Latency (ms)', color: 'warn' }]}
              variant="line"
              height={140}
            />
          </div>
          <div className="card p-4">
            <p className="label mb-3">Tier ladder</p>
            <div className="grid gap-2 sm:grid-cols-5">
              {MACHINE_TIERS.map((item, index) => (
                <button
                  key={item.id}
                  type="button"
                  aria-pressed={index === tierIndex}
                  onClick={() => selectTier(index)}
                  className={`rounded-xl border p-3 text-left transition-colors ${
                    index === tierIndex ? 'border-brand bg-brand/5' : 'border-line hover:border-brand/50'
                  }`}
                >
                  <p className="text-xs font-semibold text-ink">{item.name}</p>
                  <p className="mt-1 font-mono text-[11px] text-muted">{item.cpu} vCPU</p>
                  <p className="font-mono text-[11px] text-muted">{item.ramGb} GB</p>
                  <p className="mt-1 font-mono text-[11px] text-brand">{formatNumber(item.capacity)} req/s</p>
                  <p className="font-mono text-[11px] text-faint">${formatNumber(item.costPerMonth)}/mo</p>
                </button>
              ))}
            </div>
            <p className="mt-3 text-xs text-faint">
              Capacity grows about 16x from Small to Bare metal, while cost grows about 65x. That gap is the economic
              argument for scaling out instead of up. Illustrative numbers, not a benchmark or a price list.
            </p>
          </div>
        </>
      }
      controls={
        <>
          <Slider
            label="Traffic"
            value={traffic}
            min={100}
            max={3000}
            step={50}
            onChange={setTraffic}
            format={(value) => `${formatNumber(value)} req/sec`}
            scale={['100', '3000']}
            tone={load.saturated ? 'danger' : 'brand'}
            hint="Requests per second arriving at the single server."
          />
          <div className="space-y-2 border-t border-line pt-4">
            <p className="label">Current machine</p>
            <div className="flex items-center gap-2 text-xs text-muted">
              <Cpu className="h-3.5 w-3.5" /> {tier.cpu} vCPU
            </div>
            <div className="flex items-center gap-2 text-xs text-muted">
              <MemoryStick className="h-3.5 w-3.5" /> {tier.ramGb} GB RAM
            </div>
            <Meter label="Utilization" value={load.cpu} />
          </div>
          <div className="border-t border-line pt-4">
            <p className="label mb-2">Still true after upgrading</p>
            <ul className="space-y-1 text-[11px] text-muted">
              <li>One machine - a single point of failure</li>
              <li>Resizing needs a restart (Upgrade and watch every request fail for {RESTART_SECONDS}s)</li>
              <li>There is a largest machine you can buy</li>
            </ul>
          </div>
        </>
      }
    >
      <DiagramCanvas layout={LAYOUT} edges={EDGES} particles={particleViews} height={505} className="bg-canvas">
        <ArchNode kind="client" title="Users" subtitle={`${formatNumber(traffic)} req/sec`} placed={LAYOUT.users} compact />
        <ArchNode
          kind="server"
          title={`Application Server (${tier.name})`}
          subtitle={`${tier.cpu} vCPU / ${tier.ramGb} GB`}
          placed={LAYOUT.server}
          status={restarting ? 'down' : load.errorRate > 0.2 ? 'degraded' : 'healthy'}
          statusLabel={restarting ? 'Restarting' : undefined}
          alert={load.saturated}
        >
          <Meter label="CPU" value={load.cpu} />
          <Meter label="Memory (model)" value={Math.min(0.95, load.cpu * 0.8 + 0.1)} tone="violet" />
          <NodeStatRow label="Capacity" value={`${formatNumber(tier.capacity)}/s`} />
          <NodeStatRow
            label="Latency"
            value={restarting ? 'offline' : formatLatency(load.latencyMs)}
            tone={restarting || load.latencyMs > 400 ? 'text-danger' : 'text-ink'}
          />
          <NodeStatRow
            label="Errors"
            value={formatPercent(load.errorRate, 1)}
            tone={load.errorRate > 0 ? 'text-danger' : 'text-ok'}
          />
        </ArchNode>
        <ArchNode kind="sql" title="PostgreSQL" subtitle="single instance" placed={LAYOUT.db} compact />
      </DiagramCanvas>
    </LabShell>
  );
}

export default VerticalScalingLab;
