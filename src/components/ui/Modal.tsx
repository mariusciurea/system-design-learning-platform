import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from '@/utils/cn';

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface ModalProps {
  onClose: () => void;
  /** The id of the visible heading that names the dialog. */
  labelledBy?: string;
  /** The dialog name when it has no visible heading. */
  label?: string;
  /** The dimmed layer over the page. It also places the panel (flex alignment, padding). */
  className?: string;
  panelClassName?: string;
  /** Keys the dialog handles itself. Escape and Tab are handled first. */
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
  children: ReactNode;
}

/**
 * The shell of every modal dialog: a dimmed layer that closes on a click, and a panel that closes on
 * Escape, keeps Tab inside itself and gives focus back to whatever opened it. Render it only while
 * the dialog is open. A child may take focus itself (a search input); otherwise the panel takes it.
 */
export function Modal({ onClose, labelledBy, label, className, panelClassName, onKeyDown, children }: ModalProps) {
  const panel = useRef<HTMLDivElement>(null);
  // Where the press started. A drag that starts in a field (selecting text) and ends on the dimmed
  // layer fires a click there too; closing on it would throw away what was typed.
  const pressedOnLayer = useRef(false);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!panel.current?.contains(document.activeElement)) panel.current?.focus();
    return () => opener?.focus();
  }, []);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key === 'Tab' && panel.current) {
      const items = Array.from(panel.current.querySelectorAll<HTMLElement>(FOCUSABLE));
      const first = items[0];
      const last = items[items.length - 1];
      if (first && event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) {
        event.preventDefault();
        last.focus();
      } else if (last && !event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
      return;
    }
    onKeyDown?.(event);
  };

  return (
    <div
      className={cn('fixed inset-0 z-50 flex bg-black/40', className)}
      onPointerDown={(event) => {
        pressedOnLayer.current = event.target === event.currentTarget;
      }}
      onClick={(event) => {
        if (pressedOnLayer.current && event.target === event.currentTarget) onClose();
        pressedOnLayer.current = false;
      }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-label={label}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={handleKeyDown}
        className={cn('outline-none', panelClassName)}
      >
        {children}
      </div>
    </div>
  );
}
