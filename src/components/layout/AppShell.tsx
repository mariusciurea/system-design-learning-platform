import { useEffect, useRef, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { cn } from '@/utils/cn';
import { ErrorBoundary } from '@/components/ui';
import { useLayout } from '@/app/providers/LayoutProvider';
import { LG_QUERY, useMediaQuery } from '@/hooks/useMediaQuery';
import { useRouteAnnouncer } from '@/hooks/useRouteAnnouncer';
import type { Difficulty } from '@/types';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';
import { CommandSearch } from './CommandSearch';

/** The id of the sidebar column, named by the menu button's aria-controls. */
const NAV_ID = 'app-navigation';

/** True while focus is somewhere "/" is a character, not a shortcut. */
const isTyping = (element: Element | null) =>
  element instanceof HTMLElement &&
  (element.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName));

/**
 * Two-column application layout: persistent navigation on the left, the active
 * workspace on the right. The sidebar collapses into an overlay below lg; from
 * lg up the learner can fold it into a strip of icons, and that choice persists.
 */
export function AppShell() {
  const [searchOpen, setSearchOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [difficulty, setDifficulty] = useState<Difficulty | 'all'>('all');
  const location = useLocation();
  const mainRef = useRef<HTMLElement>(null);
  const { sidebarFolded, setFolded } = useLayout();
  const isWide = useMediaQuery(LG_QUERY);
  // A stored fold only applies to the static column; the small-screen drawer always shows everything.
  const folded = isWide && sidebarFolded;
  const announcement = useRouteAnnouncer(location.pathname, mainRef);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // An open dialog (sign-in, delete, search itself) owns the keyboard: Search would open
      // under it and take focus, so the Learner would type into a field they cannot see.
      const dialogOpen = document.querySelector('[aria-modal="true"]') !== null;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        if (!dialogOpen) setSearchOpen(true);
      }
      if (event.key === '/' && !dialogOpen && !isTyping(document.activeElement)) {
        event.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    if (!mobileNavOpen) return;
    // Escape closes the drawer, as it closes a dialog, and focus goes back to the button that opened it.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || document.querySelector('[aria-modal="true"]')) return;
      setMobileNavOpen(false);
      document.querySelector<HTMLElement>(`[aria-controls="${NAV_ID}"]`)?.focus();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [mobileNavOpen]);

  useEffect(() => {
    // Any navigation closes the mobile drawer, including back/forward, which
    // never passes through the sidebar's own onNavigate.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMobileNavOpen(false);
    document.querySelector('main')?.scrollTo({ top: 0 });
  }, [location.pathname]);

  return (
    <div className="flex h-full flex-col bg-canvas">
      {/* The first Tab stop: it jumps past the top bar and the long sidebar list to the page itself. */}
      <a
        href="#main"
        onClick={(event) => {
          event.preventDefault();
          mainRef.current?.focus();
        }}
        className="sr-only z-50 rounded-xl bg-brand px-4 py-2 text-sm font-medium text-on-fill focus:not-sr-only focus:fixed focus:left-3 focus:top-2"
      >
        Skip to content
      </a>

      <TopBar
        onOpenSearch={() => setSearchOpen(true)}
        navId={NAV_ID}
        onToggleSidebar={() => (isWide ? setFolded('sidebarFolded', !sidebarFolded) : setMobileNavOpen((open) => !open))}
        sidebarExpanded={isWide ? !sidebarFolded : mobileNavOpen}
        difficulty={difficulty}
        onDifficultyChange={setDifficulty}
      />

      <div className="flex min-h-0 flex-1">
        <aside
          id={NAV_ID}
          className={cn(
            'w-72 shrink-0 overflow-hidden border-r border-line bg-surface',
            // The drawer runs from under the top bar to the bottom of the screen.
            'fixed bottom-0 left-0 top-14 z-40 transition-[transform,width,visibility] duration-150 lg:static lg:inset-auto lg:translate-x-0',
            folded && 'lg:w-14',
            // A closed drawer is hidden as well as moved away, so Tab does not walk through links no one can see.
            mobileNavOpen ? 'translate-x-0 shadow-2xl' : '-translate-x-full max-lg:invisible',
          )}
        >
          <Sidebar
            difficulty={difficulty}
            folded={folded}
            onUnfold={() => setFolded('sidebarFolded', false)}
            onNavigate={() => setMobileNavOpen(false)}
          />
        </aside>

        {mobileNavOpen ? (
          <div
            className="fixed inset-0 top-14 z-30 bg-black/40 lg:hidden"
            onClick={() => setMobileNavOpen(false)}
            aria-hidden
          />
        ) : null}

        <main
          ref={mainRef}
          id="main"
          tabIndex={-1}
          className="min-w-0 flex-1 overflow-y-auto outline-none focus-visible:ring-0 focus-visible:ring-offset-0"
        >
          {/* Keyed by path so that one crashed page does not keep every other route showing its error. */}
          <ErrorBoundary area="This page" key={location.pathname}>
            <Outlet />
          </ErrorBoundary>
        </main>
      </div>

      <CommandSearch open={searchOpen} onClose={() => setSearchOpen(false)} />
      {/* Names the new page after an in-app navigation, as a full page load would. */}
      <p aria-live="polite" aria-atomic="true" className="sr-only">
        {announcement}
      </p>
    </div>
  );
}
