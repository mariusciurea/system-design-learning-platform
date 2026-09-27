import { Link } from 'react-router-dom';
import { LogIn, Menu, Moon, PanelLeftClose, PanelLeftOpen, Search, Sun, UserRound } from 'lucide-react';
import { Button, Select } from '@/components/ui';
import { useTheme } from '@/app/providers/ThemeProvider';
import { useProgress } from '@/app/providers/ProgressProvider';
import { useAccount } from '@/app/providers/AccountProvider';
import { LG_QUERY, useMediaQuery } from '@/hooks/useMediaQuery';
import type { Difficulty } from '@/types';

interface TopBarProps {
  onOpenSearch: () => void;
  /** The id of the sidebar column the menu button opens or folds. */
  navId: string;
  /** Below lg this opens the drawer; from lg up it folds the sidebar into its icon strip. */
  onToggleSidebar: () => void;
  sidebarExpanded: boolean;
  difficulty: Difficulty | 'all';
  onDifficultyChange: (value: Difficulty | 'all') => void;
}

const DIFFICULTY_OPTIONS: { value: Difficulty | 'all'; label: string }[] = [
  { value: 'all', label: 'All levels' },
  { value: 'Beginner', label: 'Beginner' },
  { value: 'Intermediate', label: 'Intermediate' },
  { value: 'Advanced', label: 'Advanced' },
];

export function TopBar({ onOpenSearch, navId, onToggleSidebar, sidebarExpanded, difficulty, onDifficultyChange }: TopBarProps) {
  const { theme, toggle } = useTheme();
  const { overall } = useProgress();
  // Only the wide-screen sidebar folds; below lg the same button opens a drawer, as it always did.
  const canFold = useMediaQuery(LG_QUERY);

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-1.5 border-b border-line bg-surface/85 px-2 backdrop-blur sm:gap-3 sm:px-3 lg:px-5">
      <Button
        size="icon"
        variant="ghost"
        onClick={onToggleSidebar}
        aria-label="Toggle navigation"
        aria-expanded={sidebarExpanded}
        aria-controls={navId}
        title={canFold ? (sidebarExpanded ? 'Fold navigation' : 'Open navigation') : undefined}
      >
        <Menu className="h-5 w-5 lg:hidden" />
        {sidebarExpanded ? (
          <PanelLeftClose className="hidden h-5 w-5 lg:block" />
        ) : (
          <PanelLeftOpen className="hidden h-5 w-5 lg:block" />
        )}
      </Button>

      {/* Named in full: below sm only the mark shows, and the mark alone has no text. */}
      <Link to="/" aria-label="System Design Interactive, home" className="flex min-w-0 items-center gap-2.5 coarse:min-w-11">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-brand to-info text-white">
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
            <circle cx="12" cy="5" r="2" />
            <circle cx="5" cy="19" r="2" />
            <circle cx="19" cy="19" r="2" />
            <path d="M12 7v4M12 11H5v6M12 11h7v6" />
          </svg>
        </span>
        {/* One line each, never wrapped: a wrapped name grows taller than the 56px bar. */}
        <span className="hidden min-w-0 sm:block">
          <span className="block truncate whitespace-nowrap text-sm font-semibold leading-tight text-ink">
            System Design Interactive
          </span>
          <span className="hidden whitespace-nowrap text-[11px] leading-tight text-faint lg:block">
            Learn. Visualize. Experiment. Design.
          </span>
        </span>
      </Link>

      <div className="flex-1" />

      <button
        type="button"
        onClick={onOpenSearch}
        // The word is hidden on a narrow screen, and the button must still say what it does.
        aria-label="Search"
        aria-keyshortcuts="Control+K Meta+K /"
        className="flex h-9 shrink-0 items-center gap-2 whitespace-nowrap rounded-xl border border-line bg-elevated px-3 text-sm text-faint transition-colors hover:border-brand/50 hover:text-ink"
      >
        <Search className="h-4 w-4" aria-hidden />
        <span className="hidden md:inline">Search</span>
        <kbd className="hidden rounded border border-line px-1.5 py-0.5 font-mono text-[11px] md:inline">Ctrl K</kbd>
      </button>

      <div className="hidden xl:block">
        <Select
          aria-label="Difficulty"
          value={difficulty}
          options={DIFFICULTY_OPTIONS}
          onChange={onDifficultyChange}
          className="w-36"
        />
      </div>

      <Link
        to="/progress"
        className="flex h-9 shrink-0 items-center gap-2 rounded-xl border border-line bg-elevated px-2 text-xs text-muted transition-colors hover:border-brand/50 hover:text-ink sm:px-3"
        title="Learning progress"
        aria-label={`Progress: ${overall.done} of ${overall.total} Concepts Done`}
      >
        <span className="relative hidden h-1.5 w-16 overflow-hidden rounded-full bg-line sm:block" aria-hidden>
          <span className="absolute inset-y-0 left-0 rounded-full bg-ok" style={{ width: `${overall.percent}%` }} />
        </span>
        <span className="font-mono tabular-nums">{overall.percent}%</span>
      </Link>

      <Button size="icon" variant="ghost" onClick={toggle} aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}>
        {theme === 'dark' ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
      </Button>

      <AccountButton />
    </header>
  );
}

/**
 * "Sign in" for a Guest, the Account (its initial, and its email from lg up)
 * once signed in. Nothing at all in a build without Firebase. The initial is
 * text, not the Google photo, so the CSP img-src stays 'self' data:.
 */
function AccountButton() {
  const { available, status, email, openSignIn } = useAccount();
  if (!available) return null;

  if (status === 'guest') {
    return (
      <Button
        variant="primary"
        // The icon size, not md: md adds px-4, which leaves the icon 4px of a 36px button.
        size="icon"
        onClick={openSignIn}
        aria-label="Sign in"
        className="shrink-0 text-sm sm:w-auto sm:gap-2 sm:px-3"
      >
        <LogIn className="h-4 w-4" />
        <span className="hidden sm:inline">Sign in</span>
      </Button>
    );
  }

  const initial = email?.trim().charAt(0).toUpperCase();
  return (
    <Link
      to="/account"
      aria-label={status === 'restoring' ? 'Account' : `Account: ${email ?? 'signed in'}`}
      title={email ?? 'Account'}
      className="flex h-9 min-w-9 coarse:min-w-11 shrink-0 items-center justify-center gap-2 rounded-xl text-sm text-muted transition-colors hover:bg-elevated hover:text-ink lg:px-1.5"
    >
      <span
        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
          status === 'restoring' ? 'bg-elevated text-faint' : 'bg-brand/15 text-brand'
        }`}
        aria-hidden
      >
        {status === 'signed-in' && initial ? initial : <UserRound className="h-4 w-4" />}
      </span>
      {status === 'signed-in' && email ? <span className="hidden max-w-40 truncate lg:inline">{email}</span> : null}
    </Link>
  );
}
