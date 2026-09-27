import type { ReactNode } from 'react';
import { Pause, Play, RotateCcw } from 'lucide-react';
import { cn } from '@/utils/cn';
import { useElementWidth } from '@/hooks/useElementWidth';
import { Button, ErrorBoundary } from '@/components/ui';
import type { SimEvent } from '@/simulations/engine';

interface LabShellProps {
  title: string;
  description: ReactNode;
  children: ReactNode;
  /** Right-hand control column. */
  controls: ReactNode;
  metrics?: ReactNode;
  events?: SimEvent[];
  insight?: ReactNode;
  running?: boolean;
  /** Run or pause the simulation. Pass the setter of `useLabRunning`. */
  onRunningChange?: (running: boolean) => void;
  /**
   * Put every control back to the start of the Lab (its Lab focus setup when it has one) and clear
   * the simulation state. LabShell then pauses the Lab, so the Learner sees the start setup before
   * anything moves, and Run starts it from there.
   */
  onReset?: () => void;
  /** Extra buttons in the toolbar (kill server, upgrade, create index...). */
  actions?: ReactNode;
  legend?: ReactNode;
  footer?: ReactNode;
}

/**
 * Consistent chrome for every interactive lab: toolbar, stage, control column,
 * metrics strip and event log. Labs only supply their own diagram and controls.
 */
export function LabShell({
  title,
  description,
  children,
  controls,
  metrics,
  events,
  insight,
  running,
  onRunningChange,
  onReset,
  actions,
  legend,
  footer,
}: LabShellProps) {
  const { ref, wide, columns } = useShellLayout();
  const reset = () => {
    onReset?.();
    onRunningChange?.(false);
  };
  const controlsCard = (
    <div className="card p-4">
      <p className="label mb-3">Controls</p>
      <div
        className={cn(
          columns ? 'grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-x-6 gap-y-4' : 'space-y-4',
        )}
      >
        {controls}
      </div>
    </div>
  );
  return (
    <section ref={ref} className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-ink">{title}</h2>
          <p className="mt-0.5 max-w-3xl text-sm text-muted">{description}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {actions}
          {onRunningChange ? (
            <Button variant={running ? 'secondary' : 'primary'} onClick={() => onRunningChange(!running)}>
              {running ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
              {running ? 'Pause' : 'Run simulation'}
            </Button>
          ) : null}
          {onReset ? (
            <Button size="icon" onClick={reset} aria-label="Reset simulation">
              <RotateCcw className="h-4 w-4" />
            </Button>
          ) : null}
        </div>
      </div>

      <div className={cn('grid gap-4', wide && 'grid-cols-[minmax(0,1fr)_320px]')}>
        <div className="min-w-0 space-y-4">
          <div className="card overflow-hidden">
            <ErrorBoundary area={title}>{children}</ErrorBoundary>
            {legend ? <div className="border-t border-line px-4 py-2.5">{legend}</div> : null}
          </div>
          {/* Stacked, the controls sit right under the stage, so a change and its effect stay on one screen. */}
          {wide ? null : controlsCard}
          {/* What to notice reads the stage, so it sits right under it, before the numbers. */}
          {insight}
          {metrics}
          {footer}
        </div>

        {wide ? (
          <div className="sticky top-[4.5rem] space-y-4 self-start">
            {controlsCard}
            {events ? <EventLog events={events} running={running} /> : null}
          </div>
        ) : events ? (
          <EventLog events={events} running={running} />
        ) : null}
      </div>
    </section>
  );
}

/**
 * Side-by-side stage and controls need room for both: 320px of controls, a 16px gap, and a stage
 * that shows the 960px Diagram at 0.8x or more. Below 0.8x its 11px node text drops under 9px and
 * stops being readable, so the controls move under the stage instead and the Diagram gets the
 * full width. The choice follows the width of the shell itself, not the viewport, because a lab
 * embedded in a concept page shares the screen with that page's own side column.
 */
const LEGIBLE_SCALE = 0.8;
const WIDE_LAYOUT_MIN = Math.ceil(960 * LEGIBLE_SCALE) + 2 + 16 + 320;
/** Stacked and at least this wide, the controls flow into columns so the card stays short. */
const CONTROL_COLUMNS_MIN = 560;

function useShellLayout() {
  const { ref, width } = useElementWidth<HTMLElement>();
  const wide = width >= WIDE_LAYOUT_MIN;
  return { ref, wide, columns: !wide && width >= CONTROL_COLUMNS_MIN };
}

const TONE_CLASS = {
  info: 'text-muted',
  ok: 'text-ok',
  warn: 'text-warn',
  danger: 'text-danger',
};

/** Timestamped feed of what the simulation just did. */
export function EventLog({
  events,
  title = 'Event log',
  running,
}: {
  events: SimEvent[];
  title?: string;
  /** Whether the simulation is running, so the empty log never asks to start one that already runs. */
  running?: boolean;
}) {
  return (
    <div className="card flex max-h-72 flex-col p-4">
      <p className="label mb-2">{title}</p>
      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto font-mono text-[11px] leading-relaxed">
        {events.length === 0 ? (
          <p className="text-faint">
            {running
              ? 'Nothing has happened yet. Events show up here as the simulation runs.'
              : 'No events yet. Press Run simulation to start.'}
          </p>
        ) : (
          events.map((event) => (
            <p key={event.id} className={cn('flex gap-2', TONE_CLASS[event.tone])}>
              <span className="shrink-0 text-faint">{event.time}</span>
              <span className="min-w-0">{event.message}</span>
            </p>
          ))
        )}
      </div>
    </div>
  );
}
