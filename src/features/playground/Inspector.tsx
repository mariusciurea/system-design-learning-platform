import { useId } from 'react';
import { AlertTriangle, Cable, Power, Trash2 } from 'lucide-react';
import type { Node } from 'reactflow';
import { NODE_KINDS } from '@/components/architecture';
import { statusLabel } from '@/components/architecture/HealthIndicator';
import { Badge, Button, Meter, Slider } from '@/components/ui';
import { formatNumber, formatPercent } from '@/utils/format';
import { cn } from '@/utils/cn';
import type { AnalysisResult } from './analysis';
import type { PlaygroundNodeData } from './nodes';

type Severity = AnalysisResult['risks'][number]['severity'];

const SEVERITY_TONE = { high: 'danger', medium: 'warn', low: 'neutral' } as const;
const SEVERITY_ICON: Record<Severity, string> = { high: 'text-danger', medium: 'text-warn', low: 'text-faint' };
/** Risks are listed worst first, so a high one is never under four low ones. */
const SEVERITY_RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

interface InspectorProps {
  nodes: Node<PlaygroundNodeData>[];
  analysis: AnalysisResult;
  traffic: number;
  onTrafficChange: (value: number) => void;
  selected: Node<PlaygroundNodeData> | null;
  onToggleFailure: () => void;
  onRemove: () => void;
  /** Starts tap-to-connect from the selected node: the next node tapped becomes its target. */
  onConnect: () => void;
}

/** Traffic, the selected component, the health scores and the detected risks. */
export function Inspector({
  nodes,
  analysis,
  traffic,
  onTrafficChange,
  selected,
  onToggleFailure,
  onRemove,
  onConnect,
}: InspectorProps) {
  const id = useId();
  const risks = [...analysis.risks].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
  const totalCapacity = nodes
    .filter((node) => node.data.kind === 'server' || node.data.kind === 'service')
    .reduce((sum, node) => sum + (node.data.status === 'down' ? 0 : node.data.capacity), 0);

  return (
    <div className="space-y-3">
      <section aria-labelledby={`${id}-traffic`} className="rounded-xl border border-line p-3">
        <h3 id={`${id}-traffic`} className="label mb-2">
          Traffic
        </h3>
        <Slider
          label="Incoming"
          value={traffic}
          min={100}
          max={20000}
          step={100}
          onChange={onTrafficChange}
          format={(value) => `${formatNumber(value)} req/s`}
        />
        <div className="mt-2 flex items-center justify-between text-[11px] text-faint">
          <span>App tier capacity</span>
          <span className="font-mono text-ink">{formatNumber(totalCapacity)} req/s</span>
        </div>
        {analysis.dropped > 0 ? (
          <p className="mt-2 font-mono text-[11px] text-danger">
            {formatNumber(analysis.dropped)} req/s dropped at failed components
          </p>
        ) : null}
      </section>

      {selected ? (
        <section aria-labelledby={`${id}-selected`} className="rounded-xl border border-line p-3">
          <div className="flex items-center justify-between">
            <h3 id={`${id}-selected`} className="label">
              Selected
            </h3>
            <Badge tone={selected.data.status === 'down' ? 'danger' : 'ok'}>{statusLabel(selected.data.status)}</Badge>
          </div>
          <p className="mt-1.5 text-sm font-semibold text-ink">{selected.data.label}</p>
          <p className="text-[11px] text-faint">{NODE_KINDS[selected.data.kind].blurb}</p>
          {selected.data.capacity > 0 ? (
            <div className="mt-3">
              <Meter
                label={`${formatNumber(analysis.load[selected.id] ?? 0)} / ${formatNumber(selected.data.capacity)} req/s`}
                value={(analysis.load[selected.id] ?? 0) / Math.max(selected.data.capacity, 1)}
              />
            </div>
          ) : null}
          <Button size="sm" variant="secondary" className="mt-3 w-full justify-center" onClick={onConnect}>
            <Cable className="h-3 w-3" />
            Connect to another component
          </Button>
          <div className="mt-2 flex gap-2">
            <Button
              size="sm"
              variant={selected.data.status === 'down' ? 'success' : 'danger'}
              className="flex-1 justify-center"
              onClick={onToggleFailure}
            >
              <Power className="h-3 w-3" />
              {selected.data.status === 'down' ? 'Restore' : 'Simulate failure'}
            </Button>
            <Button size="sm" variant="secondary" onClick={onRemove} aria-label="Delete component">
              <Trash2 className="h-3 w-3" />
            </Button>
          </div>
        </section>
      ) : (
        <p className="rounded-xl border border-dashed border-line p-3 text-[11px] leading-relaxed text-muted">
          Select a component to inspect it, connect it, simulate a failure or delete it.
        </p>
      )}

      {/* Right under the selection: the one finding the canvas also shows, so it is never below the fold. */}
      {analysis.bottlenecks.length > 0 ? (
        <section aria-labelledby={`${id}-bottlenecks`} className="rounded-xl border border-warn/40 bg-warn/5 p-3">
          <h3 id={`${id}-bottlenecks`} className="label mb-2 text-warn">
            Bottlenecks
          </h3>
          <ul className="space-y-2">
            {analysis.bottlenecks.map((id) => {
              const node = nodes.find((item) => item.id === id);
              if (!node) return null;
              const load = analysis.load[id] ?? 0;
              return (
                <li key={id} className="font-mono text-[11px]">
                  <p className="text-ink">{node.data.label}</p>
                  <p className="text-faint">
                    capacity {formatNumber(node.data.capacity)} / incoming {formatNumber(load)} (
                    {formatPercent(load / Math.max(node.data.capacity, 1))})
                  </p>
                </li>
              );
            })}
          </ul>
          <p className="mt-2.5 text-[11px] leading-relaxed text-muted">
            Possible fixes: add another instance, put a cache in front, move the work to a queue, or make the
            operation cheaper.
          </p>
        </section>
      ) : null}

      <section aria-labelledby={`${id}-health`} className="rounded-xl border border-line p-3">
        <h3 id={`${id}-health`} className="label mb-3">
          Architecture health
        </h3>
        {analysis.scored ? (
          <div className="space-y-2.5">
            <ScoreRow label="Scalability" value={analysis.scores.scalability} />
            <ScoreRow label="Availability" value={analysis.scores.availability} />
            <ScoreRow label="Performance" value={analysis.scores.performance} />
            <div className="flex items-center justify-between text-[11px]">
              <span className="text-muted">Complexity</span>
              <Badge tone={analysis.complexity === 'High' ? 'warn' : 'neutral'}>{analysis.complexity}</Badge>
            </div>
            <div className="flex items-center justify-between text-[11px]">
              <span className="text-muted">Cost</span>
              <Badge tone={analysis.cost === 'High' ? 'warn' : 'neutral'}>{analysis.cost}</Badge>
            </div>
          </div>
        ) : (
          // Zero scores in red bars would read as a failing design; with nothing wired there is no design yet.
          <p className="text-[11px] leading-relaxed text-muted">Connect two components to score the design.</p>
        )}
        <p className="mt-3 text-[11px] leading-relaxed text-faint">
          These scores are an educational heuristic, not an engineering measurement. They reward redundancy,
          caching and traffic distribution - the same things a reviewer would ask about.
        </p>
      </section>

      <section aria-labelledby={`${id}-risks`} className="rounded-xl border border-line p-3">
        <h3 id={`${id}-risks`} className="label mb-2">
          Detected risks
        </h3>
        {risks.length === 0 ? (
          <p className="text-[11px] text-muted">
            None of the checks this heuristic runs found a risk at this traffic level. That is not a
            production-readiness review: it does not look at security, backups, data growth or deployment.
          </p>
        ) : (
          <ul className="-mb-1 divide-y divide-line">
            {risks.map((risk) => (
              <li key={risk.id} className="flex items-start gap-2 py-2.5 first:pt-0.5">
                <AlertTriangle aria-hidden className={cn('mt-0.5 h-3.5 w-3.5 shrink-0', SEVERITY_ICON[risk.severity])} />
                <div className="min-w-0 flex-1">
                  <p className="text-[11px] leading-relaxed text-ink">{risk.message}</p>
                  <p className="mt-1 text-[11px] leading-relaxed text-faint">+ {risk.fix}</p>
                </div>
                <Badge tone={SEVERITY_TONE[risk.severity]} className="shrink-0">
                  {risk.severity}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function ScoreRow({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <div className="flex items-center justify-between text-[11px]">
        <span className="text-muted">{label}</span>
        <span className="font-mono text-ink">{value} / 100</span>
      </div>
      {/* Higher is better here, the opposite of a utilization bar, so the colour is set explicitly. */}
      <Meter
        value={value / 100}
        tone={value >= 70 ? 'ok' : value >= 40 ? 'warn' : 'danger'}
        showValue={false}
        size="xs"
        className="mt-1"
      />
    </div>
  );
}
