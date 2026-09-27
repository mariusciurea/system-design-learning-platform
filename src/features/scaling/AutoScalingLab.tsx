import { useCallback, useRef } from 'react';
import { TrendingUp, Zap } from 'lucide-react';
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
import { LiveChart } from '@/components/charts';
import { Insight, LabShell, MetricsPanel } from '@/components/learning';
import { Button, Meter, Slider, Toggle } from '@/components/ui';
import { advanceParticles, nextParticleId, useEventLog, useSeries, useTicker, type Particle } from '@/simulations/engine';
import { computeLoad } from '@/simulations/models/load';
import { useLabSetup } from '@/hooks/useLabSetup';
import { useRerender } from '@/hooks/useRerender';
import { clamp, sampleArrivals, smooth } from '@/utils/math';
import { formatLatency, formatNumber, formatPercent } from '@/utils/format';
import type { NodeStatus } from '@/types';
import { useLabRunning } from '@/hooks/useLabRunning';

/**
 * Simplified and time-compressed. One instance serves about 500 req/sec, a new one needs 4 seconds to boot
 * and pass its health check, and the traffic curve repeats every 60 seconds. In a real cloud the warm-up
 * is minutes and the daily curve is hours; the proportions, not the numbers, are the lesson.
 */
const SERVER_CAPACITY = 500;
const WARMUP_SECONDS = 4;

interface Instance {
  id: string;
  name: string;
  status: NodeStatus;
  readyAt: number | null;
}

interface AutoScaleState {
  instances: Instance[];
  particles: Particle[];
  /** Round-robin position over the instances that are in the pool. */
  cursor: number;
  elapsed: number;
  cooldownUntil: number;
  cpu: number;
  nextId: number;
  /** Seconds the signal has been continuously above/below the threshold. */
  aboveFor: number;
  belowFor: number;
}

const newInstance = (id: number, ready: boolean, now: number): Instance => ({
  id: `i${id}`,
  name: `api-${id}`,
  status: ready ? 'healthy' : 'starting',
  readyAt: ready ? null : now + WARMUP_SECONDS * 1000,
});

const initialState = (): AutoScaleState => ({
  instances: [newInstance(1, true, 0)],
  particles: [],
  cursor: 0,
  elapsed: 0,
  cooldownUntil: 0,
  cpu: 0,
  nextId: 2,
  aboveFor: 0,
  belowFor: 0,
});

/** Traffic curve: a calm start, a steep ramp, a plateau, then a drop. */
function trafficAt(seconds: number, peak: number) {
  const cycle = seconds % 60;
  if (cycle < 8) return peak * 0.08;
  if (cycle < 20) return peak * (0.08 + ((cycle - 8) / 12) * 0.92);
  if (cycle < 38) return peak;
  if (cycle < 46) return peak * (1 - ((cycle - 38) / 8) * 0.85);
  return peak * 0.15;
}

/** Every control of the Lab. Reset returns to this one object, so it cannot miss a control. */
const DEFAULT_SETUP = { peak: 4000, scaleOut: 70, scaleIn: 30, cooldown: 8, autoScale: true, maxInstances: 8 };

export function AutoScalingLab() {
  const [running, setRunning] = useLabRunning();
  const { setup, setSetup, change } = useLabSetup(DEFAULT_SETUP);
  const { peak, scaleOut, scaleIn, cooldown, autoScale, maxInstances } = setup;

  const state = useRef<AutoScaleState>(initialState());
  const rerender = useRerender(20);
  const { events, log, clear } = useEventLog(60);
  const { points, push, reset: resetSeries } = useSeries(80, 400);

  const reset = useCallback(() => {
    state.current = initialState();
    setSetup(DEFAULT_SETUP);
    clear();
    resetSeries();
  }, [clear, resetSeries, setSetup]);

  const addInstance = useCallback(
    (reason: string) => {
      const current = state.current;
      if (current.instances.length >= maxInstances) return;
      const now = performance.now();
      const instance = newInstance(current.nextId, false, now);
      current.nextId += 1;
      current.instances.push(instance);
      current.cooldownUntil = now + cooldown * 1000;
      log(`${reason} - launching instance ${instance.name}`, 'warn');
    },
    [cooldown, log, maxInstances],
  );

  useTicker(running, (dt) => {
    const current = state.current;
    const now = performance.now();
    current.elapsed += dt;

    for (const instance of current.instances) {
      if (instance.status === 'starting' && instance.readyAt && now >= instance.readyAt) {
        instance.status = 'healthy';
        instance.readyAt = null;
        log(`${instance.name} health check passed`, 'ok');
        log(`${instance.name} added to the load balancer pool`, 'ok');
      }
    }

    // Lowering "Max instances" below the current fleet is a hard cap, like an
    // auto scaling group's max size: the extra instances are terminated now,
    // regardless of CPU or cooldown.
    while (current.instances.length > maxInstances) {
      const extra = current.instances.pop();
      if (extra) log(`Fleet above max of ${maxInstances} - terminating ${extra.name}`, 'info');
    }

    const ready = current.instances.filter((instance) => instance.status === 'healthy');
    const traffic = trafficAt(current.elapsed, peak);
    const capacity = Math.max(1, ready.length) * SERVER_CAPACITY;
    const load = computeLoad(traffic, capacity, { baseLatencyMs: 45, kneeAt: 0.65 });
    current.cpu = smooth(current.cpu, load.cpu, 0.12);

    // Requests only go to instances in the pool: a booting instance gets no traffic until its health
    // check passes. Overflow beyond the pool capacity fails at the instance that was picked.
    const arrivals = sampleArrivals(Math.min(traffic / 20, 250), dt * 0.4);
    for (let index = 0; index < arrivals && ready.length > 0; index += 1) {
      current.cursor = (current.cursor + 1) % ready.length;
      const failed = Math.random() < load.errorRate;
      current.particles.push({
        id: nextParticleId(),
        route: ['users', 'lb', ready[current.cursor].id],
        leg: 0,
        t: 0,
        speed: 1.4 + Math.random() * 0.4,
        outcome: failed ? 'failure' : load.cpu > 0.85 ? 'warning' : 'success',
      });
    }
    current.particles = advanceParticles(current.particles, dt).alive.slice(-160);

    const cpuPercent = current.cpu * 100;
    if (cpuPercent > scaleOut) {
      current.aboveFor += dt;
      current.belowFor = 0;
    } else if (cpuPercent < scaleIn) {
      current.belowFor += dt;
      current.aboveFor = 0;
    } else {
      current.aboveFor = 0;
      current.belowFor = 0;
    }

    if (autoScale && now >= current.cooldownUntil) {
      if (current.aboveFor > 1.5 && current.instances.length < maxInstances) {
        addInstance(`CPU ${Math.round(cpuPercent)}% > ${scaleOut}% threshold`);
        current.aboveFor = 0;
      } else if (current.belowFor > 4 && ready.length > 1) {
        const victim = current.instances.pop();
        if (victim) {
          current.cooldownUntil = now + cooldown * 1000;
          log(`CPU ${Math.round(cpuPercent)}% < ${scaleIn}% - terminating ${victim.name}`, 'info');
        }
        current.belowFor = 0;
      }
    }

    push(
      {
        traffic,
        capacity,
        cpu: cpuPercent,
        instances: current.instances.length,
        latency: load.latencyMs,
        // Carried into the series so the CPU chart can draw the two thresholds
        // the scaling decisions are actually made against.
        scaleOut,
        scaleIn,
      },
      now,
    );
    rerender();
  });

  const current = state.current;
  const ready = current.instances.filter((instance) => instance.status === 'healthy');
  const traffic = trafficAt(current.elapsed, peak);
  const capacity = Math.max(1, ready.length) * SERVER_CAPACITY;
  const load = computeLoad(traffic, capacity, { baseLatencyMs: 45, kneeAt: 0.65 });

  const count = current.instances.length;
  const width = clamp((940 - (count - 1) * 10) / count, 94, 150);
  const xs = spread(count, 480, width, 10);
  const layout: Layout = {
    users: { x: 380, y: 16, w: 200, h: 73 },
    lb: { x: 368, y: 140, w: 224, h: 128 },
  };
  current.instances.forEach((instance, index) => {
    layout[instance.id] = { x: xs[index], y: 320, w: width, h: 132 };
  });

  const edges: DiagramEdge[] = [
    { from: 'users', to: 'lb', tone: 'brand', width: 2 },
    ...current.instances.map<DiagramEdge>((instance) => ({
      from: 'lb',
      to: instance.id,
      tone: instance.status === 'healthy' ? 'ok' : 'warn',
      dashed: instance.status !== 'healthy',
    })),
  ];

  // An instance terminated by scale-in takes its in-flight dots with it.
  const particleViews: ParticleView[] = current.particles
    .filter((particle) => particle.route.every((id) => layout[id]))
    .map((particle) => ({
      id: particle.id,
      from: particle.route[particle.leg],
      to: particle.route[particle.leg + 1],
      t: particle.t,
      outcome: particle.outcome ?? 'success',
    }));

  return (
    <LabShell
      title="Auto Scaling Lab"
      description="Traffic follows a repeating spike. Set thresholds and cooldown, then watch the fleet chase the curve - always a little behind it."
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
        <Button onClick={() => addInstance('Manual scale-out')} disabled={count >= maxInstances}>
          <Zap className="h-4 w-4" />
          Add instance now
        </Button>
      }
      insight={
        <Insight>
          {load.cpu > 0.9 ? (
            <>
              CPU is saturated and a new instance takes {WARMUP_SECONDS}s to boot and pass health checks. During that
              window users feel the spike regardless of the threshold - which is why headroom, queueing or load
              shedding matters more than an aggressive rule.
            </>
          ) : (
            <>
              Scale-out fires above {scaleOut}% and scale-in below {scaleIn}%, with a {cooldown}s cooldown between
              actions. Narrow the gap between those thresholds and the fleet starts flapping; widen the cooldown and it
              reacts too slowly. Both failure modes are visible on the chart.
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
                value: formatNumber(capacity),
                unit: 'req/s',
                hint: 'Instances in the pool x the requests per second each one can serve.',
                simulated: true,
              },
              {
                key: 'cpu',
                label: 'Fleet CPU',
                value: formatPercent(current.cpu),
                tone: current.cpu * 100 > scaleOut ? 'warn' : 'ok',
                simulated: true,
              },
              { key: 'instances', label: 'Instances', value: `${ready.length}/${count}` },
              {
                key: 'latency',
                label: 'Latency',
                value: formatLatency(load.latencyMs),
                hint: 'Time to serve one request, from a queueing model.',
                simulated: true,
              },
              {
                key: 'errorRate',
                label: 'Errors',
                value: formatPercent(load.errorRate, 1),
                tone: load.errorRate > 0 ? 'danger' : 'ok',
                simulated: true,
              },
            ]}
          />
          <div className="card p-4">
            <p className="label mb-3">Traffic vs capacity</p>
            <LiveChart
              data={points}
              series={[
                { key: 'traffic', label: 'Traffic', color: 'brand' },
                { key: 'capacity', label: 'Capacity', color: 'ok', dashed: true },
              ]}
              variant="line"
              height={160}
            />
            <p className="label mb-2 mt-4">Fleet CPU vs thresholds</p>
            <LiveChart
              data={points}
              series={[
                { key: 'cpu', label: 'CPU %', color: 'brand' },
                { key: 'scaleOut', label: 'Scale out', color: 'warn', dashed: true },
                { key: 'scaleIn', label: 'Scale in', color: 'ok', dashed: true },
              ]}
              variant="line"
              height={150}
              yDomain={[0, 100]}
            />
            {/*
              Instances get their own axis. Sharing one with CPU pinned a 1-8
              line to the bottom of a 0-100 chart, which made the one thing this
              lab is about - the fleet chasing the curve - impossible to read.
            */}
            <p className="label mb-2 mt-4">Instance count</p>
            <LiveChart
              data={points}
              series={[{ key: 'instances', label: 'Instances', color: 'violet' }]}
              variant="line"
              height={120}
              formatValue={(value) => String(Math.round(value))}
            />
          </div>
        </>
      }
      controls={
        <>
          <Slider
            label="Peak traffic"
            value={peak}
            min={1000}
            max={10000}
            step={250}
            onChange={change('peak')}
            format={(value) => `${formatNumber(value)} req/sec`}
            hint="The plateau the repeating traffic curve reaches."
          />
          <Toggle
            label="Auto scaling"
            checked={autoScale}
            onChange={change('autoScale')}
            description="Turn off to see what a fixed fleet does with the same spike"
          />
          <Slider
            label="Scale out above"
            value={scaleOut}
            min={40}
            max={95}
            onChange={(value) => change('scaleOut')(Math.max(value, scaleIn + 10))}
            format={(value) => `${value}% CPU`}
            tone="warn"
            hint="Sustained CPU above this for 1.5s triggers a new instance."
          />
          <Slider
            label="Scale in below"
            value={scaleIn}
            min={5}
            max={60}
            onChange={(value) => change('scaleIn')(Math.min(value, scaleOut - 10))}
            format={(value) => `${value}% CPU`}
            tone="ok"
            hint="Sustained CPU below this for 4s removes an instance."
          />
          <Slider
            label="Cooldown"
            value={cooldown}
            min={2}
            max={30}
            onChange={change('cooldown')}
            format={(value) => `${value} s`}
            hint="Minimum time between two scaling actions. Prevents flapping."
          />
          <Slider
            label="Max instances"
            value={maxInstances}
            min={2}
            max={8}
            onChange={change('maxInstances')}
            format={(value) => `${value}`}
            hint="Upper bound so a traffic bug cannot scale you to bankruptcy."
          />
          <div className="border-t border-line pt-4">
            <p className="label mb-2">Signal</p>
            <Meter value={current.cpu} threshold={scaleOut / 100} label="Fleet CPU vs scale-out threshold" />
            <p className="mt-2 text-[11px] text-faint">
              Warm-up: {WARMUP_SECONDS}s here (minutes in a real cloud) before an instance serves traffic.
            </p>
          </div>
        </>
      }
    >
      <DiagramCanvas layout={layout} edges={edges} particles={particleViews} height={475} className="bg-canvas">
        <ArchNode
          kind="client"
          title="Traffic generator"
          subtitle={`${formatNumber(traffic)} req/sec`}
          placed={layout.users}
          compact
        />
        <ArchNode kind="load-balancer" title="Load Balancer" subtitle="health-checked pool, 2 nodes" placed={layout.lb}>
          <NodeStatRow label="In pool" value={ready.length} />
          <NodeStatRow label="Warming up" value={count - ready.length} tone={count > ready.length ? 'text-warn' : 'text-ink'} />
        </ArchNode>
        {current.instances.map((instance) => (
          <ArchNode
            key={instance.id}
            kind="server"
            title={instance.name}
            placed={layout[instance.id]}
            status={instance.status}
            alert={instance.status === 'healthy' && current.cpu > 0.9}
          >
            <Meter label="CPU" value={instance.status === 'healthy' ? current.cpu : 0} size="xs" />
            <NodeStatRow
              label="State"
              value={instance.status === 'starting' ? 'booting' : 'serving'}
              tone={instance.status === 'starting' ? 'text-warn' : 'text-ok'}
            />
          </ArchNode>
        ))}
      </DiagramCanvas>
      <div className="flex items-center gap-2 px-4 pb-3 pt-1 text-[11px] text-faint">
        <TrendingUp className="h-3.5 w-3.5" />
        Traffic repeats on a 60-second cycle: ramp, plateau, drop. Time is compressed - a real warm-up takes minutes.
      </div>
    </LabShell>
  );
}

export default AutoScalingLab;
