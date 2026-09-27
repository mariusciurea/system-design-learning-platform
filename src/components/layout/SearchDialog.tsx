import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { BookMarked, BookOpen, FlaskConical, FolderTree, Route, Search as SearchIcon, X } from 'lucide-react';
import { cn } from '@/utils/cn';
import { search, type SearchKind, type SearchResult } from '@/utils/search';
import { Badge, Modal } from '@/components/ui';

// The icon and the word tell the kinds apart. The status colors (ok, warn, danger) mean health,
// Difficulty and Done everywhere else, so a kind of result never wears one.
const KIND_META: Record<SearchKind, { label: string; Icon: typeof SearchIcon; tone: 'brand' | 'neutral' }> = {
  lab: { label: 'Lab', Icon: FlaskConical, tone: 'brand' },
  concept: { label: 'Concept', Icon: BookOpen, tone: 'neutral' },
  scenario: { label: 'Scenario', Icon: Route, tone: 'neutral' },
  glossary: { label: 'Glossary', Icon: BookMarked, tone: 'neutral' },
  category: { label: 'Category', Icon: FolderTree, tone: 'neutral' },
};

/**
 * The Search dialog body, in its own chunk: the search index (every Scenario and Glossary
 * entry) loads with it, not with the app shell. See CommandSearch.
 */
export default function SearchDialog({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const listId = useId();
  const optionId = (index: number) => `${listId}-${index}`;

  // Spaces alone are not a query: keep the suggestions rather than "No matches".
  const trimmed = query.trim();
  const results = useMemo(() => search(trimmed), [trimmed]);

  // The list scrolls, so arrowing past its bottom edge must bring the highlight along.
  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active, results]);

  // A new query means a new result list - the highlight goes back to the top.
  const changeQuery = (next: string) => {
    setQuery(next);
    setActive(0);
  };

  // Runs after Modal has noted what had focus before, so closing still hands focus back to it.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const go = (result: SearchResult | undefined) => {
    if (!result) return;
    navigate(result.to);
    onClose();
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((index) => Math.max(0, Math.min(index + 1, results.length - 1)));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((index) => Math.max(index - 1, 0));
    } else if (event.key === 'Enter' && event.target === inputRef.current) {
      // The Enter that confirms a Chinese or Japanese composition is not "open the result".
      if (event.nativeEvent.isComposing) return;
      // On a focused button, Enter keeps its native meaning (click that button).
      event.preventDefault();
      go(results[active]);
    }
  };

  return (
    <Modal
      onClose={onClose}
      label="Search"
      className="items-start justify-center bg-black/50 px-4 pt-[12vh] backdrop-blur-sm"
      panelClassName="w-full max-w-2xl overflow-hidden rounded-2xl border border-line bg-surface shadow-card"
      // On the panel rather than the input: Esc and the arrows must keep working
      // after a click moved focus onto a suggestion or result button.
      onKeyDown={onKeyDown}
    >
      <div className="flex items-center gap-3 border-b border-line px-4">
        <SearchIcon className="h-4 w-4 shrink-0 text-faint" aria-hidden />
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => changeQuery(event.target.value)}
          placeholder="Search concepts, labs, scenarios, glossary..."
          aria-label="Search query"
          type="search"
          role="combobox"
          aria-expanded={results.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={results[active] ? optionId(active) : undefined}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="none"
          spellCheck={false}
          enterKeyHint="go"
          maxLength={120}
          // 16px on a touch screen, so iOS does not zoom in when it takes focus. No ring: the caret already
          // shows where focus is, and a box inside the panel edge reads as a second border.
          className="h-14 min-w-0 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-faint focus-visible:ring-0 focus-visible:ring-offset-0 coarse:text-base [&::-webkit-search-cancel-button]:hidden"
        />
        <button
          type="button"
          onClick={onClose}
          aria-label="Close search"
          className="-mr-2 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-faint transition-colors hover:bg-elevated hover:text-ink"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>

      <p aria-live="polite" className="sr-only">
        {trimmed ? `${results.length} ${results.length === 1 ? 'result' : 'results'}` : ''}
      </p>

      <div ref={listRef} className="max-h-[50vh] overflow-y-auto p-2">
        {trimmed && results.length === 0 ? (
          <p className="break-words px-3 py-8 text-center text-sm text-muted">
            No matches for &ldquo;{trimmed}&rdquo;. Try &ldquo;cache&rdquo;, &ldquo;shard&rdquo; or &ldquo;queue&rdquo;.
          </p>
        ) : null}

        {!trimmed ? (
          <div className="px-3 py-6 text-center text-sm text-muted">
            Try{' '}
            {['load balancer', 'caching', 'sharding', 'circuit breaker'].map((suggestion) => (
              <button
                key={suggestion}
                type="button"
                onClick={() => {
                  changeQuery(suggestion);
                  // The chip unmounts once results show - hand focus back to the input.
                  inputRef.current?.focus();
                }}
                className="mx-1 rounded-md border border-line px-2 py-0.5 text-xs text-ink transition-colors hover:border-brand hover:text-brand"
              >
                {suggestion}
              </button>
            ))}
          </div>
        ) : null}

        <div id={listId} role="listbox" aria-label="Search results" hidden={results.length === 0}>
          {results.map((result, index) => {
            const meta = KIND_META[result.kind];
            return (
              <button
                key={result.id}
                id={optionId(index)}
                type="button"
                role="option"
                aria-selected={index === active}
                data-active={index === active}
                onMouseEnter={() => setActive(index)}
                onClick={() => go(result)}
                className={cn(
                  'flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors',
                  index === active ? 'bg-elevated' : 'hover:bg-elevated',
                )}
              >
                <meta.Icon className="h-4 w-4 shrink-0 text-faint" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-ink">{result.title}</span>
                  <span className="block truncate text-xs text-faint">{result.subtitle}</span>
                </span>
                <Badge tone={meta.tone}>{meta.label}</Badge>
              </button>
            );
          })}
        </div>
      </div>

      {/* Keyboard hints only where there is a keyboard: a touch screen has no arrow keys or Esc. */}
      <div className="flex items-center gap-4 border-t border-line px-4 py-2 text-[11px] text-faint coarse:hidden">
        <span>
          <kbd className="rounded border border-line px-1">up</kbd>{' '}
          <kbd className="rounded border border-line px-1">down</kbd> navigate
        </span>
        <span>
          <kbd className="rounded border border-line px-1">enter</kbd> open
        </span>
        <span>
          <kbd className="rounded border border-line px-1">esc</kbd> close
        </span>
      </div>
    </Modal>
  );
}
