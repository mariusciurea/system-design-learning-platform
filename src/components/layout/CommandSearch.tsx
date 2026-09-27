import { Suspense, useEffect, useId, useState } from 'react';
import { AlertTriangle, RotateCcw, WifiOff } from 'lucide-react';
import { Button, ErrorBoundary, Modal } from '@/components/ui';
import { lazyWithRetry } from '@/utils/lazyWithRetry';

// The dialog brings the search index with it - every Scenario and the Glossary, about
// 15 KB gzip - so it is its own chunk instead of part of the JavaScript every page waits for.
const importSearchDialog = () => import('./SearchDialog');
const loadSearchDialog = () => lazyWithRetry(importSearchDialog);

interface CommandSearchProps {
  open: boolean;
  onClose: () => void;
}

/**
 * Global search dialog (Ctrl/Cmd+K). Results are grouped by kind and keyboard
 * navigable with arrows and Enter.
 */
export function CommandSearch({ open, onClose }: CommandSearchProps) {
  const [SearchDialog, setSearchDialog] = useState(loadSearchDialog);

  // Fetched once the page is idle, so the first Ctrl+K opens at once and a Learner
  // who goes offline later can still search.
  useEffect(() => {
    const prefetch = () => void importSearchDialog().catch(() => {});
    // Safari has no requestIdleCallback.
    if (typeof window.requestIdleCallback === 'function') {
      const id = window.requestIdleCallback(prefetch, { timeout: 5000 });
      return () => window.cancelIdleCallback(id);
    }
    const id = setTimeout(prefetch, 2000);
    return () => clearTimeout(id);
  }, []);

  // Mounted only while open, so every opening starts from an empty query.
  if (!open) return null;
  return (
    // Its own boundary: this sits outside the page boundary, so a failed download here
    // would otherwise replace every page with the application crash screen.
    <ErrorBoundary
      area="Search"
      fallback={(_error, reset) => (
        <SearchUnavailable
          onClose={onClose}
          onRetry={() => {
            setSearchDialog(() => loadSearchDialog());
            reset();
          }}
        />
      )}
    >
      <Suspense fallback={null}>
        <SearchDialog onClose={onClose} />
      </Suspense>
    </ErrorBoundary>
  );
}

/** Stands in for the search dialog when its code could not be downloaded. */
function SearchUnavailable({ onClose, onRetry }: { onClose: () => void; onRetry: () => void }) {
  const titleId = useId();
  const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
  const Icon = offline ? WifiOff : AlertTriangle;
  return (
    <Modal
      onClose={onClose}
      labelledBy={titleId}
      className="items-start justify-center overflow-y-auto bg-black/50 px-4 pb-4 pt-[12vh] backdrop-blur-sm short:pt-4"
      panelClassName="w-full max-w-sm rounded-2xl border border-line bg-surface p-5 shadow-card"
    >
      <div role="alert" className="flex items-start gap-3">
        <Icon className="mt-0.5 h-5 w-5 shrink-0 text-warn" aria-hidden />
        <div className="min-w-0">
          <h2 id={titleId} className="text-sm font-semibold text-ink">
            Search could not load
          </h2>
          <p className="mt-1 text-sm text-muted">
            {offline
              ? 'You are offline. Reconnect, then try again. The sidebar still reaches every Concept.'
              : 'The connection dropped while it was downloading. Try again. The sidebar still reaches every Concept.'}
          </p>
        </div>
      </div>
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <Button onClick={onClose}>Close</Button>
        <Button variant="primary" onClick={onRetry}>
          <RotateCcw className="h-4 w-4" aria-hidden />
          Try again
        </Button>
      </div>
    </Modal>
  );
}
