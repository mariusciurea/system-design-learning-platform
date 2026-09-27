import { useMemo, useRef, type ReactNode } from 'react';
import { Calculator, Scale } from 'lucide-react';
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
import { SegmentedControl, Slider, Toggle } from '@/components/ui';
import { advanceParticles, nextParticleId, useTicker, type Particle } from '@/simulations/engine';
import { useLabSetup } from '@/hooks/useLabSetup';
import { useRerender } from '@/hooks/useRerender';
import { cn } from '@/utils/cn';
import { clamp, sampleArrivals } from '@/utils/math';
import { formatCompact, formatNumber } from '@/utils/format';
import type { LabProps, RequestOutcome } from '@/types';
import {
  PRIMARY_WRITE_LIMIT,
  SCALE_LABEL,
  SERVER_CAPACITY,
  WRITE_DECISION_LABEL,
  capacitySteps,
  exactEstimate,
  formatCopies,
  formatGigabitsPerSec,
  formatMegabytesPerSec,
  formatPowerOfTen,
  formatRate,
  formatSize,
  numberFormats,
  offBy,
  roughEstimate,
  sameDecision,
  scaleOf,
  writeDecisionOf,
  type Estimate,
} from './capacityModel';
import { CapacitySpeedView } from './CapacitySpeedView';
import { startOf, type CapacityView, type SizeSetup } from './capacitySetup';
import type { SpeedInputs } from './latencyModel';
import { useLabRunning } from '@/hooks/useLabRunning';

const VIEWS: { value: CapacityView; label: string }[] = [
  { value: 'size', label: 'Size' },
  { value: 'speed', label: 'Speed' },
];

const LAYOUT: Layout = {
  clients: { x: 16, y: 167, w: 176, h: 128 },
  lb: { x: 226, y: 150, w: 200, h: 160 },
  app: { x: 460, y: 130, w: 244, h: 200 },
  db: { x: 740, y: 20, w: 204, h: 160 },
  storage: { x: 740, y: 276, w: 204, h: 164 },
};
const HEIGHT = 460;

/** Particles emitted per second: a log of the peak rate, so 10x more traffic reads as visibly busier. */
const visualRate = (peakQps: number) => clamp(1.5 + 2.4 * Math.log10(Math.max(1, peakQps)), 1.5, 16);

/** Up to this many squares in the app tier; above it each square stands for several servers. */
const MAX_PIPS = 48;
const PIP_STEPS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1_000, 2_000, 5_000, 10_000];

const formatObjectKb = (kb: number) => (kb < 1_000 ? `${Number(kb.toPrecision(2))} KB` : `${Number((kb / 1_000).toPrecision(2))} MB`);
const formatOffBy = (factor: number) => (Number.isFinite(factor) ? `${factor < 1.05 ? '1.0' : factor.toFixed(1)}x` : '-');

export function CapacityLab({ focus }: LabProps<'capacity'>) {
  // The page keys this lab by Concept, so the focus never changes under a mounted lab.
  const start = startOf(focus);
  // Every control of both views lives in one object, so Reset cannot miss one - not even the view.
  const { setup, setSetup, change } = useLabSetup(start);
  const reset = () => setSetup(start);
  // Each view changes only its own keys of the one Setup.
  const changeSpeed =
    <K extends keyof SpeedInputs>(key: K) =>
    (value: SpeedInputs[K]) =>
      setSetup((current) => ({ ...current, [key]: value }));
  const changeSize =
    <K extends keyof SizeSetup>(key: K) =>
    (value: SizeSetup[K]) =>
      setSetup((current) => ({ ...current, [key]: value }));
  const viewSwitch = <SegmentedControl value={setup.view} options={VIEWS} onChange={change('view')} />;
  return setup.view === 'speed' ? (
    <CapacitySpeedView inputs={setup} change={changeSpeed} onReset={reset} viewSwitch={viewSwitch} />
  ) : (
    <CapacitySizeView setup={setup} change={changeSize} onReset={reset} viewSwitch={viewSwitch} />
  );
}

interface SizeViewProps {
  setup: SizeSetup;
  change: <K extends keyof SizeSetup>(key: K) => (value: SizeSetup[K]) => void;
  onReset: () => void;
  viewSwitch: ReactNode;
}

function CapacitySizeView({ setup, change, onReset, viewSwitch }: SizeViewProps) {
  const { dau, requestsPerUser, writeShare, objectSizeKb, peakFactor, retentionYears, replicationFactor, rounding } = setup;

  const exact = useMemo(() => exactEstimate(setup), [setup]);
  const rough = useMemo(() => roughEstimate(setup), [setup]);
  const est: Estimate = rounding ? rough : exact;
  const u = est.used;

  // Number formatting follows the mode: napkin powers of ten, or the exact figures.
  const { big, rate, small } = numberFormats(rounding);
  const orExact = (text: string) => (rounding ? text : undefined);

  const scale = scaleOf(est.peakQps);
  const exactScale = scaleOf(exact.peakQps);
  const writeDecision = writeDecisionOf(est.peakWriteQps);
  const exactWriteDecision = writeDecisionOf(exact.peakWriteQps);
  const writesOverflow = writeDecision === 'partition';
  const readWriteRatio = writeShare >= 1 ? 0 : (1 - writeShare) / writeShare;

  const steps = useMemo(() => capacitySteps(setup, rounding), [setup, rounding]);

  // ---- moving traffic -------------------------------------------------------
  const [running, setRunning] = useLabRunning();
  const particles = useRef<Particle[]>([]);
  const rerender = useRerender(30);

  useTicker(running, (dt) => {
    const arrivals = sampleArrivals(visualRate(est.peakQps), dt);
    for (let index = 0; index < arrivals; index += 1) {
      // A write puts a row and an object; a read gets them. Both halves ride the same wire to the
      // app tier, so they look like one dot that splits there. Reads and writes are both plain
      // requests: no particle outcome means "write", so the mix is stated in the legend instead.
      const outcome: RequestOutcome = 'success';
      const speed = 0.85 + Math.random() * 0.3;
      particles.current.push(
        { id: nextParticleId(), route: ['clients', 'lb', 'app', 'db'], leg: 0, t: 0, speed, outcome },
        { id: nextParticleId(), route: ['clients', 'lb', 'app', 'storage'], leg: 0, t: 0, speed, outcome },
      );
    }
    particles.current = advanceParticles(particles.current, dt).alive.slice(-160);
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

  // Wires thicken with the order of magnitude of the traffic they carry.
  const wire = (qps: number) => 1.25 + clamp(Math.log10(Math.max(1, qps)) - 1, 0, 6) * 0.45;
  const edges: DiagramEdge[] = [
    { from: 'clients', to: 'lb', tone: 'brand', width: wire(est.peakQps) },
    { from: 'lb', to: 'app', tone: 'brand', width: wire(est.peakQps) },
    { from: 'app', to: 'db', tone: writesOverflow ? 'warn' : 'default', width: wire(est.peakQps) },
    { from: 'app', to: 'storage', tone: 'default', width: wire(est.peakQps) },
  ];

  const pipSize = PIP_STEPS.find((size) => est.servers / size <= MAX_PIPS) ?? PIP_STEPS[PIP_STEPS.length - 1];
  const pipCount = Math.min(MAX_PIPS, Math.ceil(est.servers / pipSize));
  const tilde = rounding ? '~' : '';

  return (
    <LabShell
      title="Capacity Estimation Lab"
      description="Turn product numbers into infrastructure numbers, and see each one land on the part of the system it sizes."
      running={running}
      onRunningChange={setRunning}
      onReset={() => {
        // Back to this Concept's starting setup, not the lab's global default.
        onReset();
        particles.current = [];
      }}
      actions={viewSwitch}
      legend={<CapacityLegend writeShare={writeShare} />}
      insight={
        <Insight>
          {rounding ? (
            <>
              On the napkin the peak is {formatPowerOfTen(rough.peakQps)} req/sec; the exact sum gives{' '}
              {formatRate(exact.peakQps)} - off by {formatOffBy(offBy(rough.peakQps, exact.peakQps))}.{' '}
              {sameDecision(rough, exact) ? (
                <>
                  Both land at the same scale, <strong className="text-ink">{SCALE_LABEL[scale].toLowerCase()}</strong>,
                  and both say <strong className="text-ink">{WRITE_DECISION_LABEL[writeDecision].toLowerCase()}</strong>{' '}
                  for the database, so the rough answer leads to the same design. That is the point of rounding: you
                  trade precision you did not need for an answer you can get in your head.
                </>
              ) : (
                <>
                  Here they lead to different designs (
                  {[
                    scale !== exactScale && `${SCALE_LABEL[scale].toLowerCase()} against ${SCALE_LABEL[exactScale].toLowerCase()}`,
                    writeDecision !== exactWriteDecision &&
                      `${WRITE_DECISION_LABEL[writeDecision].toLowerCase()} against ${WRITE_DECISION_LABEL[exactWriteDecision].toLowerCase()}`,
                  ]
                    .filter(Boolean)
                    .join('; ')}
                  ): the estimate sits near a boundary, which is exactly when to stop rounding and do the exact arithmetic.
                </>
              )}
            </>
          ) : (
            <>
              At {formatRate(exact.peakQps)} peak requests/sec you need about {exact.serversAtPeak} app server
              {exact.serversAtPeak > 1 ? 's' : ''} at {formatNumber(SERVER_CAPACITY)} req/sec each - plus 50% headroom,
              so call it {exact.servers}. That puts the design at the scale{' '}
              <strong className="text-ink">{SCALE_LABEL[exactScale].toLowerCase()}</strong>. Storage grows to{' '}
              {formatSize(exact.storedBytes)} including replication.{' '}
              {exactWriteDecision === 'partition'
                ? `At ${formatRate(exact.peakWriteQps)} peak writes/sec a single database primary will not absorb the writes - plan for partitioning early.`
                : `Peak writes of ${formatRate(exact.peakWriteQps)}/sec fit on one primary database; reads scale out with replicas and caching.`}{' '}
              Switch on rounding to see the napkin version of the same estimate.
            </>
          )}
        </Insight>
      }
      metrics={
        <>
          <MetricsPanel
            title="Estimates"
            items={[
              { key: 'avgQps', label: 'Average QPS', value: `${tilde}${rate(est.avgQps)}`, tone: 'brand', hint: 'Requests per second averaged over 24 hours.', sub: orExact(`exact ${formatRate(exact.avgQps)}`) },
              { key: 'peakQps', label: 'Peak QPS', value: `${tilde}${rate(est.peakQps)}`, tone: 'brand', hint: 'What you must actually provision for.', sub: orExact(`exact ${formatRate(exact.peakQps)}`) },
              { key: 'writeQps', label: 'Peak writes/sec', value: `${tilde}${rate(est.peakWriteQps)}`, hint: 'Writes are usually the hard constraint: they all go to the primary.', sub: orExact(`exact ${formatRate(exact.peakWriteQps)}`) },
              {
                key: 'ratio',
                label: 'Read:write',
                value: writeShare >= 1 ? 'writes only' : `${Number(readWriteRatio.toPrecision(2))}:1`,
                hint: 'A high ratio means caching and read replicas will help a lot.',
              },
              { key: 'yearly', label: 'Storage/year', value: `${tilde}${formatSize(est.yearlyBytes)}`, hint: 'Before replication.', sub: orExact(`exact ${formatSize(exact.yearlyBytes)}`) },
              {
                key: 'bandwidth',
                label: 'Peak bandwidth',
                value: `${tilde}${formatMegabytesPerSec(est.bandwidthBytesPerSec)}`,
                tone: 'violet',
                hint: 'Simplified: every request moves one object. Links are sold in bits: multiply bytes by 8.',
                sub: rounding
                  ? `${formatGigabitsPerSec(est.bandwidthBytesPerSec)}, exact ${formatMegabytesPerSec(exact.bandwidthBytesPerSec)}`
                  : formatGigabitsPerSec(est.bandwidthBytesPerSec),
              },
            ]}
          />

          {rounding ? <RoughVersusExact rough={rough} exact={exact} /> : null}

          <div className="card p-5">
            <div className="mb-4 flex items-center gap-2">
              <Calculator className="h-4 w-4 text-brand" />
              <h3 className="text-sm font-semibold text-ink">Step by step{rounding ? ', rounded' : ''}</h3>
            </div>
            <ol className="space-y-2">
              {steps.map((step, index) => (
                <li
                  key={step.id}
                  className={cn(
                    'grid gap-2 rounded-xl border px-4 py-3 sm:grid-cols-[190px_1fr_auto] sm:items-center',
                    step.emphasis ? 'border-brand/40 bg-brand/5' : 'border-line',
                  )}
                >
                  <span className="text-xs font-medium text-ink">
                    <span className="flex items-center gap-2">
                      <span className="font-mono text-[11px] text-faint">{index + 1}</span>
                      {step.label}
                    </span>
                    <span className="mt-0.5 block pl-4 text-[11px] font-normal text-faint">sizes: {step.part}</span>
                  </span>
                  <span className="font-mono text-[11px] text-muted">{step.formula}</span>
                  <span className="sm:text-right">
                    <span className={cn('block font-mono text-sm font-semibold', step.emphasis ? 'text-brand' : 'text-ink')}>
                      = {step.result}
                    </span>
                    {step.exact ? <span className="block font-mono text-[11px] text-faint">exact {step.exact}</span> : null}
                  </span>
                </li>
              ))}
            </ol>

            <div className="mt-5 grid gap-4 border-t border-line pt-4 sm:grid-cols-3">
              <div>
                <p className="label">App servers needed</p>
                <p className="metric-value mt-1 text-ink">{formatNumber(est.servers)}</p>
                <p className="mt-1 text-[11px] text-faint">
                  at {formatNumber(SERVER_CAPACITY)} req/sec each (a simplified planning number), with 50% headroom
                </p>
              </div>
              <div>
                <p className="label">Cache memory (20% hot)</p>
                <p className="metric-value mt-1 text-ink">{formatSize(est.cacheBytes)}</p>
                <p className="mt-1 text-[11px] text-faint">20% of one day of new objects - the 80/20 rule of thumb</p>
              </div>
              <div>
                <p className="label">{retentionYears}-year storage</p>
                <p className="metric-value mt-1 text-ink">{formatSize(est.storedBytes)}</p>
                <p className="mt-1 text-[11px] text-faint">including replication ({formatCopies(u.replicationFactor)})</p>
              </div>
            </div>
          </div>
        </>
      }
      controls={
        <>
          <Toggle
            label="Round to powers of ten"
            checked={rounding}
            onChange={change('rounding')}
            description="Napkin math: users, requests, seconds and bytes become 10^n; small factors keep one figure."
          />
          <Slider
            label="Daily active users"
            value={Math.log10(dau)}
            min={3}
            max={9}
            step={0.1}
            onChange={(value) => change('dau')(Math.round(10 ** value))}
            format={() => formatCompact(dau)}
            scale={['1k', '1B']}
            hint="Logarithmic - system design decisions change per order of magnitude."
          />
          <Slider
            label="Requests per user per day"
            value={requestsPerUser}
            min={1}
            max={200}
            onChange={change('requestsPerUser')}
            format={(value) => `${value}`}
          />
          <Slider
            label="Write share"
            value={writeShare}
            min={0.01}
            max={1}
            step={0.01}
            onChange={change('writeShare')}
            format={(value) => `${Math.round(value * 100)}% writes`}
            hint="Most consumer products are read-heavy - often 10:1 or more."
          />
          <Slider
            label="Average object size"
            value={Math.log10(objectSizeKb)}
            min={-1}
            max={3.3}
            step={0.05}
            onChange={(value) => change('objectSizeKb')(Number((10 ** value).toPrecision(2)))}
            format={() => formatObjectKb(objectSizeKb)}
            scale={['100 B', '2 MB']}
            hint="Logarithmic. A chat message is well under 1 KB; a photo is a few MB."
          />
          <Slider
            label="Peak factor"
            value={peakFactor}
            min={1}
            max={20}
            onChange={change('peakFactor')}
            format={(value) => `${value}x average`}
            hint="Traffic is never flat. 2-10x is typical depending on the product."
          />
          <Slider
            label="Retention"
            value={retentionYears}
            min={1}
            max={10}
            onChange={change('retentionYears')}
            format={(value) => `${value} year${value > 1 ? 's' : ''}`}
          />
          <Slider
            label="Replication factor"
            value={replicationFactor}
            min={1}
            max={5}
            onChange={change('replicationFactor')}
            format={formatCopies}
            hint="Durability costs storage: three copies means three times the bill."
          />
        </>
      }
    >
      <DiagramCanvas layout={LAYOUT} edges={edges} particles={particleViews} height={HEIGHT} className="bg-canvas">
        <ArchNode kind="client" title="Clients" subtitle={`${big(u.dau)} DAU x ${small(u.requestsPerUser)}/day`} placed={LAYOUT.clients}>
          <NodeStatRow label="Requests/day" value={`${tilde}${big(est.requestsPerDay)}`} />
          <NodeStatRow label="Average" value={`${tilde}${rate(est.avgQps)}/s`} />
        </ArchNode>
        <ArchNode kind="load-balancer" title="Load balancer" subtitle="pair, sees all traffic" placed={LAYOUT.lb}>
          <NodeStatRow label="Peak" value={`${tilde}${rate(est.peakQps)} req/s`} />
          <NodeStatRow label="Bandwidth" value={`${tilde}${formatMegabytesPerSec(est.bandwidthBytesPerSec)}`} tone="text-violet" />
          <NodeStatRow label="In bits" value={`${tilde}${formatGigabitsPerSec(est.bandwidthBytesPerSec)}`} tone="text-violet" />
        </ArchNode>
        <ArchNode
          kind="server"
          title={`App tier x ${formatNumber(est.servers)}`}
          subtitle={`${formatNumber(SERVER_CAPACITY)} req/s each (simplified)`}
          placed={LAYOUT.app}
        >
          <div className="flex flex-wrap gap-[3px]" aria-label={`${est.servers} app servers`}>
            {Array.from({ length: pipCount }, (_, index) => (
              <span key={index} className="h-[9px] w-[9px] rounded-[2px] bg-brand/70" />
            ))}
          </div>
          <p className="text-[11px] text-faint">
            {pipSize > 1 ? `1 square = ${formatNumber(pipSize)} servers` : '1 square = 1 server'}
          </p>
          <NodeStatRow label="Needed at peak" value={formatNumber(est.serversAtPeak)} />
          <NodeStatRow label="With 50% headroom" value={formatNumber(est.servers)} tone="text-brand" />
        </ArchNode>
        <ArchNode
          kind="sql"
          title="Database"
          subtitle="primary + read replicas"
          placed={LAYOUT.db}
          alert={writesOverflow}
          status={writesOverflow ? 'degraded' : 'healthy'}
          statusLabel={WRITE_DECISION_LABEL[writeDecision]}
        >
          <NodeStatRow label="Peak writes" value={`${tilde}${rate(est.peakWriteQps)}/s`} tone={writesOverflow ? 'text-warn' : 'text-ink'} />
          <NodeStatRow label="Peak reads" value={`${tilde}${rate(est.peakReadQps)}/s`} />
          <NodeStatRow label="Primary limit" value={`~${formatCompact(PRIMARY_WRITE_LIMIT)}/s`} tone="text-faint" />
        </ArchNode>
        <ArchNode kind="storage" title="Object storage" subtitle={`${formatSize(u.objectBytes)} per write`} placed={LAYOUT.storage}>
          <NodeStatRow label="Per day" value={`${tilde}${formatSize(est.dailyBytes)}`} />
          <NodeStatRow label="Per year" value={`${tilde}${formatSize(est.yearlyBytes)}`} />
          <NodeStatRow
            label={`${u.retentionYears} yr x ${u.replicationFactor} copies`}
            value={`${tilde}${formatSize(est.storedBytes)}`}
            tone="text-brand"
          />
        </ArchNode>
      </DiagramCanvas>
      <p className="border-t border-line px-4 py-2 text-[11px] text-faint">
        Scale: <span className="font-medium text-ink">{SCALE_LABEL[scale]}</span>. Simplified: every request reads or
        writes one row in the database and one object in object storage; 1,000 req/sec per server and 10k writes/sec per
        primary are planning numbers, not measurements.
      </p>
    </LabShell>
  );
}

function CapacityLegend({ writeShare }: { writeShare: number }) {
  const writesInTen = Math.round(writeShare * 10);
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
      <ParticleLegend outcomes={['success']} />
      <span className="text-[11px] text-faint">
        A dot is a sample of the traffic, not one request. Reads and writes look the same: at this mix{' '}
        {writesInTen === 0
          ? 'fewer than 1 dot in 10 is a write'
          : `about ${writesInTen} in 10 dots ${writesInTen === 1 ? 'is a write' : 'are writes'}`}
        . A dot splits at the app tier: one half to the database, one to object storage.
      </span>
    </div>
  );
}

/** Napkin mode only: the rough answer next to the exact one, and whether the decision changed. */
function RoughVersusExact({ rough, exact }: { rough: Estimate; exact: Estimate }) {
  const rows = [
    { label: 'Peak req/sec', rough: formatPowerOfTen(rough.peakQps), exact: formatRate(exact.peakQps), factor: offBy(rough.peakQps, exact.peakQps) },
    { label: 'App servers', rough: formatNumber(rough.servers), exact: formatNumber(exact.servers), factor: offBy(rough.servers, exact.servers) },
    { label: 'Peak writes/sec', rough: formatPowerOfTen(rough.peakWriteQps), exact: formatRate(exact.peakWriteQps), factor: offBy(rough.peakWriteQps, exact.peakWriteQps) },
    { label: 'Stored, with copies', rough: formatSize(rough.storedBytes), exact: formatSize(exact.storedBytes), factor: offBy(rough.storedBytes, exact.storedBytes) },
    { label: 'Peak bandwidth', rough: formatMegabytesPerSec(rough.bandwidthBytesPerSec), exact: formatMegabytesPerSec(exact.bandwidthBytesPerSec), factor: offBy(rough.bandwidthBytesPerSec, exact.bandwidthBytesPerSec) },
  ];
  const decisions = [
    { label: 'Scale', rough: SCALE_LABEL[scaleOf(rough.peakQps)], exact: SCALE_LABEL[scaleOf(exact.peakQps)] },
    { label: 'Database', rough: WRITE_DECISION_LABEL[writeDecisionOf(rough.peakWriteQps)], exact: WRITE_DECISION_LABEL[writeDecisionOf(exact.peakWriteQps)] },
  ];
  const same = sameDecision(rough, exact);
  return (
    <div className="card p-5">
      <div className="mb-3 flex items-center gap-2">
        <Scale className="h-4 w-4 text-brand" />
        <h3 className="text-sm font-semibold text-ink">Rough against exact</h3>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[420px] text-left text-xs">
          <thead>
            <tr className="text-[11px] uppercase tracking-wide text-faint">
              <th className="py-1.5 pr-3 font-medium">Estimate</th>
              <th className="py-1.5 pr-3 font-medium">Rough</th>
              <th className="py-1.5 pr-3 font-medium">Exact</th>
              <th className="py-1.5 font-medium">Off by</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.label} className="border-t border-line">
                <td className="py-1.5 pr-3 text-muted">{row.label}</td>
                <td className="py-1.5 pr-3 font-mono text-ink">{row.rough}</td>
                <td className="py-1.5 pr-3 font-mono text-muted">{row.exact}</td>
                <td className={cn('py-1.5 font-mono', row.factor <= 3.16 ? 'text-ok' : 'text-warn')}>
                  {formatOffBy(row.factor)} {row.factor <= 3.16 ? '(same order)' : '(order apart)'}
                </td>
              </tr>
            ))}
            {decisions.map((row) => (
              <tr key={row.label} className="border-t border-line">
                <td className="py-1.5 pr-3 text-muted">{row.label}</td>
                <td className="py-1.5 pr-3 text-ink">{row.rough}</td>
                <td className="py-1.5 pr-3 text-muted">{row.exact}</td>
                <td className={cn('py-1.5 font-mono', row.rough === row.exact ? 'text-ok' : 'text-warn')}>
                  {row.rough === row.exact ? 'same' : 'different'}
                </td>
              </tr>
            ))}
            <tr className="border-t border-line">
              <td className="py-1.5 pr-3 font-medium text-ink" colSpan={3}>
                Design
              </td>
              <td className={cn('py-1.5 font-mono font-semibold', same ? 'text-ok' : 'text-warn')}>
                {same ? 'same decision' : 'different decision'}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-[11px] text-faint">
        Within about 3x (half an order of magnitude) counts as the same order. The scale and the database decision are
        what the estimate decides; the design is the same only when both match.
      </p>
    </div>
  );
}

export default CapacityLab;
