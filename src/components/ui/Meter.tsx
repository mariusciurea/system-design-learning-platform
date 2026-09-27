import type { ReactNode } from 'react';
import { cn } from '@/utils/cn';
import { clamp } from '@/utils/math';

interface MeterProps {
  label?: ReactNode;
  /** 0..1 */
  value: number;
  className?: string;
  /** Override the automatic traffic-light colouring. */
  tone?: 'brand' | 'ok' | 'warn' | 'danger' | 'violet' | 'info';
  showValue?: boolean;
  size?: 'xs' | 'sm' | 'md';
  /** Renders a dashed marker, e.g. an auto-scaling threshold. */
  threshold?: number;
}

const toneClass = {
  brand: 'bg-brand',
  ok: 'bg-ok',
  warn: 'bg-warn',
  danger: 'bg-danger',
  violet: 'bg-violet',
  info: 'bg-info',
};

const heights = { xs: 'h-1', sm: 'h-1.5', md: 'h-2.5' };

/** Utilization bar. Colour is derived from the value unless `tone` is given. */
export function Meter({ label, value, className, tone, showValue = true, size = 'sm', threshold }: MeterProps) {
  const ratio = clamp(value, 0, 1);
  const auto = value >= 0.9 ? 'danger' : value >= 0.7 ? 'warn' : 'ok';
  const resolved = tone ?? auto;

  return (
    <div className={cn('space-y-1', className)}>
      {label || showValue ? (
        <div className="flex items-center justify-between gap-2 text-[11px]">
          {label ? <span className="truncate text-muted">{label}</span> : <span />}
          {showValue ? (
            <span className="font-mono tabular-nums text-muted">{Math.round(value * 100)}%</span>
          ) : null}
        </div>
      ) : null}
      <div
        className={cn('relative w-full overflow-hidden rounded-full bg-line', heights[size])}
        role="meter"
        aria-label={typeof label === 'string' ? label : undefined}
        aria-valuenow={Math.round(value * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className={cn('h-full rounded-full transition-[width] duration-200 ease-out', toneClass[resolved])}
          style={{ width: `${ratio * 100}%` }}
        />
        {threshold !== undefined ? (
          <div
            className="absolute inset-y-0 w-px bg-ink/50"
            style={{ left: `${clamp(threshold, 0, 1) * 100}%` }}
            aria-hidden
          />
        ) : null}
      </div>
    </div>
  );
}
