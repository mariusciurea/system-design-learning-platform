import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Search } from 'lucide-react';
import { GLOSSARY } from '@/data/glossary';

export function GlossaryPage() {
  const [query, setQuery] = useState('');
  const trimmed = query.trim();

  const grouped = useMemo(() => {
    const normalised = query.trim().toLowerCase();
    const filtered = normalised
      ? GLOSSARY.filter(
          (entry) =>
            entry.term.toLowerCase().includes(normalised) || entry.definition.toLowerCase().includes(normalised),
        )
      : GLOSSARY;

    const map = new Map<string, typeof GLOSSARY>();
    for (const entry of filtered) {
      const letter = entry.term.charAt(0).toUpperCase();
      map.set(letter, [...(map.get(letter) ?? []), entry]);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [query]);
  const matchCount = grouped.reduce((total, [, entries]) => total + entries.length, 0);

  return (
    <div className="px-5 py-8 lg:px-8">
      <div className="mx-auto max-w-4xl">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">Glossary</h1>
          <p className="mt-1.5 text-sm text-muted">
            {GLOSSARY.length} terms. Click any entry to open the lesson that teaches it.
          </p>
        </header>

        <div className="relative mt-5">
          <Search className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter terms..."
            aria-label="Filter glossary"
            type="search"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            maxLength={80}
            // 16px on a touch screen, so iOS does not zoom in when it takes focus.
            className="h-11 w-full rounded-xl border border-field bg-surface pl-10 pr-4 text-sm text-ink outline-none transition-colors placeholder:text-faint focus:border-brand coarse:text-base [&::-webkit-search-cancel-button]:hidden"
          />
        </div>
        <p aria-live="polite" className="sr-only">
          {trimmed ? `${matchCount} ${matchCount === 1 ? 'term matches' : 'terms match'}` : ''}
        </p>

        <div className="mt-6 space-y-8">
          {grouped.map(([letter, entries]) => (
            <section key={letter}>
              <h2 className="mb-2 font-mono text-xs font-semibold uppercase tracking-widest text-faint">{letter}</h2>
              <div className="grid gap-2 sm:grid-cols-2">
                {entries.map((entry) =>
                  entry.slug ? (
                    <Link
                      key={entry.term}
                      to={`/concepts/${entry.slug}`}
                      className="group rounded-xl border border-line bg-surface p-4 transition-colors hover:border-brand/50 focus-visible:border-brand/50"
                    >
                      <p className="flex items-center gap-1.5 text-sm font-semibold text-ink group-hover:text-brand group-focus-visible:text-brand">
                        {entry.term}
                        {/* The arrow marks the card as a link: revealed by hover or keyboard focus, and always
                            shown where there is no hover (touch screens). Plain cards never render it. */}
                        <ArrowRight
                          aria-hidden
                          className="h-3 w-3 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 coarse:opacity-100"
                        />
                      </p>
                      <p className="mt-1 text-xs leading-relaxed text-muted">{entry.definition}</p>
                    </Link>
                  ) : (
                    <div key={entry.term} className="rounded-xl border border-line bg-surface p-4">
                      <p className="text-sm font-semibold text-ink">{entry.term}</p>
                      <p className="mt-1 text-xs leading-relaxed text-muted">{entry.definition}</p>
                    </div>
                  ),
                )}
              </div>
            </section>
          ))}
        </div>

        {grouped.length === 0 ? (
          <div className="mt-10 text-center">
            <p className="break-words text-sm text-muted">No terms match &ldquo;{trimmed}&rdquo;.</p>
            <button
              type="button"
              onClick={() => setQuery('')}
              className="mt-3 rounded text-sm font-medium text-brand hover:underline"
            >
              Show all {GLOSSARY.length} terms
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default GlossaryPage;
