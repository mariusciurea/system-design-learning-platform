import { useEffect, useRef, type ReactNode } from 'react';
import { PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen } from 'lucide-react';
import { cn } from '@/utils/cn';

/** What differs between a column on the left of the canvas and one on its right. */
const SIDE = {
  left: { FoldIcon: PanelLeftClose, OpenIcon: PanelLeftOpen, border: 'border-r' },
  right: { FoldIcon: PanelRightClose, OpenIcon: PanelRightOpen, border: 'border-l' },
} as const;

interface SidePanelProps {
  id: string;
  side: keyof typeof SIDE;
  /** Visible heading, also used in the fold controls' accessible names. */
  title: string;
  folded: boolean;
  onFoldedChange: (folded: boolean) => void;
  /** Tailwind width of the open panel, e.g. `w-52`. */
  width: string;
  children: ReactNode;
}

/**
 * A Playground column beside the canvas that folds into a narrow strip, the way the sidebar folds.
 * The strip keeps one control that opens it again; focus follows the control the learner used.
 */
export function SidePanel({ id, side, title, folded, onFoldedChange, width, children }: SidePanelProps) {
  const foldButton = useRef<HTMLButtonElement>(null);
  const openButton = useRef<HTMLButtonElement>(null);
  const moveFocus = useRef(false);

  useEffect(() => {
    if (!moveFocus.current) return;
    moveFocus.current = false;
    (folded ? openButton : foldButton).current?.focus();
  }, [folded]);

  const toggle = (next: boolean) => {
    moveFocus.current = true;
    onFoldedChange(next);
  };

  const { FoldIcon, OpenIcon, border } = SIDE[side];

  return (
    <>
      {folded ? (
        <div className={cn('flex w-10 shrink-0 flex-col items-center border-line bg-surface py-2', border)}>
          <button
            type="button"
            ref={openButton}
            onClick={() => toggle(false)}
            aria-controls={id}
            aria-expanded={false}
            aria-label={`Show ${title.toLowerCase()}`}
            className="flex flex-col items-center gap-2 rounded-lg px-1.5 py-2.5 text-[11px] font-medium text-muted transition-colors hover:bg-elevated hover:text-ink"
          >
            <OpenIcon className="h-4 w-4" />
            <span className="[writing-mode:vertical-rl]">{title}</span>
          </button>
        </div>
      ) : null}
      <aside
        id={id}
        aria-label={title}
        hidden={folded}
        className={cn('shrink-0 overflow-y-auto border-line bg-surface p-3', border, width)}
      >
        <div className="mb-2 flex items-center justify-between gap-2">
          <h2 className="label">{title}</h2>
          <button
            type="button"
            ref={foldButton}
            onClick={() => toggle(true)}
            aria-controls={id}
            aria-expanded
            aria-label={`Hide ${title.toLowerCase()}`}
            className="-mr-1 flex h-7 w-7 items-center justify-center rounded-lg text-muted transition-colors hover:bg-elevated hover:text-ink"
          >
            <FoldIcon className="h-4 w-4" />
          </button>
        </div>
        {children}
      </aside>
    </>
  );
}
