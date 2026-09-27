import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { HelpCircle } from 'lucide-react';
import { cn } from '@/utils/cn';

interface TooltipProps {
  content: ReactNode;
  children: ReactNode;
  className?: string;
  side?: 'top' | 'bottom';
}

/**
 * Keyboard-accessible tooltip: hover or focus reveals it, Escape hides it, and
 * the trigger is wired to the bubble with aria-describedby.
 */
export function Tooltip({ content, children, className, side = 'top' }: TooltipProps) {
  const [open, setOpen] = useState(false);
  const [shift, setShift] = useState(0);
  const id = useId();
  const bubble = useRef<HTMLSpanElement>(null);

  // The bubble is centred on its trigger, then moved back inside the window when a trigger near
  // an edge (a label at the side of a phone screen) would push it out.
  useLayoutEffect(() => {
    if (!open || !bubble.current) return;
    const margin = 8;
    const { left, right } = bubble.current.getBoundingClientRect();
    const centred = { left: left - shift, right: right - shift };
    const room = document.documentElement.clientWidth - margin;
    const next = centred.left < margin ? margin - centred.left : centred.right > room ? room - centred.right : 0;
    // The bubble has to be measured in the window before it can be placed.
    if (next !== shift) setShift(next);
  }, [open, shift]);

  return (
    <span
      className={cn('relative inline-flex', className)}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      // Escape hides the bubble without moving focus, so it never has to be hovered away.
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <span aria-describedby={open ? id : undefined} tabIndex={0} className="inline-flex outline-none">
        {children}
      </span>
      {open ? (
        <span
          ref={bubble}
          id={id}
          role="tooltip"
          // `translate`, not a transform class: the fade-in animates `transform`, and would drop a
          // -translate-x-1/2 while it runs, so the bubble jumped sideways as it appeared.
          style={{ translate: `calc(-50% + ${shift}px) 0` }}
          className={cn(
            'pointer-events-none absolute left-1/2 z-50 w-56 max-w-[calc(100vw-16px)] rounded-lg border border-line bg-surface px-3 py-2',
            'text-xs font-normal leading-relaxed text-muted shadow-card animate-fade-in',
            side === 'top' ? 'bottom-full mb-2' : 'top-full mt-2',
          )}
        >
          {content}
        </span>
      ) : null}
    </span>
  );
}

/**
 * Small "?" affordance used next to metric labels. The icon stays 14px; on a
 * touch screen an invisible ::after grows its hit area to 44x44 (15px each way).
 */
export function InfoTip({ content }: { content: ReactNode }) {
  return (
    <Tooltip content={content}>
      <span className="relative inline-flex coarse:after:absolute coarse:after:-inset-[15px] coarse:after:content-['']">
        <HelpCircle className="h-3.5 w-3.5 text-faint transition-colors hover:text-brand" aria-label="More information" />
      </span>
    </Tooltip>
  );
}
