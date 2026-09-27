import type { ReactNode } from 'react';
import { cn } from '@/utils/cn';
import type { NodeKind, NodeStatus } from '@/types';
import { NODE_KINDS } from './nodeKinds';
import { HealthIndicator } from './HealthIndicator';
import type { Placed } from './geometry';

interface ArchNodeProps {
  kind: NodeKind;
  title: ReactNode;
  subtitle?: ReactNode;
  status?: NodeStatus;
  /** Replaces the default status text ("Down", "Healthy"...), e.g. "Off" for a node that is switched off. */
  statusLabel?: string;
  /** Absolute placement inside a DiagramCanvas. Omit to render inline. */
  placed?: Placed;
  children?: ReactNode;
  onClick?: () => void;
  selected?: boolean;
  /** Draws an attention ring, used for bottlenecks and hot shards. */
  alert?: boolean;
  badge?: ReactNode;
  className?: string;
  compact?: boolean;
}

/**
 * A single infrastructure box. Rendered as HTML (not SVG) so it can hold live
 * meters, buttons and status text while the SVG layer below draws the wiring.
 */
export function ArchNode({
  kind,
  title,
  subtitle,
  status = 'healthy',
  statusLabel,
  placed,
  children,
  onClick,
  selected,
  alert,
  badge,
  className,
  compact,
}: ArchNodeProps) {
  const { Icon, accent } = NODE_KINDS[kind];
  const interactive = Boolean(onClick);
  // Nodes fade in and glide to a new place (the `arch-node` class in index.css), so adding a
  // server reads as the architecture changing rather than the diagram being redrawn. It is a
  // CSS transition on the placement, so it runs only when the placement changes - never when
  // DiagramCanvas rescales, and never when a live stat row makes the card taller.
  const Element = interactive ? 'button' : 'div';

  return (
    <Element
      type={interactive ? 'button' : undefined}
      onClick={onClick}
      aria-pressed={interactive && selected ? true : undefined}
      style={
        placed
          ? { position: 'absolute', left: placed.x, top: placed.y, width: placed.w, minHeight: placed.h }
          : undefined
      }
      className={cn(
        'arch-node z-10 flex flex-col rounded-xl border bg-surface text-left shadow-node',
        compact ? 'gap-1 p-2' : 'gap-1.5 p-3',
        status === 'down' ? 'border-danger/60 saturate-0' : 'border-line',
        status === 'overloaded' && 'border-danger ring-2 ring-danger/35',
        selected && 'border-brand shadow-glow',
        alert && 'border-warn ring-2 ring-warn/35',
        interactive && 'hover:border-brand/60 hover:shadow-glow',
        className,
      )}
    >
      <div className="flex items-start gap-2">
        <span className={cn('flex h-7 w-7 shrink-0 items-center justify-center rounded-lg', accent)}>
          <Icon className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-xs font-semibold text-ink">{title}</span>
            {badge}
          </div>
          {subtitle ? <div className="truncate text-[11px] text-faint">{subtitle}</div> : null}
        </div>
      </div>
      {children ? <div className="space-y-1.5">{children}</div> : null}
      <HealthIndicator status={status} label={statusLabel} className="mt-auto pt-0.5" />
    </Element>
  );
}

/** Compact label/value row for node internals (CPU, hit rate, depth...). */
export function NodeStatRow({
  label,
  value,
  tone = 'text-ink',
}: {
  label: string;
  value: ReactNode;
  tone?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2 text-[11px]">
      <span className="truncate text-faint">{label}</span>
      <span className={cn('font-mono font-semibold tabular-nums', tone)}>{value}</span>
    </div>
  );
}
