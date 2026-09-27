import { memo, useId, useMemo, useState, type PointerEvent } from 'react';
import { useElementWidth } from '@/hooks/useElementWidth';
import { useThemeColors, type ColorToken } from '@/app/providers/ThemeProvider';
import type { SeriesPoint } from '@/simulations/engine';

export interface SeriesConfig {
  key: string;
  label: string;
  color: ColorToken;
  /** Draw as a line instead of a filled area (used for thresholds). */
  dashed?: boolean;
}

interface LiveChartProps {
  data: SeriesPoint[];
  series: SeriesConfig[];
  height?: number;
  unit?: string;
  variant?: 'area' | 'line';
  yDomain?: [number | 'auto', number | 'auto'];
  formatValue?: (value: number) => string;
}

// Plot insets inside the SVG. The left gutter holds the y-axis labels.
const TOP = 6;
const RIGHT = 6;
const LEFT = 37;
const BOTTOM = 4;
const LEGEND_HEIGHT = 22;
const TICK_COUNT = 5;

/**
 * Time-series chart for live simulation metrics, drawn as plain SVG.
 *
 * The labs only ever need a few smoothed lines or areas over a rolling window,
 * a y-axis, a hover readout and a legend. A general chart library costs ~100 KB
 * gzip for that, downloaded by every lab that shows a chart, so this draws it
 * directly. Colours are resolved from the active theme so both modes read well.
 */
export const LiveChart = memo(function LiveChart({
  data,
  series,
  height = 180,
  unit,
  variant = 'area',
  yDomain = [0, 'auto'],
  formatValue,
}: LiveChartProps) {
  const colors = useThemeColors();
  const gradientPrefix = useId();
  const { ref, width } = useElementWidth();
  const [hover, setHover] = useState<number | null>(null);

  const format = (value: number) =>
    formatValue ? formatValue(value) : `${Math.round(value * 10) / 10}${unit ? ` ${unit}` : ''}`;

  const showLegend = series.length > 1;
  const svgHeight = height - (showLegend ? LEGEND_HEIGHT : 0);
  const plotWidth = Math.max(0, width - LEFT - RIGHT);
  const plotHeight = Math.max(0, svgHeight - TOP - BOTTOM);

  const scale = useMemo(() => {
    const values: number[] = [];
    for (const point of data) {
      for (const item of series) {
        const value = point[item.key];
        if (Number.isFinite(value)) values.push(value);
      }
    }
    return niceScale(values, yDomain);
  }, [data, series, yDomain]);

  const x = (index: number) => LEFT + (data.length > 1 ? (index / (data.length - 1)) * plotWidth : plotWidth / 2);
  const y = (value: number) =>
    TOP + plotHeight - ((clampNumber(value, scale.min, scale.max) - scale.min) / (scale.max - scale.min)) * plotHeight;
  const baseline = y(clampNumber(0, scale.min, scale.max));

  const onPointerMove = (event: PointerEvent<SVGSVGElement>) => {
    if (data.length === 0 || plotWidth <= 0) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const ratio = (event.clientX - bounds.left - LEFT) / plotWidth;
    setHover(Math.round(clampNumber(ratio, 0, 1) * (data.length - 1)));
  };

  const hovered = hover !== null && hover < data.length ? hover : null;
  const latest = data[data.length - 1];
  const summary = latest
    ? series
        .map((item) => {
          const value = latest[item.key];
          // NaN is a gap (no data in the window), read out as such rather than "NaN ms".
          return `${item.label} ${value === undefined || Number.isNaN(value) ? 'no data' : format(value)}`;
        })
        .join(', ')
    : 'no data yet';

  return (
    <div ref={ref} className="relative w-full" style={{ height }}>
      {width > 0 ? (
        <svg
          width={width}
          height={svgHeight}
          role="img"
          aria-label={`Live chart: ${summary}`}
          onPointerMove={onPointerMove}
          onPointerLeave={() => setHover(null)}
          className="block touch-none tabular-nums"
        >
          <defs>
            {series.map((item) => (
              <linearGradient key={item.key} id={`${gradientPrefix}-${item.key}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={colors[item.color]} stopOpacity={0.35} />
                <stop offset="100%" stopColor={colors[item.color]} stopOpacity={0.02} />
              </linearGradient>
            ))}
          </defs>

          {scale.ticks.map((tick) => (
            <g key={tick}>
              <line
                x1={LEFT}
                x2={LEFT + plotWidth}
                y1={y(tick)}
                y2={y(tick)}
                stroke={colors.line}
                strokeDasharray="3 3"
              />
              <text x={LEFT - 6} y={y(tick)} dy="0.32em" textAnchor="end" fill={colors.faint} fontSize={11}>
                {formatTick(tick)}
              </text>
            </g>
          ))}

          {series.map((item) => {
            const segments = toSegments(data, item.key, x, y);
            const asArea = variant === 'area' && !item.dashed;
            return (
              <g key={item.key}>
                {segments.map((points, index) =>
                  points.length === 1 ? (
                    <circle key={index} cx={points[0][0]} cy={points[0][1]} r={3} fill={colors[item.color]} />
                  ) : (
                    <g key={index}>
                      {asArea ? (
                        <path
                          d={`${monotonePath(points)}L${points[points.length - 1][0]},${baseline}L${points[0][0]},${baseline}Z`}
                          fill={`url(#${gradientPrefix}-${item.key})`}
                        />
                      ) : null}
                      <path
                        d={monotonePath(points)}
                        fill="none"
                        stroke={colors[item.color]}
                        strokeWidth={2}
                        strokeDasharray={item.dashed ? '4 4' : undefined}
                        strokeLinejoin="round"
                        strokeLinecap="round"
                      />
                    </g>
                  ),
                )}
              </g>
            );
          })}

          {hovered !== null ? (
            <g pointerEvents="none">
              <line
                x1={x(hovered)}
                x2={x(hovered)}
                y1={TOP}
                y2={TOP + plotHeight}
                stroke={colors.faint}
                strokeWidth={1}
              />
              {series.map((item) => {
                const value = data[hovered][item.key];
                return Number.isFinite(value) ? (
                  <circle
                    key={item.key}
                    cx={x(hovered)}
                    cy={y(value)}
                    r={3.5}
                    fill={colors[item.color]}
                    stroke={colors.surface}
                    strokeWidth={1.5}
                  />
                ) : null;
              })}
            </g>
          ) : null}
        </svg>
      ) : null}

      {hovered !== null ? (
        <div
          className="pointer-events-none absolute top-1 rounded-xl border border-line bg-surface px-2.5 py-1.5 text-xs text-ink shadow-card"
          style={
            x(hovered) > width / 2
              ? { right: width - x(hovered) + 10 }
              : { left: x(hovered) + 10 }
          }
        >
          {series.map((item) => {
            const value = data[hovered][item.key];
            return (
              <div key={item.key} className="flex items-center gap-2 whitespace-nowrap">
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: colors[item.color] }} />
                <span className="text-muted">{item.label}</span>
                <span className="ml-auto font-mono tabular-nums">{Number.isFinite(value) ? format(value) : '-'}</span>
              </div>
            );
          })}
        </div>
      ) : null}

      {showLegend ? (
        <div className="flex min-h-[22px] flex-wrap items-center justify-center gap-x-4 gap-y-1 text-[11px]" style={{ color: colors.muted }}>
          {series.map((item) => (
            <span key={item.key} className="flex items-center gap-1.5">
              <svg width={16} height={8} aria-hidden>
                <line
                  x1={0}
                  x2={16}
                  y1={4}
                  y2={4}
                  stroke={colors[item.color]}
                  strokeWidth={2}
                  strokeDasharray={item.dashed ? '4 3' : undefined}
                />
              </svg>
              <span style={{ color: colors[item.color] }}>{item.label}</span>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
});

const clampNumber = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/**
 * Y range and gridline values on round numbers (0, 250, 500...). An 'auto' end
 * is widened to the next round step; a fixed end is kept exactly.
 */
function niceScale(values: number[], [fixedMin, fixedMax]: [number | 'auto', number | 'auto']) {
  const dataMin = values.length ? Math.min(...values) : 0;
  const dataMax = values.length ? Math.max(...values) : 1;
  let min = fixedMin === 'auto' ? dataMin : fixedMin;
  let max = fixedMax === 'auto' ? dataMax : fixedMax;
  if (max <= min) max = min + 1;

  const step = niceStep((max - min) / (TICK_COUNT - 1));
  if (fixedMin === 'auto') min = Math.floor(min / step) * step;
  if (fixedMax === 'auto') max = Math.ceil(max / step) * step;
  if (max <= min) max = min + step;

  const ticks: number[] = [];
  for (let tick = Math.ceil(min / step) * step; tick <= max + step * 1e-6; tick += step) {
    ticks.push(Number(tick.toPrecision(12)));
  }
  return { min, max, ticks };
}

/** 1, 2, 2.5 or 5 times a power of ten - the steps people read without effort. */
function niceStep(raw: number) {
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const normalized = raw / magnitude;
  const factor = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10;
  return factor * magnitude;
}

function formatTick(value: number) {
  if (Math.abs(value) >= 10_000) return `${Number((value / 1000).toPrecision(3))}k`;
  return String(Number(value.toPrecision(4)));
}

type Point = [number, number];

/** Consecutive runs of finite values - a missing value breaks the line instead of dropping to zero. */
function toSegments(
  data: SeriesPoint[],
  key: string,
  x: (index: number) => number,
  y: (value: number) => number,
): Point[][] {
  const segments: Point[][] = [];
  let current: Point[] = [];
  data.forEach((point, index) => {
    const value = point[key];
    if (Number.isFinite(value)) {
      current.push([x(index), y(value)]);
    } else if (current.length) {
      segments.push(current);
      current = [];
    }
  });
  if (current.length) segments.push(current);
  return segments;
}

/**
 * Smooth path through the points that never overshoots them (monotone cubic,
 * Fritsch-Carlson - the same curve d3 calls curveMonotoneX). A plain spline
 * would bulge below zero between a spike and a flat stretch, which reads as a
 * negative queue depth or request rate.
 */
function monotonePath(points: Point[]) {
  const count = points.length;
  if (count === 0) return '';
  if (count === 1) return `M${points[0][0]},${points[0][1]}`;
  if (count === 2) return `M${points[0][0]},${points[0][1]}L${points[1][0]},${points[1][1]}`;

  const slopes: number[] = [];
  for (let index = 0; index < count - 1; index += 1) {
    const dx = points[index + 1][0] - points[index][0];
    slopes.push(dx === 0 ? 0 : (points[index + 1][1] - points[index][1]) / dx);
  }

  const tangents: number[] = [slopes[0]];
  for (let index = 1; index < count - 1; index += 1) {
    const before = slopes[index - 1];
    const after = slopes[index];
    tangents.push(before * after <= 0 ? 0 : (2 * before * after) / (before + after));
  }
  tangents.push(slopes[count - 2]);

  let path = `M${points[0][0]},${points[0][1]}`;
  for (let index = 0; index < count - 1; index += 1) {
    const [x0, y0] = points[index];
    const [x1, y1] = points[index + 1];
    const third = (x1 - x0) / 3;
    path += `C${x0 + third},${y0 + tangents[index] * third},${x1 - third},${y1 - tangents[index + 1] * third},${x1},${y1}`;
  }
  return path;
}
