import { useId, type ReactNode } from 'react';
import { cn } from '@/utils/cn';
import { InfoTip } from './Tooltip';

interface ToggleProps {
  label: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  hint?: ReactNode;
  disabled?: boolean;
  description?: ReactNode;
}

export function Toggle({ label, checked, onChange, hint, disabled, description }: ToggleProps) {
  const id = useId();
  return (
    // On a touch screen the row is 44px tall and the switch keeps its 24px pill,
    // with an invisible 44x44 hit area around it: the ::before reaches past the
    // 1px border, 11px up and down from the 22px padding box.
    <div className="flex items-center justify-between gap-3 coarse:min-h-11">
      <label htmlFor={id} className="min-w-0">
        <span className="flex items-center gap-1.5 text-xs font-medium text-muted">
          {label}
          {hint ? <InfoTip content={hint} /> : null}
        </span>
        {description ? <span className="mt-0.5 block text-[11px] text-faint">{description}</span> : null}
      </label>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          'relative h-6 w-11 shrink-0 rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-50',
          'coarse:min-h-0 coarse:before:absolute coarse:before:-inset-y-[11px] coarse:before:-inset-x-px coarse:before:content-[""]',
          // Off keeps a faint outline and knob, so the switch still reads as a control (3:1) on any surface.
          checked ? 'border-brand bg-brand' : 'border-faint bg-elevated hover:border-muted',
        )}
      >
        <span
          className={cn(
            'absolute left-0 top-[2px] h-[18px] w-[18px] rounded-full shadow transition-[transform,background-color]',
            // on-fill, not white: the dark theme brand is bright, and a white knob on it is 2:1.
            checked ? 'translate-x-[22px] bg-on-fill' : 'translate-x-[2px] bg-faint',
          )}
        />
        <span className="sr-only">{checked ? 'On' : 'Off'}</span>
      </button>
    </div>
  );
}
