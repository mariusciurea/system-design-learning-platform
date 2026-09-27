import { useRef } from 'react';
import { cn } from '@/utils/cn';

interface SegmentedControlProps<T extends string> {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  className?: string;
  size?: 'sm' | 'md';
  /**
   * Stretch across the container, each segment growing with its label, instead
   * of hugging the labels. Use it where the control can meet a phone-width
   * column (pair with e.g. `sm:w-auto`): the segments share the row and never
   * push the page sideways.
   */
  fill?: boolean;
  /** What the choice is about ("Difficulty"), for a screen reader. */
  'aria-label'?: string;
}

/**
 * One choice out of a few, as a radio group: arrow keys move the choice, and Tab
 * enters and leaves the group on the chosen segment.
 */
export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  className,
  size = 'md',
  fill = false,
  'aria-label': ariaLabel,
}: SegmentedControlProps<T>) {
  const groupRef = useRef<HTMLDivElement>(null);

  const onKeyDown = (event: React.KeyboardEvent) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (!step) return;
    event.preventDefault();
    const index = options.findIndex((option) => option.value === value);
    const next = (index + step + options.length) % options.length;
    onChange(options[next].value);
    groupRef.current?.querySelectorAll('button')[next]?.focus();
  };

  return (
    <div
      ref={groupRef}
      role="radiogroup"
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
      className={cn(
        'rounded-xl border border-line bg-elevated p-1',
        fill ? 'flex w-full' : 'inline-flex',
        className,
      )}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            role="radio"
            type="button"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(option.value)}
            className={cn(
              'rounded-lg font-medium transition-colors',
              size === 'sm' ? 'py-1 text-xs' : 'py-1.5 text-sm',
              // Filled, a label never wraps: the segments shrink their padding
              // on a phone instead, and are back to the usual padding from sm up.
              fill
                ? cn('flex-auto whitespace-nowrap', size === 'sm' ? 'px-1.5 sm:px-2.5' : 'px-2 sm:px-3.5')
                : size === 'sm'
                  ? 'px-2.5'
                  : 'px-3.5',
              // The ring keeps the chosen segment apart from the track in the light theme,
              // where surface and elevated are both near white.
              active ? 'bg-surface text-ink shadow-sm ring-1 ring-line' : 'text-muted hover:text-ink',
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
