import { X } from 'lucide-react';
import { cn } from '@/utils/cn';
import type { SimulatedRequest } from '@/types';
import { formatLatency } from '@/utils/format';
import { Badge } from '@/components/ui';
import { OUTCOME_STYLE } from '@/components/architecture';

interface RequestInspectorProps {
  request: SimulatedRequest | null;
  onClose: () => void;
}

const STATUS_LINE: Record<SimulatedRequest['outcome'], { code: string; tone: 'ok' | 'brand' | 'warn' | 'danger' }> = {
  success: { code: '200 OK', tone: 'brand' },
  'cache-hit': { code: '200 OK (cache)', tone: 'ok' },
  warning: { code: '200 OK (degraded)', tone: 'warn' },
  failure: { code: '503 Service Unavailable', tone: 'danger' },
};

/**
 * Click a moving request particle to open this panel. Seeing the concrete route
 * and latency of one request is what turns an animation into an explanation.
 */
export function RequestInspector({ request, onClose }: RequestInspectorProps) {
  if (!request) return null;
  const status = STATUS_LINE[request.outcome];

  return (
    <div className="card animate-fade-in p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="label">Request inspector</p>
          <p className="mt-0.5 font-mono text-sm font-semibold text-ink">#{request.id}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close inspector"
          className="-m-1.5 flex shrink-0 items-center justify-center rounded-lg p-1.5 text-faint transition-colors hover:bg-elevated hover:text-ink"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
        <div>
          <dt className="text-faint">Method</dt>
          <dd className="font-mono text-ink">{request.method ?? 'GET'}</dd>
        </div>
        <div>
          <dt className="text-faint">Endpoint</dt>
          <dd className="truncate font-mono text-ink">{request.endpoint ?? '/api/resource'}</dd>
        </div>
        <div>
          <dt className="text-faint">Latency</dt>
          <dd className="font-mono text-ink">{formatLatency(request.latency)}</dd>
        </div>
        <div>
          <dt className="text-faint">Status</dt>
          <dd>
            <Badge tone={status.tone}>{status.code}</Badge>
          </dd>
        </div>
      </dl>

      <p className="label mt-4 mb-2">Route</p>
      <ol className="space-y-1">
        {request.path.map((hop, index) => (
          <li key={`${hop}-${index}`} className="flex items-center gap-2 text-xs">
            <span
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ background: OUTCOME_STYLE[request.outcome].fill }}
              aria-hidden
            />
            <span className={cn('font-mono', index === request.path.length - 1 ? 'text-ink' : 'text-muted')}>
              {hop}
            </span>
          </li>
        ))}
      </ol>

      {request.notes?.length ? (
        <ul className="mt-3 space-y-1 border-t border-line pt-3 text-xs text-muted">
          {request.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
