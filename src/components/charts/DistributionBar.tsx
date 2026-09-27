import { cn } from '@/utils/cn';
import { clamp } from '@/utils/math';

export interface DistributionItem {
  label: string;
  value: number;
  /** 0..1 relative fill; if omitted it is computed from the max value. */
  ratio?: number;
  hot?: boolean;
  suffix?: string;
}

/**
 * Horizontal bars used for shard load, algorithm comparison and per-server
 * distribution - anywhere the point is "are these even?".
 */
export function DistributionBar({
  items,
  className,
  formatValue,
}: {
  items: DistributionItem[];
  className?: string;
  formatValue?: (value: number) => string;
}) {
  const max = Math.max(1, ...items.map((item) => item.value));
  return (
    <div className={cn('space-y-2', className)}>
      {items.map((item) => {
        const ratio = clamp(item.ratio ?? item.value / max, 0, 1);
        return (
          <div key={item.label} className="flex items-center gap-3">
            <span className="w-24 shrink-0 truncate text-xs text-muted">{item.label}</span>
            <div className="relative h-4 flex-1 overflow-hidden rounded-md bg-line/60">
              <div
                className={cn(
                  'h-full rounded-md transition-[width] duration-300',
                  item.hot ? 'bg-danger' : ratio > 0.8 ? 'bg-warn' : 'bg-brand',
                )}
                style={{ width: `${ratio * 100}%` }}
              />
            </div>
            <span className="w-20 shrink-0 text-right font-mono text-xs tabular-nums text-ink">
              {formatValue ? formatValue(item.value) : Math.round(item.value)}
              {item.suffix ? <span className="text-faint"> {item.suffix}</span> : null}
            </span>
            {item.hot ? <span className="text-[11px] font-semibold uppercase text-danger">hot</span> : null}
          </div>
        );
      })}
    </div>
  );
}
