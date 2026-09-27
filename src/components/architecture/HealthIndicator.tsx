import { cn } from '@/utils/cn';
import type { NodeStatus } from '@/types';

const STATUS = {
  healthy: { dot: 'bg-ok', text: 'text-ok', label: 'Healthy' },
  degraded: { dot: 'bg-warn', text: 'text-warn', label: 'Degraded' },
  down: { dot: 'bg-danger', text: 'text-danger', label: 'Down' },
  starting: { dot: 'bg-brand', text: 'text-brand', label: 'Starting' },
  overloaded: { dot: 'bg-danger', text: 'text-danger', label: 'Overloaded' },
  idle: { dot: 'bg-faint', text: 'text-muted', label: 'Idle' },
} as const satisfies Record<NodeStatus, { dot: string; text: string; label: string }>;

interface HealthIndicatorProps {
  status: NodeStatus;
  label?: string;
  className?: string;
  /** Status is never communicated by colour alone - the text is always there. */
  showLabel?: boolean;
}

export function HealthIndicator({ status, label, className, showLabel = true }: HealthIndicatorProps) {
  const style = STATUS[status];
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-[11px] font-medium', style.text, className)}>
      <span className="relative flex h-2 w-2">
        {status !== 'down' && status !== 'idle' ? (
          <span className={cn('absolute inline-flex h-full w-full rounded-full opacity-60', style.dot, 'animate-pulse-ring')} />
        ) : null}
        <span className={cn('relative inline-flex h-2 w-2 rounded-full', style.dot)} />
      </span>
      {showLabel ? label ?? style.label : null}
    </span>
  );
}

export const statusLabel = (status: NodeStatus) => STATUS[status].label;
