import { useRef, type ReactNode } from 'react';
import { cn } from '@/utils/cn';
import { InfoTip } from './Tooltip';
import type { Tone } from './Badge';

const valueTones: Record<Tone, string> = {
  neutral: 'text-ink',
  brand: 'text-brand',
  ok: 'text-ok',
  warn: 'text-warn',
  danger: 'text-danger',
  info: 'text-info',
  violet: 'text-violet',
};

const STATUS_TONES: ReadonlySet<Tone> = new Set(['ok', 'warn', 'danger']);

/**
 * Counts the times the value crossed from one status to another (ok, warn,
 * danger). A new count mounts a new flash, so each crossing rings the card once.
 * A value that sits on a threshold would flip every frame, so crossings closer
 * than FLASH_GAP_MS apart are not counted.
 */
const FLASH_GAP_MS = 1200;
function useStatusFlash(tone: Tone) {
  const seen = useRef({ tone, at: -Infinity, count: 0 });
  const last = seen.current;
  if (tone !== last.tone) {
    const now = performance.now();
    if (STATUS_TONES.has(tone) && STATUS_TONES.has(last.tone) && now - last.at > FLASH_GAP_MS) {
      last.at = now;
      last.count += 1;
    }
    last.tone = tone;
  }
  return last.count;
}

interface StatProps {
  label: ReactNode;
  value: ReactNode;
  unit?: string;
  tone?: Tone;
  hint?: ReactNode;
  sub?: ReactNode;
  className?: string;
  size?: 'sm' | 'md';
}

/** Single live metric readout. Hint powers the contextual tooltips. */
export function Stat({ label, value, unit, tone = 'neutral', hint, sub, className, size = 'md' }: StatProps) {
  const flash = useStatusFlash(tone);
  return (
    <div className={cn('relative rounded-xl border border-line bg-elevated px-3 py-2.5', className)}>
      {flash ? (
        <span
          key={flash}
          className={cn('stat-flash pointer-events-none absolute -inset-px rounded-xl', valueTones[tone])}
          aria-hidden
        />
      ) : null}
      {/* A label wraps instead of truncating: on a phone two tiles share a row, and a cut label
          ("Failed requ...") hides what the number is. */}
      <div className="flex items-start gap-1.5">
        <span className="label min-w-0 break-words leading-4">{label}</span>
        {hint ? (
          <span className="mt-px flex shrink-0">
            <InfoTip content={hint} />
          </span>
        ) : null}
      </div>
      <div className="mt-1 flex items-baseline gap-1">
        <span
          className={cn(
            'font-mono font-semibold tabular-nums',
            size === 'sm' ? 'text-base' : 'text-xl',
            valueTones[tone],
          )}
        >
          {value}
        </span>
        {unit ? <span className="text-[11px] font-medium text-faint">{unit}</span> : null}
      </div>
      {sub ? <div className="mt-0.5 text-[11px] text-faint">{sub}</div> : null}
    </div>
  );
}

export function StatGrid({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4', className)}>{children}</div>
  );
}
