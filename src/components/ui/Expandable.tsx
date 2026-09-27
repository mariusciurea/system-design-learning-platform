import { useState, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/utils/cn';

interface ExpandableProps {
  title: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  className?: string;
  hint?: string;
}

/**
 * "Visualization first, short explanation second, deep explanation optional" -
 * this is the optional third layer.
 */
export function Expandable({ title, children, defaultOpen = false, className, hint }: ExpandableProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={cn('rounded-xl border border-line bg-surface', className)}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="group flex w-full items-center gap-2 rounded-xl px-4 py-3 text-left"
      >
        <ChevronRight
          className={cn('h-4 w-4 shrink-0 text-faint transition-[transform,color] group-hover:text-ink', open && 'rotate-90')}
          aria-hidden
        />
        <span className="flex-1 text-sm font-medium text-ink">{title}</span>
        {hint && !open ? <span className="text-[11px] text-faint">{hint}</span> : null}
      </button>
      {open ? (
        <div className="border-t border-line px-4 py-3 text-sm leading-relaxed text-muted animate-fade-in">
          {children}
        </div>
      ) : null}
    </div>
  );
}
