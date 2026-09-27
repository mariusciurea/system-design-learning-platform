import { useCallback, useRef, useState } from 'react';
import { Camera, Minus, Plus } from 'lucide-react';
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
import { Button, Meter, Slider, Toggle } from '@/components/ui';
import { advanceParticles, nextParticleId, useEventLog, useTicker, type Particle } from '@/simulations/engine';
import { computeLoad, type LoadResponse } from '@/simulations/models/load';
import { useRerender } from '@/hooks/useRerender';
import { clamp, sampleArrivals } from '@/utils/math';
import { formatLatency, formatNumber, formatPercent } from '@/utils/format';
import { useLabRunning } from '@/hooks/useLabRunning';

/**
 * Simplified numbers, chosen to match the Lesson (one server ~500 req/sec). Every request makes one
 * query to the shared database, and the database can take 3,000 queries a second no matter how many
 * app servers send them - so past 3,000 req/sec adding servers stops helping, which is the lesson.
 */
const SERVER_CAPACITY = 500;
const DB_CAPACITY = 3000;
const MAX_SERVERS = 8;
const MAX_TRAFFIC = MAX_SERVERS * SERVER_CAPACITY;
const DEFAULT_TRAFFIC = 900;

/** Every request fails: there is no healthy server to send it to. */
const NO_SERVER_LOAD: LoadResponse = { utilization: Infinity, cpu: 0, latencyMs: 0, errorRate: 1, saturated: true };

interface Snapshot {
  label: string;
  traffic: number;
  cpu: number;
  latency: number;
  errorRate: number;
}

/**
 * Horizontal scaling: start with one server, overload it, then add servers and watch load, latency
 * and errors redistribute - until the shared database becomes the limit. Failing one server shows the
 * other half of the idea: with N servers a failure costs 1/N of capacity; with one it costs everything.
 */
export function HorizontalScalingLab() {
  const [running, setRunning] = useLabRunning();
  const [traffic, setTraffic] = useState(DEFAULT_TRAFFIC);
  const [servers, setServers] = useState(1);
  const [serverDown, setServerDown] = useState(false);
  const [before, setBefore] = useState<Snapshot | null>(null);
  const particles = useRef<Particle[]>([]);
  const cursor = useRef(0);
  const rerender = useRerender(30);
  const { events, log, clear } = useEventLog();

  // Server 1 (index 0) is the one that fails; the load balancer health check takes it out of the pool.
  const healthy = servers - (serverDown ? 1 : 0);
  const capacity = healthy * SERVER_CAPACITY;
  const perServer =
    healthy > 0 ? computeLoad(traffic / healthy, SERVER_CAPACITY, { baseLatencyMs: 40, kneeAt: 0.65 }) : NO_SERVER_LOAD;
  const queries = traffic * (1 - perServer.errorRate);
  const db = computeLoad(queries, DB_CAPACITY, { baseLatencyMs: 10, kneeAt: 0.7 });
  const errorRate = healthy > 0 ? 1 - (1 - perServer.errorRate) * (1 - db.errorRate) : 1;
  const latency = healthy > 0 ? perServer.latencyMs + db.latencyMs : 0;

  // Logged outside the state updater: StrictMode runs updaters twice, which
  // wrote every add/remove into the event log twice.
  const addServer = useCallback(() => {
    if (servers >= MAX_SERVERS) return;
    setServers(servers + 1);
    log(`Added Server ${servers + 1} - pool capacity now ${formatNumber((healthy + 1) * SERVER_CAPACITY)} req/sec`, 'ok');
  }, [servers, healthy, log]);

  const removeServer = useCallback(() => {
    if (servers <= 1) return;
    setServers(servers - 1);
    log(`Removed Server ${servers} - pool capacity now ${formatNumber((healthy - 1) * SERVER_CAPACITY)} req/sec`, 'warn');
  }, [servers, healthy, log]);

  const toggleFailure = useCallback(
    (down: boolean) => {
      setServerDown(down);
      if (down) {
        log('Server 1 crashed - the health check takes it out of the pool', 'danger');
        log(
          servers === 1
            ? 'It was the only server: every request now fails'
            : `${servers - 1} of ${servers} servers left - capacity down by ${formatPercent(1 / servers)}`,
          servers === 1 ? 'danger' : 'warn',
        );
      } else {
        log('Server 1 recovered and passed its health check - back in the pool', 'ok');
      }
    },
    [servers, log],
  );

  const capture = useCallback(() => {
    setBefore({
      label: `${healthy} of ${servers} server${servers > 1 ? 's' : ''} serving`,
      traffic,
      cpu: perServer.cpu,
      latency,
      errorRate,
    });
    log(`Captured baseline: ${servers} server${servers > 1 ? 's' : ''} at ${formatNumber(traffic)} req/sec`, 'info');
  }, [healthy, servers, traffic, perServer, latency, errorRate, log]);

  const reset = useCallback(() => {
    particles.current = [];
    setServers(1);
    setServerDown(false);
    setTraffic(DEFAULT_TRAFFIC);
    setBefore(null);
    clear();
  }, [clear]);

  useTicker(running, (dt) => {
    // Dots per second grow with traffic, capped so a whole trip to the database fits under the live cap.
    const arrivals = sampleArrivals(Math.min(traffic / 25, 120), dt);
    for (let index = 0; index < arrivals; index += 1) {
      if (healthy === 0) {
        // Nowhere to go: the request dies at the load balancer.
        particles.current.push({
          id: nextParticleId(),
          route: ['users', 'lb'],
          leg: 0,
          t: 0,
          speed: 1.4 + Math.random() * 0.4,
          outcome: 'failure',
        });
        continue;
      }
      // Round robin over the healthy servers only - the failed one (index 0) is skipped.
      cursor.current = (cursor.current + 1) % healthy;
      const target = `s${serverDown ? cursor.current + 1 : cursor.current}`;
      const appFailed = Math.random() < perServer.errorRate;
      const dbFailed = !appFailed && Math.random() < db.errorRate;
      const slow = perServer.cpu > 0.85 || db.cpu > 0.85;
      particles.current.push({
        id: nextParticleId(),
        route: appFailed ? ['users', 'lb', target] : ['users', 'lb', target, 'db'],
        leg: 0,
        t: 0,
        speed: 1.4 + Math.random() * 0.4,
        outcome: appFailed || dbFailed ? 'failure' : slow ? 'warning' : 'success',
      });
    }
    const { alive } = advanceParticles(particles.current, dt);
    particles.current = alive.slice(-260);
    rerender();
  });

  const width = clamp((940 - (servers - 1) * 12) / servers, 106, 180);
  const xs = spread(servers, 480, width, 12);
  const layout: Layout = {
    users: { x: 390, y: 16, w: 180, h: 73 },
    lb: { x: 380, y: 130, w: 200, h: 128 },
    db: { x: 370, y: 480, w: 220, h: 136 },
  };
  for (let index = 0; index < servers; index += 1) {
    layout[`s${index}`] = { x: xs[index], y: 290, w: width, h: 154 };
  }

  // Every server is wired to the load balancer and to the database - replicas are interchangeable.
  // The failed one keeps its wires, drawn dashed, because it is out of the pool, not gone.
  const edges: DiagramEdge[] = [{ from: 'users', to: 'lb', tone: 'brand', width: 2 }];
  for (let index = 0; index < servers; index += 1) {
    const down = serverDown && index === 0;
    edges.push({ from: 'lb', to: `s${index}`, tone: down ? 'muted' : 'ok', dashed: down });
    edges.push({ from: `s${index}`, to: 'db', tone: down ? 'muted' : 'default', dashed: down });
  }

  const particleViews: ParticleView[] = particles.current
    .filter((particle) => particle.route.every((id) => layout[id]))
    .map((particle) => ({
      id: particle.id,
      from: particle.route[particle.leg],
      to: particle.route[particle.leg + 1],
      t: particle.t,
      outcome: particle.outcome ?? 'success',
    }));

  const after: Snapshot = {
    label: `${healthy} of ${servers} server${servers > 1 ? 's' : ''} serving`,
    traffic,
    cpu: perServer.cpu,
    latency,
    errorRate,
  };

  const share = healthy > 0 ? traffic / healthy : 0;

  let insight;
  if (healthy === 0) {
    insight = (
      <>
        The only server is down, so every request fails at the load balancer. That is a single point of failure:
        one machine, however large, takes the whole service with it. Add a second server, then fail Server 1 again.
      </>
    );
  } else if (db.saturated) {
    insight = (
      <>
        The app servers are at {formatPercent(perServer.cpu)} CPU, but the shared database gets{' '}
        {formatNumber(queries)} queries/sec against its {formatNumber(DB_CAPACITY)}. Adding app servers now only
        sends it more work - the bottleneck moved downstream. The next step is read replicas, caching or sharding,
        not more servers.
      </>
    );
  } else if (traffic > capacity) {
    insight = (
      <>
        {formatNumber(traffic)} req/sec against {formatNumber(capacity)} req/sec of pool capacity. Each server is at{' '}
        {formatPercent(perServer.cpu)} and rejecting {formatPercent(perServer.errorRate, 1)} of requests. Adding a
        server divides the load - this is the part that vertical scaling cannot do indefinitely.
      </>
    );
  } else if (servers === 1) {
    insight = (
      <>
        One server is keeping up for now, but it is also a single point of failure: turn on Fail Server 1 and the whole
        service goes with it. Adding servers raises capacity and removes that risk at the same time.
      </>
    );
  } else {
    insight = (
      <>
        Capacity scales roughly linearly with instance count, and redundancy arrives as a side effect: losing one of{' '}
        {servers} servers costs {formatPercent(1 / servers)} of capacity instead of the whole service. Push traffic
        past {formatNumber(DB_CAPACITY)} req/sec to find the next bottleneck: the shared database.
      </>
    );
  }

  return (
    <LabShell
      title="Horizontal Scaling Lab"
      description="One server cannot keep up. Add instances behind the load balancer, watch each one take a share of the load - and watch the shared database become the next limit."
      running={running}
      onRunningChange={setRunning}
      onReset={reset}
      legend={
        <ParticleLegend
          outcomes={[
            'success',
            { outcome: 'warning', label: 'Slow: a server or the database above 85% CPU' },
            { outcome: 'failure', label: 'Request failed' },
          ]}
        />
      }
      events={events}
      actions={
        <>
          <Button onClick={capture}>
            <Camera className="h-4 w-4" />
            Capture &ldquo;before&rdquo;
          </Button>
          <Button variant="secondary" onClick={removeServer} disabled={servers <= 1}>
            <Minus className="h-4 w-4" />
            Remove server
          </Button>
          <Button variant="primary" onClick={addServer} disabled={servers >= MAX_SERVERS}>
            <Plus className="h-4 w-4" />
            Add server
          </Button>
        </>
      }
      insight={<Insight>{insight}</Insight>}
      metrics={
        <>
          <MetricsPanel
            items={[
              { key: 'rps', label: 'Traffic', value: formatNumber(traffic), unit: 'req/s', tone: 'brand' },
              { key: 'instances', label: 'Servers', value: `${healthy}/${servers}` },
              {
                key: 'utilization',
                label: 'Pool capacity',
                value: formatNumber(capacity),
                unit: 'req/s',
                hint: 'Healthy servers x the requests per second each one can serve.',
                simulated: true,
              },
              {
                key: 'cpu',
                label: 'CPU per server',
                value: formatPercent(perServer.cpu),
                tone: perServer.cpu > 0.9 ? 'danger' : perServer.cpu > 0.7 ? 'warn' : 'ok',
                simulated: true,
              },
              {
                key: 'db',
                label: 'Database load',
                value: formatPercent(Math.min(db.utilization, 1)),
                tone: db.utilization >= 1 ? 'danger' : db.utilization > 0.7 ? 'warn' : 'ok',
                hint: `Queries per second against the ${formatNumber(DB_CAPACITY)} the one shared database can take.`,
                simulated: true,
              },
              {
                key: 'latency',
                label: 'Latency',
                value: healthy > 0 ? formatLatency(latency) : 'none served',
                hint: 'Time to serve one request: app server plus database, from a queueing model.',
                simulated: true,
              },
              {
                key: 'errorRate',
                label: 'Errors',
                value: formatPercent(errorRate, 1),
                tone: errorRate > 0 ? 'danger' : 'ok',
                simulated: true,
              },
            ]}
          />

          <div className="card p-4">
            <p className="label mb-3">Before / after</p>
            {before ? (
              <div className="grid gap-4 sm:grid-cols-2">
                {[before, after].map((snapshot, index) => (
                  <div key={index} className={index === 1 ? 'sm:border-l sm:border-line sm:pl-4' : undefined}>
                    <p className="text-sm font-semibold text-ink">
                      {index === 0 ? 'Before' : 'After'}: {snapshot.label}
                    </p>
                    <dl className="mt-3 space-y-1.5 font-mono text-xs">
                      <div className="flex justify-between">
                        <dt className="text-faint">CPU</dt>
                        <dd className={snapshot.cpu > 0.85 ? 'text-danger' : 'text-ink'}>
                          {formatPercent(snapshot.cpu)}
                        </dd>
                      </div>
                      <div className="flex justify-between">
                        <dt className="text-faint">Latency</dt>
                        <dd className={snapshot.latency > 400 ? 'text-danger' : 'text-ink'}>
                          {formatLatency(snapshot.latency)}
                        </dd>
                      </div>
                      <div className="flex justify-between">
                        <dt className="text-faint">Errors</dt>
                        <dd className={snapshot.errorRate > 0 ? 'text-danger' : 'text-ok'}>
                          {formatPercent(snapshot.errorRate, 1)}
                        </dd>
                      </div>
                      <div className="flex justify-between">
                        <dt className="text-faint">Traffic</dt>
                        <dd className="text-ink">{formatNumber(snapshot.traffic)} req/s</dd>
                      </div>
                    </dl>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted">
                Overload the single server, press <strong className="text-ink">Capture &ldquo;before&rdquo;</strong>,
                then add servers to see the comparison.
              </p>
            )}
          </div>

          <div className="card p-4">
            <p className="label mb-3">Load distribution</p>
            <DistributionBar
              items={Array.from({ length: servers }, (_, index) => {
                const down = serverDown && index === 0;
                return {
                  label: down ? `Server ${index + 1} (down)` : `Server ${index + 1}`,
                  value: down ? 0 : share,
                  ratio: down ? 0 : Math.min(1, share / SERVER_CAPACITY),
                  hot: !down && share > SERVER_CAPACITY,
                  suffix: 'req/s',
                };
              })}
              formatValue={(value) => formatNumber(value)}
            />
          </div>
        </>
      }
      controls={
        <>
          <Slider
            label="Traffic"
            value={traffic}
            min={100}
            max={MAX_TRAFFIC}
            step={50}
            onChange={setTraffic}
            format={(value) => `${formatNumber(value)} req/sec`}
            scale={['100', formatNumber(MAX_TRAFFIC)]}
            tone={traffic > capacity || db.saturated ? 'danger' : 'brand'}
          />
          <Toggle
            label="Fail Server 1"
            checked={serverDown}
            onChange={toggleFailure}
            description="The health check takes it out of the pool"
          />
          <div className="border-t border-line pt-4">
            <p className="label mb-2">Pool utilization</p>
            <Meter
              value={capacity > 0 ? traffic / capacity : 1}
              label={`${formatNumber(traffic)} / ${formatNumber(capacity)} req/sec`}
            />
            <p className="mt-2 text-[11px] text-faint">
              Each server absorbs about {SERVER_CAPACITY} req/sec before it saturates, and the one database about{' '}
              {formatNumber(DB_CAPACITY)} queries/sec. Illustrative numbers, not a benchmark.
            </p>
          </div>
          <div className="border-t border-line pt-4">
            <p className="label mb-2">What this does not fix</p>
            <ul className="space-y-1 text-[11px] text-muted">
              <li>The shared database still sees every query</li>
              <li>Local session state breaks across instances</li>
              <li>Connection counts multiply by instance count</li>
            </ul>
          </div>
        </>
      }
    >
      <DiagramCanvas layout={layout} edges={edges} particles={particleViews} height={650} className="bg-canvas">
        <ArchNode kind="client" title="Users" subtitle={`${formatNumber(traffic)} req/sec`} placed={layout.users} compact />
        <ArchNode kind="load-balancer" title="Load Balancer" subtitle="round robin, 2 nodes" placed={layout.lb}>
          <NodeStatRow label="In pool" value={`${healthy}/${servers}`} />
          <NodeStatRow label="Capacity" value={`${formatNumber(capacity)}/s`} />
        </ArchNode>
        {Array.from({ length: servers }, (_, index) => {
          const down = serverDown && index === 0;
          return (
            <ArchNode
              key={index}
              kind="server"
              title={`Server ${index + 1}`}
              placed={layout[`s${index}`]}
              compact={width < 130}
              alert={!down && perServer.cpu > 0.9}
              status={down ? 'down' : perServer.errorRate > 0.2 ? 'degraded' : 'healthy'}
            >
              <Meter label="CPU" value={down ? 0 : perServer.cpu} size="xs" />
              <NodeStatRow label="Share" value={down ? 'none' : `${formatNumber(share)}/s`} />
              <NodeStatRow label="Latency" value={down ? 'down' : formatLatency(perServer.latencyMs)} />
            </ArchNode>
          );
        })}
        <ArchNode
          kind="sql"
          title="Shared database"
          subtitle="one query per request"
          placed={layout.db}
          alert={db.utilization >= 1}
          status={db.errorRate > 0.2 ? 'degraded' : 'healthy'}
        >
          <Meter label="Load" value={Math.min(db.utilization, 1)} size="xs" />
          <NodeStatRow label="Queries" value={`${formatNumber(queries)} / ${formatNumber(DB_CAPACITY)}`} />
        </ArchNode>
      </DiagramCanvas>
    </LabShell>
  );
}

export default HorizontalScalingLab;
