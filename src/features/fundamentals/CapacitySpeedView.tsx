import { useMemo, useRef, type ReactNode } from 'react';
import { Timer } from 'lucide-react';
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
import { SegmentedControl, Slider } from '@/components/ui';
import { advanceParticles, nextParticleId, useTicker, type Particle } from '@/simulations/engine';
import { useRerender } from '@/hooks/useRerender';
import { cn } from '@/utils/cn';
import { sampleArrivals } from '@/utils/math';
import type { RequestOutcome } from '@/types';
import {
  DATACENTER_HOP_MS,
  HDD_SEEK_MS,
  RAM_READ_MS,
  SSD_READ_MS,
  USER_ROUND_TRIP_MS,
  averageReadMs,
  formatDuration,
  requestTime,
  type HopId,
  type MissStorage,
  type RequestTime,
  type SpeedInputs,
  type UserRegion,
} from './latencyModel';
import { useLabRunning } from '@/hooks/useLabRunning';

interface SpeedViewProps {
  inputs: SpeedInputs;
  change: <K extends keyof SpeedInputs>(key: K) => (value: SpeedInputs[K]) => void;
  onReset: () => void;
  /** The Size / Speed switch, shown in the toolbar of both views. */
  viewSwitch: ReactNode;
}

/** The parts and order of the Back-of-the-envelope Diagram, plus a spinning disk as a slower miss. */
const LAYOUT: Layout = {
  user: { x: 16, y: 144, w: 196, h: 152 },
  app: { x: 262, y: 165, w: 176, h: 110 },
  db: { x: 488, y: 155, w: 196, h: 130 },
  ram: { x: 750, y: 14, w: 194, h: 128 },
  ssd: { x: 750, y: 156, w: 194, h: 128 },
  hdd: { x: 750, y: 298, w: 194, h: 128 },
};
const HEIGHT = 440;

const REGIONS: { value: UserRegion; label: string }[] = [
  { value: 'same-region', label: 'Same region' },
  { value: 'other-continent', label: 'Another continent' },
];
const STORAGES: { value: MissStorage; label: string }[] = [
  { value: 'ssd', label: 'SSD' },
  { value: 'hdd', label: 'Spinning disk' },
];

const formatPercent = (share: number) => `${Math.round(share * 100)}%`;
const formatKb = (kb: number) =>
  kb < 1_000 ? `${Number(kb.toPrecision(2))} KB` : kb < 1_000_000 ? `${Number((kb / 1_000).toPrecision(2))} MB` : `${Number((kb / 1_000_000).toPrecision(2))} GB`;

/** What to do about the hop that dominates - the decision the arithmetic is for. */
function adviceFor(time: RequestTime, inputs: SpeedInputs): string {
  switch (time.dominant) {
    case 'user':
      return inputs.region === 'other-continent'
        ? 'Distance sets it, not server speed: no faster machine shortens it. Only fewer round trips (batch the calls into one) or a shorter distance (a nearby region or a cache close to the user) do.'
        : 'Even nearby, every call from the user is a trip over the internet. Fewer calls in a row is what is left to win.';
    case 'transfer':
      return 'The response is so big that moving it is the cost. 1 Gbit/s is about 125 MB/s, not 1,000: send less, compress it, or spread it over more links.';
    case 'datacenter':
      return 'This is the N+1 pattern: the cost is the number of trips, not the work in each. Batch the queries into one and the hops collapse to one.';
    case 'storage':
      return inputs.missStorage === 'hdd'
        ? 'Every miss pays a disk seek of about 10 ms. Raise the hit rate, or move the data to SSD, which is about 100x faster.'
        : 'The reads that miss RAM decide the time, even when they are few. Raising the hit rate cuts it faster than anything else.';
    case 'ram':
      return 'Memory is the fastest level there is; nothing left to remove here.';
  }
}

export function CapacitySpeedView({ inputs, change, onReset, viewSwitch }: SpeedViewProps) {
  const { region, userCalls, dbCalls, ramHitRate, missStorage, responseKb } = inputs;
  const time = useMemo(() => requestTime(inputs), [inputs]);
  const hop = (id: HopId) => time.hops.find((each) => each.id === id)!;
  const dominant = hop(time.dominant);
  const share = (totalMs: number) => (time.totalMs > 0 ? totalMs / time.totalMs : 0);
  const far = region === 'other-continent';

  // ---- moving traffic -------------------------------------------------------
  const [running, setRunning] = useLabRunning();
  const particles = useRef<Particle[]>([]);
  const rerender = useRerender(30);

  useTicker(running, (dt) => {
    const arrivals = sampleArrivals(2.4, dt);
    for (let index = 0; index < arrivals; index += 1) {
      const hit = Math.random() < ramHitRate;
      const outcome: RequestOutcome = hit ? 'cache-hit' : 'success';
      particles.current.push({
        id: nextParticleId(),
        route: ['user', 'app', 'db', hit ? 'ram' : missStorage],
        leg: 0,
        t: 0,
        speed: 0.9 + Math.random() * 0.2,
        outcome,
      });
    }
    particles.current = advanceParticles(particles.current, dt).alive.slice(-80);
    rerender();
  });

  const particleViews: ParticleView[] = particles.current.map((particle) => ({
    id: particle.id,
    from: particle.route[particle.leg],
    to: particle.route[particle.leg + 1],
    t: particle.t,
    outcome: particle.outcome ?? 'success',
  }));

  const edges: DiagramEdge[] = [
    { from: 'user', to: 'app', tone: far ? 'danger' : 'brand', width: far ? 3 : 2 },
    { from: 'app', to: 'db', tone: 'brand', width: 2 },
    { from: 'db', to: 'ram', tone: 'ok', faded: ramHitRate <= 0 },
    { from: 'db', to: 'ssd', tone: 'warn', dashed: missStorage !== 'ssd', faded: missStorage !== 'ssd' || ramHitRate >= 1 },
    { from: 'db', to: 'hdd', tone: 'warn', dashed: missStorage !== 'hdd', faded: missStorage !== 'hdd' || ramHitRate >= 1 },
  ];

  const missShare = 1 - ramHitRate;

  return (
    <LabShell
      title="Capacity Estimation Lab"
      description="Follow one request hop by hop, from the user to the data and back, and see which hop decides how long it takes."
      running={running}
      onRunningChange={setRunning}
      onReset={() => {
        onReset();
        particles.current = [];
      }}
      actions={viewSwitch}
      legend={
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
          <ParticleLegend outcomes={['success', 'cache-hit']} />
          <span className="text-[11px] text-faint">
            A dot is one sampled request. A diamond finds its page in RAM; a circle misses and reads from{' '}
            {missStorage === 'ssd' ? 'the SSD' : 'the spinning disk'}. Dashed: storage this setup does not use. Wire
            color follows the cost of a hop: green for RAM, amber for storage, red for another continent.
          </span>
        </div>
      }
      insight={
        <Insight>
          One request takes about <strong className="text-ink">{formatDuration(time.totalMs)}</strong>, and the{' '}
          <strong className="text-ink">{dominant.label.toLowerCase()}</strong> is {formatPercent(share(dominant.totalMs))} of
          it. {adviceFor(time, inputs)}
        </Insight>
      }
      metrics={
        <>
          <MetricsPanel
            title="Estimates"
            items={[
              { key: 'total', label: 'One request', value: formatDuration(time.totalMs), tone: 'brand', hint: 'Every hop the request pays, one after another.', simulated: true },
              { key: 'dominant', label: 'Dominant hop', value: dominant.label, tone: 'brand', hint: 'The hop that costs the most in total - the one worth removing.', sub: `${formatPercent(share(dominant.totalMs))} of the time` },
              { key: 'userTrips', label: 'Round trips to the user', value: formatDuration(hop('user').totalMs), hint: 'Distance sets this: light in fibre covers about 200 km per millisecond.', sub: `${userCalls} x ${formatDuration(USER_ROUND_TRIP_MS[region])}`, simulated: true },
              { key: 'avgRead', label: 'Average read', value: formatDuration(averageReadMs(ramHitRate, missStorage)), hint: 'Hits from RAM, misses from storage, weighted by the hit rate.', sub: `${formatPercent(ramHitRate)} from RAM`, simulated: true },
            ]}
          />

          <div className="card p-5">
            <div className="mb-4 flex items-center gap-2">
              <Timer className="h-4 w-4 text-brand" />
              <h3 className="text-sm font-semibold text-ink">One request, hop by hop</h3>
            </div>
            <ol className="space-y-2">
              {time.hops.map((each) => {
                const part = share(each.totalMs);
                const top = each.id === time.dominant;
                return (
                  <li
                    key={each.id}
                    className={cn(
                      'grid gap-2 rounded-xl border px-4 py-3 sm:grid-cols-[170px_1fr_auto] sm:items-center',
                      top ? 'border-warn/50 bg-warn/5' : 'border-line',
                    )}
                  >
                    <span className="text-xs font-medium text-ink">
                      {each.label}
                      {top ? <span className="ml-2 text-[11px] font-normal text-warn">dominant</span> : null}
                    </span>
                    <span className="space-y-1">
                      <span className="block font-mono text-[11px] text-muted">
                        {Number(each.count.toPrecision(3))} x {formatDuration(each.eachMs)}
                      </span>
                      <span className="block h-1.5 overflow-hidden rounded-full bg-elevated" aria-hidden>
                        <span
                          className={cn('block h-full rounded-full', top ? 'bg-warn' : 'bg-brand/70')}
                          style={{ width: `${Math.max(part > 0 ? 1 : 0, part * 100)}%` }}
                        />
                      </span>
                    </span>
                    <span className="sm:text-right">
                      <span className={cn('block font-mono text-sm font-semibold', top ? 'text-warn' : 'text-ink')}>
                        = {formatDuration(each.totalMs)}
                      </span>
                      <span className="block font-mono text-[11px] text-faint">{formatPercent(part)} of the total</span>
                    </span>
                  </li>
                );
              })}
            </ol>
            <p className="mt-4 text-[11px] text-faint">
              Simplified model, not a measurement: standard orders of magnitude (~{formatDuration(USER_ROUND_TRIP_MS['same-region'])}{' '}
              round trip nearby, ~{formatDuration(USER_ROUND_TRIP_MS['other-continent'])} across an ocean, ~
              {formatDuration(DATACENTER_HOP_MS)} in a datacenter, ~{formatDuration(RAM_READ_MS)} RAM, ~
              {formatDuration(SSD_READ_MS)} SSD, ~{formatDuration(HDD_SEEK_MS)} disk seek). Calls run one after another,
              with no queueing, and a response crosses one 1 Gbit/s link at full speed.
            </p>
          </div>
        </>
      }
      controls={
        <>
          <div>
            <p className="label mb-2">Where the user is</p>
            <SegmentedControl value={region} options={REGIONS} onChange={change('region')} size="sm" fill />
            <p className="mt-1.5 text-[11px] text-faint">
              The app runs in a US datacenter. Another continent means a user in Europe: an ocean each way.
            </p>
          </div>
          <Slider
            label="Calls from the user, one after another"
            value={userCalls}
            min={1}
            max={50}
            onChange={change('userCalls')}
            format={(value) => `${value} call${value > 1 ? 's' : ''}`}
            hint="A page that asks once per cart item pays one round trip per item. Batched, it is one call."
          />
          <Slider
            label="Database calls per user call"
            value={dbCalls}
            min={1}
            max={200}
            onChange={change('dbCalls')}
            format={(value) => `${value} quer${value > 1 ? 'ies' : 'y'}`}
            hint="One query per item in a list is the N+1 pattern: each pays a datacenter hop."
          />
          <Slider
            label="Reads found in RAM"
            value={ramHitRate}
            min={0}
            max={1}
            step={0.01}
            onChange={change('ramHitRate')}
            format={formatPercent}
            hint="The rest miss and read from storage. 100% means all the data is in memory."
          />
          <div>
            <p className="label mb-2">A miss reads from</p>
            <SegmentedControl value={missStorage} options={STORAGES} onChange={change('missStorage')} size="sm" fill />
          </div>
          <Slider
            label="Response size"
            value={Math.log10(responseKb)}
            min={0}
            max={6}
            step={0.1}
            onChange={(value) => change('responseKb')(Number((10 ** value).toPrecision(2)))}
            format={() => formatKb(responseKb)}
            scale={['1 KB', '1 GB']}
            hint="Logarithmic. At 1 Gbit/s (about 125 MB/s) a web page crosses in microseconds; a backup takes seconds."
          />
        </>
      }
    >
      <DiagramCanvas layout={LAYOUT} edges={edges} particles={particleViews} height={HEIGHT} className="bg-canvas">
        <ArchNode
          kind="client"
          title={far ? 'User in Europe' : 'User in the US'}
          subtitle="app runs in the US"
          placed={LAYOUT.user}
          alert={time.dominant === 'user' || time.dominant === 'transfer'}
        >
          <NodeStatRow label="Round trip" value={`~${formatDuration(USER_ROUND_TRIP_MS[region])}`} tone={far ? 'text-danger' : 'text-ink'} />
          <NodeStatRow label="Calls in a row" value={`${userCalls}`} />
          <NodeStatRow label="Response" value={formatDuration(hop('transfer').eachMs)} tone="text-violet" />
        </ArchNode>
        <ArchNode kind="server" title="App server" subtitle="US datacenter" placed={LAYOUT.app}>
          <NodeStatRow label="DB calls" value={`${dbCalls} per call`} />
        </ArchNode>
        <ArchNode kind="sql" title="Database" subtitle="same datacenter" placed={LAYOUT.db} alert={time.dominant === 'datacenter'}>
          <NodeStatRow label="Hop" value={`~${formatDuration(DATACENTER_HOP_MS)}`} />
          <NodeStatRow label="All hops" value={formatDuration(hop('datacenter').totalMs)} tone="text-brand" />
        </ArchNode>
        <ArchNode kind="cache" title="RAM" subtitle="page in memory" placed={LAYOUT.ram}>
          <NodeStatRow label="Read" value={`~${formatDuration(RAM_READ_MS)}`} tone="text-ok" />
          <NodeStatRow label="Reads here" value={formatPercent(ramHitRate)} />
        </ArchNode>
        <ArchNode
          kind="storage"
          title="SSD"
          subtitle="page on disk"
          placed={LAYOUT.ssd}
          alert={time.dominant === 'storage' && missStorage === 'ssd'}
        >
          <NodeStatRow label="Read" value={`~${formatDuration(SSD_READ_MS)}`} tone="text-warn" />
          <NodeStatRow label="Reads here" value={missStorage === 'ssd' ? formatPercent(missShare) : 'unused'} />
        </ArchNode>
        <ArchNode
          kind="storage"
          title="Spinning disk"
          subtitle="page on disk"
          placed={LAYOUT.hdd}
          alert={time.dominant === 'storage' && missStorage === 'hdd'}
        >
          <NodeStatRow label="Seek" value={`~${formatDuration(HDD_SEEK_MS)}`} tone="text-warn" />
          <NodeStatRow label="Reads here" value={missStorage === 'hdd' ? formatPercent(missShare) : 'unused'} />
        </ArchNode>
      </DiagramCanvas>
      <p className="border-t border-line px-4 py-2 text-[11px] text-faint">
        Simplified model: the latencies are standard orders of magnitude, not measurements of any real system.
      </p>
    </LabShell>
  );
}
