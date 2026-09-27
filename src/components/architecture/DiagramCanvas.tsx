import { useEffect, useLayoutEffect, useMemo, type ReactNode } from 'react';
import { cn } from '@/utils/cn';
import { useFitScale, type FitRange } from '@/hooks/useFitScale';
import type { RequestOutcome } from '@/types';
import {
  curveBetween,
  curveToPath,
  EDGE_LABEL_FONT_SIZE,
  edgeLabelBox,
  midpoint,
  pointOnCurve,
  type Curve,
  type Layout,
} from './geometry';

export type EdgeTone = 'default' | 'brand' | 'ok' | 'warn' | 'danger' | 'violet' | 'info' | 'muted';

export interface DiagramEdge {
  from: string;
  to: string;
  tone?: EdgeTone;
  dashed?: boolean;
  /** Marching-ants animation - use it to mark an actively used path. */
  animated?: boolean;
  label?: string;
  /** Where the label sits along the edge, 0..1. Defaults to the midpoint. */
  labelT?: number;
  curvature?: number;
  faded?: boolean;
  width?: number;
}

export interface ParticleView {
  id: number;
  from: string;
  to: string;
  /** Progress along the edge, 0..1 */
  t: number;
  outcome: RequestOutcome;
  onClick?: () => void;
  highlighted?: boolean;
}

const EDGE_STROKE: Record<EdgeTone, string> = {
  default: 'rgb(var(--c-faint) / 0.55)',
  brand: 'rgb(var(--c-brand) / 0.85)',
  ok: 'rgb(var(--c-ok) / 0.8)',
  warn: 'rgb(var(--c-warn) / 0.85)',
  danger: 'rgb(var(--c-danger) / 0.85)',
  violet: 'rgb(var(--c-violet) / 0.85)',
  info: 'rgb(var(--c-info) / 0.8)',
  muted: 'rgb(var(--c-faint) / 0.25)',
};

export const OUTCOME_STYLE: Record<RequestOutcome, { fill: string; label: string; shape: ParticleShapeKind }> = {
  success: { fill: 'rgb(var(--c-brand))', label: 'Request / response', shape: 'circle' },
  'cache-hit': { fill: 'rgb(var(--c-ok))', label: 'Cache hit', shape: 'diamond' },
  warning: { fill: 'rgb(var(--c-warn))', label: 'Warning / retry', shape: 'triangle' },
  failure: { fill: 'rgb(var(--c-danger))', label: 'Failure', shape: 'cross' },
};

interface DiagramCanvasProps {
  width?: number;
  height?: number;
  layout: Layout;
  edges?: DiagramEdge[];
  particles?: ParticleView[];
  children?: ReactNode;
  className?: string;
  /** Extra SVG drawn under the nodes (zones, brackets, annotations). */
  underlay?: ReactNode;
  grid?: boolean;
  /**
   * Scale range when fitting the design space to the container width.
   * Defaults to 0.5x-1x: a lab never grows past its authored size, and below
   * half size it scrolls sideways inside its card instead of shrinking further.
   */
  fit?: FitRange;
  /** Pins the scale instead of fitting to the container width. */
  zoom?: number;
  /**
   * Node ids that must stay in view. When the canvas is wider than its card
   * and scrolls sideways (a phone), it scrolls to show them - so a Walkthrough
   * step never points at a part that is off screen.
   */
  focus?: string[];
}


/**
 * The shared stage for every lab: an SVG wiring layer with animated request
 * particles, and HTML node cards positioned on top of it.
 *
 * Everything is authored in a fixed design space (`width` x `height`, 960px wide
 * by default) and the whole layer stack - grid, SVG wiring, particles, edge
 * labels and node cards - is scaled together by one CSS transform, so they can
 * never drift apart. An outer box sized to the scaled dimensions keeps the page
 * layout height correct (a transform alone does not change layout size).
 *
 * The scale fits the container width within `fit` (0.5x-1x by default). Below
 * the floor the canvas scrolls horizontally inside its own box rather than
 * shrinking into an unreadable diagram; the page itself never scrolls sideways.
 *
 * Anything that converts pointer coordinates into diagram space must divide by
 * the scale. Nothing does today: node and particle clicks are element handlers,
 * which transforms do not affect.
 */
export function DiagramCanvas({
  width = 960,
  height = 520,
  layout,
  edges = [],
  particles = [],
  children,
  className,
  underlay,
  grid = true,
  fit,
  zoom,
  focus,
}: DiagramCanvasProps) {
  const { ref, scale } = useFitScale(width, fit, zoom);
  // A string, so a new array with the same ids does not scroll again.
  const focusKey = focus?.join(' ') ?? '';

  // Diagrams are drawn around their middle (the entry point on top, replicas either side), so
  // when one scrolls sideways (a phone) it opens centred; a Walkthrough focus below then wins.
  useLayoutEffect(() => {
    const scroller = ref.current;
    if (!scroller || focusKey) return;
    const overflow = scroller.scrollWidth - scroller.clientWidth;
    scroller.scrollLeft = overflow > 0 ? overflow / 2 : 0;
  }, [ref, focusKey, scale]);

  useEffect(() => {
    const scroller = ref.current;
    if (!scroller || !focusKey || scroller.scrollWidth <= scroller.clientWidth) return;
    const boxes = focusKey.split(' ').flatMap((id) => (layout[id] ? [layout[id]] : []));
    if (!boxes.length) return;
    const left = Math.min(...boxes.map((box) => box.x)) * scale;
    const right = Math.max(...boxes.map((box) => box.x + box.w)) * scale;
    const view = scroller.clientWidth;
    if (left >= scroller.scrollLeft && right <= scroller.scrollLeft + view) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    // Centre the parts; if they are wider than the card, show the leftmost one whole.
    const target = right - left > view ? left - 16 : (left + right - view) / 2;
    scroller.scrollTo({ left: Math.max(0, target), behavior: reduced ? 'auto' : 'smooth' });
  }, [ref, focusKey, layout, scale]);
  const curves = useMemo(() => {
    const map = new Map<string, Curve>();
    for (const edge of edges) {
      const from = layout[edge.from];
      const to = layout[edge.to];
      if (!from || !to) continue;
      map.set(`${edge.from}->${edge.to}`, curveBetween(from, to, edge.curvature));
    }
    return map;
  }, [edges, layout]);

  const curveFor = (from: string, to: string) => {
    const cached = curves.get(`${from}->${to}`);
    if (cached) return cached;
    const a = layout[from];
    const b = layout[to];
    return a && b ? curveBetween(a, b) : null;
  };

  return (
    <div ref={ref} className={cn('w-full min-w-0 overflow-x-auto overflow-y-hidden rounded-2xl', className)}>
      {/* Takes the scaled size in layout; the child below is painted scaled into it. */}
      <div className="mx-auto overflow-hidden" style={{ width: width * scale, height: height * scale }}>
        {/* data-diagram: the touch-size rule in index.css leaves controls in
            here alone - the layout is fixed geometry, and growing a button
            inside a node would push the node over its neighbour. */}
        <div
          data-diagram
          className={cn('relative', grid && 'grid-bg')}
          style={{
            width,
            height,
            minWidth: width,
            transform: scale === 1 ? undefined : `scale(${scale})`,
            transformOrigin: 'top left',
          }}
        >
          <svg
            width={width}
            height={height}
            className="absolute inset-0 overflow-visible"
            aria-hidden
          >
            {underlay}
            {edges.map((edge) => {
              const curve = curveFor(edge.from, edge.to);
              if (!curve) return null;
              const tone = edge.tone ?? 'default';
              const label = edge.label
                ? edge.labelT === undefined
                  ? midpoint(curve)
                  : pointOnCurve(curve, edge.labelT)
                : null;
              const chip = label && edge.label ? edgeLabelBox(label, edge.label) : null;
              return (
                <g key={`${edge.from}->${edge.to}-${edge.label ?? ''}`} opacity={edge.faded ? 0.25 : 1}>
                  <path
                    d={curveToPath(curve)}
                    fill="none"
                    stroke={EDGE_STROKE[tone]}
                    strokeWidth={edge.width ?? 1.75}
                    strokeLinecap="round"
                    strokeDasharray={edge.dashed ? '5 5' : edge.animated ? '6 6' : undefined}
                    className={edge.animated ? 'animate-dash' : undefined}
                  />
                  {label && chip && edge.label ? (
                    <g>
                      {/* Chip behind the text: edge labels sit over the grid and
                          sometimes near a node, and must stay readable. */}
                      <rect
                        x={chip.x}
                        y={chip.y}
                        width={chip.w}
                        height={chip.h}
                        rx={4}
                        className="fill-[rgb(var(--c-surface))] stroke-[rgb(var(--c-line))]"
                        strokeWidth={1}
                      />
                      <text
                        x={label.x}
                        y={label.y - 5}
                        textAnchor="middle"
                        className="fill-[rgb(var(--c-muted))] font-mono"
                        style={{ fontSize: EDGE_LABEL_FONT_SIZE }}
                      >
                        {edge.label}
                      </text>
                    </g>
                  ) : null}
                </g>
              );
            })}

            {particles.map((particle) => {
              const curve = curveFor(particle.from, particle.to);
              if (!curve) return null;
              const point = pointOnCurve(curve, Math.min(1, Math.max(0, particle.t)));
              const style = OUTCOME_STYLE[particle.outcome];
              return (
                <g
                  key={particle.id}
                  transform={`translate(${point.x} ${point.y})`}
                  onClick={particle.onClick}
                  style={{ cursor: particle.onClick ? 'pointer' : undefined, pointerEvents: 'auto' }}
                >
                  {particle.highlighted ? (
                    <circle r={9} fill="none" stroke={style.fill} strokeWidth={1.5} opacity={0.9} />
                  ) : null}
                  <ParticleShape shape={style.shape} fill={style.fill} />
                </g>
              );
            })}
          </svg>
          {children}
        </div>
      </div>
    </div>
  );
}

export type ParticleShapeKind = 'circle' | 'diamond' | 'triangle' | 'cross';

/** The shape of one particle, centred on 0,0. Diagrams draw it on the wire, legends at 14px. */
export function ParticleShape({ shape, fill }: { shape: ParticleShapeKind; fill: string }) {
  switch (shape) {
    case 'diamond':
      return <rect x={-4} y={-4} width={8} height={8} rx={1} fill={fill} transform="rotate(45)" />;
    case 'triangle':
      return <polygon points="0,-5 4.5,3.5 -4.5,3.5" fill={fill} />;
    case 'cross':
      return (
        <g stroke={fill} strokeWidth={2.2} strokeLinecap="round">
          <line x1={-3.5} y1={-3.5} x2={3.5} y2={3.5} />
          <line x1={-3.5} y1={3.5} x2={3.5} y2={-3.5} />
        </g>
      );
    default:
      return <circle r={4.2} fill={fill} />;
  }
}

interface ParticleLegendProps {
  /** Outcomes to list: bare ones get the shared label, `{ outcome, label }` says what it means in this Lab. */
  outcomes?: (RequestOutcome | { outcome: RequestOutcome; label?: string })[];
  className?: string;
  /** Extra legend entries (a wire colour note, a cell style), laid out in the same row. */
  children?: ReactNode;
}

/** Shape + colour + text legend so status is never colour-only. */
export function ParticleLegend({
  outcomes = ['success', 'cache-hit', 'warning', 'failure'],
  className,
  children,
}: ParticleLegendProps) {
  return (
    <div className={cn('flex flex-wrap items-center gap-x-4 gap-y-1.5', className)}>
      {outcomes.map((entry) => {
        const { outcome, label } = typeof entry === 'string' ? { outcome: entry, label: undefined } : entry;
        const style = OUTCOME_STYLE[outcome];
        return (
          <span key={outcome} className="flex items-center gap-1.5 text-[11px] text-muted">
            <svg width={14} height={14} viewBox="-7 -7 14 14" aria-hidden>
              <ParticleShape shape={style.shape} fill={style.fill} />
            </svg>
            {label ?? style.label}
          </span>
        );
      })}
      {children}
    </div>
  );
}
