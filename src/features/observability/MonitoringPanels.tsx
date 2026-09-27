import { LiveChart } from '@/components/charts';
import { SIMULATED_HINT } from '@/components/learning';
import { Button } from '@/components/ui';
import type { SeriesPoint } from '@/simulations/engine';
import { cn } from '@/utils/cn';
import { formatBytes, formatLatency, formatNumber, formatPercent } from '@/utils/format';
import {
  BUCKETS_MS,
  SERVICES,
  SERVICE_LABEL,
  SIGNALS,
  clockText,
  durationText,
  levelKept,
  traceKept,
  type Aggregate,
  type AlertPhase,
  type AlertState,
  type LogLine,
  type ServiceId,
  type Setup,
  type Trace,
} from './monitoringModel';

/* ------------------------------------------------------------------ Logs */

const LEVEL_CLASS = { debug: 'text-faint', info: 'text-muted', warn: 'text-warn', error: 'text-danger' } as const;

function renderLine(line: LogLine, traceId: string, setup: Setup) {
  if (setup.logFormat === 'text') return `${clockText(line.t)} ${line.level.toUpperCase().padEnd(5)} ${line.msg}`;
  return JSON.stringify({
    ts: clockText(line.t),
    level: line.level,
    service: line.service,
    trace_id: traceId,
    msg: line.msg,
    ...line.fields,
  });
}

function LogRow({ line, trace, setup }: { line: LogLine; trace: Trace; setup: Setup }) {
  return (
    <p className={cn('whitespace-pre-wrap break-all', LEVEL_CLASS[line.level])}>
      <span className="sr-only">{line.level} </span>
      {renderLine(line, trace.id, setup)}
    </p>
  );
}

interface LogsViewProps {
  setup: Setup;
  stream: Trace[];
  followed: Trace | null;
  onNext: () => void;
  linesPerSecond: number;
  bytesPerDay: number;
}

export function LogsView({ setup, stream, followed, onNext, linesPerSecond, bytesPerDay }: LogsViewProps) {
  // Interleave the lines of concurrent requests the way a real log stream does.
  const kept = stream.filter((trace) => traceKept(trace, setup.sampleSuccess));
  const rows: { line: LogLine; trace: Trace; order: number }[] = [];
  kept.forEach((trace, traceIndex) =>
    trace.lines.forEach((line, lineIndex) => {
      if (levelKept(line.level, setup.logLevel)) rows.push({ line, trace, order: line.t * 1000 + lineIndex * 10 + traceIndex });
    }),
  );
  rows.sort((a, b) => a.order - b.order);
  const tail = rows.slice(-10);

  const followedLines = followed ? followed.lines.filter((line) => levelKept(line.level, setup.logLevel)) : [];
  const shownLines = setup.logFormat === 'json' ? followedLines : followedLines.filter((line) => line.level === 'error');
  const services = new Set(shownLines.map((line) => line.service)).size;

  return (
    <div className="space-y-4">
      <div>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <p className="label">One failing request</p>
          <Button size="sm" variant="secondary" onClick={onNext}>
            Next failing request
          </Button>
        </div>
        {!followed ? (
          <p className="text-xs text-faint">No request has failed yet. Pick a fault that makes requests fail.</p>
        ) : (
          <>
            <p className="mb-2 text-xs text-muted">
              {setup.logFormat === 'json' ? (
                <>
                  Query: <span className="font-mono text-ink">trace_id = &quot;{followed.id}&quot;</span> - {shownLines.length}{' '}
                  line{shownLines.length === 1 ? '' : 's'} from {services} service{services === 1 ? '' : 's'}, in order.
                </>
              ) : (
                <>
                  Query: <span className="font-mono text-ink">grep ERROR</span> - the line has no trace_id and no service,
                  so nothing joins it to the rest of its request.
                </>
              )}
            </p>
            <div className="rounded-lg border border-line bg-elevated p-3 font-mono text-[11px] leading-relaxed">
              {shownLines.map((line, index) => (
                <LogRow key={index} line={line} trace={followed} setup={setup} />
              ))}
            </div>
            <p className="mt-2 text-xs text-faint">
              {setup.logFormat === 'text'
                ? `It is one of about ${formatNumber(linesPerSecond)} lines written every second, from every request at once.`
                : setup.logLevel === 'error'
                  ? 'Only ERROR lines are written, so the trace_id finds this one line: which request it was and the path it took were never logged.'
                  : setup.logLevel === 'warn'
                    ? 'At WARN only the failure and its warning are written - the route and the status code sent back were never logged.'
                    : 'Read top to bottom: the gateway received it, orders called payments, payments failed, orders returned 502.'}
            </p>
          </>
        )}
      </div>

      <div>
        <p className="label mb-2">Live log stream (every service, interleaved)</p>
        <div className="max-h-56 overflow-y-auto rounded-lg border border-line bg-elevated p-3 font-mono text-[11px] leading-relaxed">
          {tail.length === 0 ? (
            <p className="text-faint">Nothing written at this level yet.</p>
          ) : (
            tail.map(({ line, trace }, index) => <LogRow key={`${trace.id}-${index}`} line={line} trace={trace} setup={setup} />)
          )}
        </div>
        <p className="mt-2 text-xs text-faint">
          About {formatNumber(linesPerSecond)} lines/s, {formatBytes(bytesPerDay)} per day at this level and format.
          Byte sizes per line are rough ({setup.logFormat === 'json' ? '320' : '110'} bytes): {SIMULATED_HINT}
        </p>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- Metrics */

interface MetricsViewProps {
  setup: Setup;
  chart: SeriesPoint[];
  gateway: Aggregate;
  series: number;
}

const WINDOW_TEXT: Record<number, string> = { 10: '10 s', 60: '1 min', 300: '5 min' };

export function MetricsView({ setup, chart, gateway, series }: MetricsViewProps) {
  const maxBucket = Math.max(1, ...gateway.hist);
  const window = WINDOW_TEXT[setup.windowS] ?? `${setup.windowS} s`;
  return (
    <div className="space-y-4">
      <div>
        <p className="label mb-2">Gateway latency, aggregated over {window}</p>
        <LiveChart
          data={chart}
          series={[
            { key: 'avg', label: 'Average', color: 'info' },
            // Series colours name the line only; green and red stay for status.
            { key: 'p50', label: 'p50', color: 'brand' },
            { key: 'p99', label: 'p99', color: 'violet' },
          ]}
          variant="line"
          height={170}
          formatValue={(value) => formatLatency(value)}
        />
      </div>
      <div>
        <p className="label mb-2">Gateway error ratio, over {window}</p>
        <LiveChart
          data={chart}
          series={[{ key: 'errorPct', label: 'Error ratio %', color: 'danger' }]}
          height={110}
          formatValue={(value) => `${value.toFixed(2)}%`}
        />
      </div>
      <div>
        <p className="label mb-2">The histogram behind those lines (requests per latency bucket, last {window})</p>
        <div className="flex h-24 items-end gap-1">
          {gateway.hist.map((count, index) => (
            <div key={index} className="flex min-w-0 flex-1 flex-col items-center gap-1">
              <div
                className={cn('w-full rounded-t', BUCKETS_MS[index] > 1000 ? 'bg-danger/70' : 'bg-brand/60')}
                style={{ height: `${Math.max(count > 0 ? 3 : 0, (count / maxBucket) * 72)}px` }}
                title={`${formatNumber(count)} requests`}
              />
              <span className="truncate font-mono text-[11px] text-faint">
                {Number.isFinite(BUCKETS_MS[index]) ? `${BUCKETS_MS[index] >= 1000 ? `${BUCKETS_MS[index] / 1000}s` : BUCKETS_MS[index]}` : 'inf'}
              </span>
            </div>
          ))}
        </div>
        <p className="mt-2 text-xs text-faint">
          Bucket upper bounds in ms. A percentile is estimated from these counts, like Prometheus histogram_quantile,
          so p99 is only as precise as the bucket it lands in. Time series stored:{' '}
          <span className={cn('font-mono', setup.userIdLabel ? 'text-danger' : 'text-ink')}>{formatNumber(series)}</span>
          {setup.userIdLabel ? ' - one per user, per route, per status, per bucket.' : '.'} {SIMULATED_HINT}
        </p>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- Dashboard */

type Level = 'ok' | 'warn' | 'danger';
const LEVEL_TEXT: Record<Level, string> = { ok: 'OK', warn: 'Watch', danger: 'Bad' };
const LEVEL_TONE: Record<Level, string> = { ok: 'text-ok', warn: 'text-warn', danger: 'text-danger' };

const latencyLevel = (ms: number): Level => (ms > 1000 ? 'danger' : ms > 500 ? 'warn' : 'ok');
const errorLevel = (ratio: number): Level => (ratio > 0.01 ? 'danger' : ratio > 0.003 ? 'warn' : 'ok');
const saturationLevel = (value: number): Level => (value > 0.8 ? 'danger' : value > 0.6 ? 'warn' : 'ok');

function Cell({ value, level }: { value: string; level?: Level }) {
  return (
    <td className="px-2 py-1.5 text-right">
      <span className={cn('font-mono tabular-nums', level ? LEVEL_TONE[level] : 'text-ink')}>{value}</span>
      {level ? <span className={cn('ml-1.5 text-[11px]', LEVEL_TONE[level])}>{LEVEL_TEXT[level]}</span> : null}
    </td>
  );
}

interface DashboardViewProps {
  setup: Setup;
  aggregates: Record<ServiceId, Aggregate>;
  expectedRate: number;
  probe: 'pass' | 'fail' | null;
  chart: SeriesPoint[];
}

export function DashboardView({ setup, aggregates, expectedRate, probe, chart }: DashboardViewProps) {
  const gatewayTrafficLevel: Level = aggregates.gateway.rate < expectedRate * 0.5 ? 'danger' : 'ok';
  const whiteBoxBad = SERVICES.some(
    (id) =>
      errorLevel(aggregates[id].errorRatio) === 'danger' ||
      latencyLevel(aggregates[id].p99) === 'danger' ||
      saturationLevel(aggregates[id].saturation) === 'danger',
  );
  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <p className="label">Inside (white box): errors, latency, saturation</p>
          <p className={cn('mt-1 text-sm font-semibold', whiteBoxBad ? 'text-danger' : 'text-ok')}>
            {whiteBoxBad ? 'Something is wrong' : 'All green'}
          </p>
        </div>
        <div>
          <p className="label">Outside (black box): synthetic probe</p>
          <p
            className={cn(
              'mt-1 text-sm font-semibold',
              probe === 'fail' ? 'text-danger' : probe === 'pass' ? 'text-ok' : 'text-faint',
            )}
          >
            {probe === 'fail' ? 'Probe failing: users cannot load the site' : probe === 'pass' ? 'Probe passing' : 'Probe is off - nobody checks from outside'}
          </p>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[480px] text-xs">
          <caption className="label mb-2 text-left">Golden signals per part, last 1 min</caption>
          <thead>
            <tr className="text-faint">
              <th className="px-2 py-1 text-left font-medium">Part</th>
              <th className="px-2 py-1 text-right font-medium">Latency p99</th>
              <th className="px-2 py-1 text-right font-medium">Traffic</th>
              <th className="px-2 py-1 text-right font-medium">Errors</th>
              <th className="px-2 py-1 text-right font-medium">Saturation</th>
            </tr>
          </thead>
          <tbody>
            {SERVICES.map((id) => {
              const agg = aggregates[id];
              return (
                <tr key={id} className="border-t border-line">
                  <th scope="row" className="px-2 py-1.5 text-left font-medium text-ink">
                    {SERVICE_LABEL[id]}
                  </th>
                  <Cell value={formatLatency(agg.p99)} level={latencyLevel(agg.p99)} />
                  <Cell value={`${formatNumber(agg.rate)}/s`} level={id === 'gateway' ? gatewayTrafficLevel : undefined} />
                  <Cell value={formatPercent(agg.errorRatio, 2)} level={errorLevel(agg.errorRatio)} />
                  <Cell value={formatPercent(agg.saturation)} level={saturationLevel(agg.saturation)} />
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <p className="label mb-2">Traffic at the gateway (req/s)</p>
          <LiveChart
            data={chart}
            series={[
              { key: 'traffic', label: 'Arriving', color: 'brand' },
              { key: 'expected', label: 'Users sending', color: 'faint', dashed: true },
            ]}
            variant="line"
            height={130}
          />
        </div>
        <div>
          <p className="label mb-2">Gateway error ratio (%)</p>
          <LiveChart
            data={chart}
            series={[{ key: 'errorPct1m', label: 'Error ratio %', color: 'danger' }]}
            height={130}
            formatValue={(value) => `${value.toFixed(2)}%`}
          />
        </div>
      </div>
      <p className="text-xs text-faint">
        Traffic has a wave on purpose, like a day of real users squeezed into 10 simulated minutes.
        {setup.probe ? ' The probe runs one scripted page load from outside every 10 simulated seconds.' : ''} {SIMULATED_HINT}
      </p>
    </div>
  );
}

/* ---------------------------------------------------------------- Alerts */

const PHASE_TEXT: Record<AlertPhase, string> = { ok: 'Inactive', pending: 'Pending', firing: 'Firing' };
const PHASE_CLASS: Record<AlertPhase, string> = {
  ok: 'bg-ok/15 text-ok',
  pending: 'bg-warn/15 text-warn',
  firing: 'bg-danger/15 text-danger',
};
const PHASE_CELL: Record<AlertPhase, string> = { ok: 'bg-ok/30', pending: 'bg-warn/60', firing: 'bg-danger/80' };

interface AlertsViewProps {
  setup: Setup;
  alert: AlertState;
  chart: SeriesPoint[];
  timeline: { phase: AlertPhase; hurt: boolean }[];
}

export function AlertsView({ setup, alert, chart, timeline }: AlertsViewProps) {
  const signal = SIGNALS[setup.alertSignal];
  const threshold = signal.unit === 'ms' ? `${setup.threshold} ms` : `${setup.threshold}%`;
  const forText = setup.forS === 0 ? '0s' : setup.forS % 60 === 0 ? `${setup.forS / 60}m` : `${setup.forS}s`;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <pre className="ascii min-w-0 flex-1 rounded-lg border border-line bg-elevated p-3 text-[11px]">
          {`alert: ${setup.alertSignal === 'cpu' ? 'HighCpu' : setup.alertSignal === 'p99' ? 'SlowRequests' : 'HighErrorRatio'}
expr:  ${signal.rule} > ${threshold}
for:   ${forText}`}
        </pre>
        <span className={cn('rounded-md px-2.5 py-1 text-xs font-semibold', PHASE_CLASS[alert.phase])}>
          {PHASE_TEXT[alert.phase]}
        </span>
      </div>

      <div>
        <p className="label mb-2">
          {signal.rule} ({signal.unit}) and the threshold
        </p>
        <LiveChart
          data={chart}
          series={[
            { key: 'signal', label: signal.label, color: setup.alertSignal === 'cpu' ? 'violet' : 'brand' },
            { key: 'threshold', label: 'Threshold', color: 'danger', dashed: true },
          ]}
          variant="line"
          height={160}
          formatValue={(value) => (signal.unit === 'ms' ? formatLatency(value) : `${value.toFixed(1)}%`)}
        />
      </div>

      <div>
        <p className="label mb-2">Last 5 simulated minutes</p>
        <div className="space-y-1">
          <div className="flex h-4 gap-px" role="img" aria-label="Alert state over time">
            {timeline.map((cell, index) => (
              <div key={index} className={cn('flex-1 rounded-sm', PHASE_CELL[cell.phase])} />
            ))}
          </div>
          <div className="flex h-2 gap-px" role="img" aria-label="User pain over time">
            {timeline.map((cell, index) => (
              <div key={index} className={cn('flex-1 rounded-sm', cell.hurt ? 'bg-danger/60' : 'bg-line')} />
            ))}
          </div>
        </div>
        <p className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted">
          <span>Top row: alert state - green inactive, amber pending, red firing.</span>
          <span>Bottom row: red where users were hurting.</span>
        </p>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <Counter label="Pages sent" value={formatNumber(alert.pages)} tone={alert.pages > 0 ? 'text-ink' : 'text-faint'} />
        <Counter
          label="Noisy pages"
          value={formatNumber(alert.noisyPages)}
          tone={alert.noisyPages > 0 ? 'text-warn' : 'text-ok'}
          hint="Pages with no user pain lasting over a minute"
        />
        <Counter
          label="Missed pain"
          value={durationText(alert.missedS)}
          tone={alert.missedS > 0 ? 'text-danger' : 'text-ok'}
          hint="Users hurting for over a minute while nothing fired"
        />
      </div>
      <p className="text-xs text-faint">
        The rule is checked every simulated second; the simulated clock runs 10x faster than real time. User pain
        means over 1% errors, p99 over 1 s, or under half the users reaching the site, for more than a minute.{' '}
        {SIMULATED_HINT}
      </p>
    </div>
  );
}

function Counter({ label, value, tone, hint }: { label: string; value: string; tone: string; hint?: string }) {
  return (
    <div className="min-w-0" title={hint}>
      <p className="text-[11px] uppercase tracking-wide text-faint">{label}</p>
      <p className={cn('mt-0.5 font-mono text-sm font-semibold tabular-nums', tone)}>{value}</p>
      {hint ? <p className="mt-0.5 text-[11px] leading-snug text-faint">{hint}</p> : null}
    </div>
  );
}
