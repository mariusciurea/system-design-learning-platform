import { Link } from 'react-router-dom';
import { Check, LogIn, RotateCcw, X } from 'lucide-react';
import { Button, Meter } from '@/components/ui';
import { useAccount } from '@/app/providers/AccountProvider';
import { CATEGORIES, categoryStyle } from '@/data/categories';
import { CategoryIcon } from '@/data/categoryIcons';
import { CONCEPT_BY_SLUG } from '@/data/concepts';
import { useProgress } from '@/app/providers/ProgressProvider';
import { passMark } from '@/app/providers/progressState';

export function ProgressPage() {
  const { overall, categoryProgress, completed, quiz, visited, synced, reset } = useProgress();
  const { available, openSignIn } = useAccount();
  const quizEntries = Object.entries(quiz);
  const visitedCount = Object.keys(visited).length;

  return (
    <div className="px-5 py-8 lg:px-8">
      <div className="mx-auto max-w-4xl">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-ink">System Design Progress</h1>
            <p className="mt-1.5 text-sm text-muted">
              {synced
                ? 'Saved in this browser and to your Account, so it follows you to every device you sign in on.'
                : available
                  ? 'Saved in this browser only. Sign in to keep it on every device.'
                  : 'Saved in this browser only.'}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {!synced && available ? (
              <Button variant="secondary" onClick={openSignIn}>
                <LogIn className="h-4 w-4" aria-hidden />
                Sign in
              </Button>
            ) : null}
            <Button
              variant="secondary"
              onClick={() => {
                const question = synced
                  ? 'Reset all progress? This clears it on every device, and cannot be undone.'
                  : 'Reset all progress? This cannot be undone.';
                if (window.confirm(question)) reset();
              }}
            >
              <RotateCcw className="h-4 w-4" aria-hidden />
              Reset progress
            </Button>
          </div>
        </header>

        <div className="mt-6 grid gap-3 sm:grid-cols-3">
          <div className="rounded-2xl border border-line bg-surface p-5">
            <p className="label">Done</p>
            <p className="metric-value mt-1 text-ink">
              {overall.done}
              <span className="text-sm font-normal text-muted"> of {overall.total}</span>
            </p>
            {/* The number above says it; the bar is only its picture. Always ok: done is never a warning. */}
            <div aria-hidden className="mt-3">
              <Meter value={overall.percent / 100} tone="ok" showValue={false} />
            </div>
          </div>
          <div className="rounded-2xl border border-line bg-surface p-5">
            <p className="label">Concepts opened</p>
            <p className="metric-value mt-1 text-ink">{visitedCount}</p>
          </div>
          <div className="rounded-2xl border border-line bg-surface p-5">
            <p className="label">Quizzes taken</p>
            <p className="metric-value mt-1 text-ink">{quizEntries.length}</p>
          </div>
        </div>

        <section className="mt-8">
          <h2 className="text-sm font-semibold text-ink">By Category</h2>
          <ul className="mt-3 space-y-2">
            {CATEGORIES.map((category) => {
              const progress = categoryProgress(category.id);
              return (
                <li key={category.id}>
                  <Link
                    to={`/categories/${category.id}`}
                    style={categoryStyle(category.id)}
                    className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-line bg-surface px-3 py-3 transition-colors hover:border-brand/50 sm:flex-nowrap sm:gap-4 sm:px-4"
                  >
                    {/* A phone gives the name its own line, so no Category name is cut short. */}
                    <span className="flex w-full min-w-0 shrink-0 items-center gap-2.5 text-sm text-ink sm:w-52">
                      <CategoryIcon name={category.icon} className="h-4 w-4 shrink-0 text-cat" />
                      <span className="truncate">{category.title}</span>
                    </span>
                    <div aria-hidden className="min-w-0 flex-1">
                      <Meter value={progress.percent / 100} tone="ok" showValue={false} />
                    </div>
                    <span className="w-12 shrink-0 text-right font-mono text-xs tabular-nums text-muted sm:w-20">
                      <span className="sr-only">Done: </span>
                      {progress.done}/{progress.total}
                    </span>
                    {/* The done count says the same; a phone has no room for both. */}
                    <span className="hidden w-12 shrink-0 text-right font-mono text-xs tabular-nums text-muted sm:inline">
                      {progress.percent}%
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>

        {quizEntries.length > 0 ? (
          <section className="mt-8">
            <h2 className="text-sm font-semibold text-ink">Quiz results</h2>
            <ul className="mt-3 space-y-2">
              {quizEntries.map(([slug, result]) => {
                const concept = CONCEPT_BY_SLUG.get(slug);
                if (!concept) return null;
                const passed = result.total > 0 && result.correct >= passMark(result.total);
                return (
                  <li key={slug}>
                    <Link
                      to={`/concepts/${slug}`}
                      className="flex items-center justify-between gap-4 rounded-xl border border-line bg-surface px-4 py-3 transition-colors hover:border-brand/50"
                    >
                      <span className="min-w-0 text-sm text-ink">{concept.title}</span>
                      {/* Passed or not is said in words too, never by the color alone. */}
                      <span className="flex shrink-0 items-center gap-1.5 font-mono text-xs tabular-nums text-muted">
                        {passed ? (
                          <Check className="h-3.5 w-3.5 text-ok" aria-hidden />
                        ) : (
                          <X className="h-3.5 w-3.5 text-warn" aria-hidden />
                        )}
                        <span className="sr-only">{passed ? 'Passed, ' : 'Not passed yet, '}</span>
                        {result.correct}/{result.total}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}

        <section className="mt-8">
          <h2 className="text-sm font-semibold text-ink">Done</h2>
          {Object.keys(completed).length === 0 ? (
            <p className="mt-2 text-sm text-muted">
              No Concept is Done yet. Mark one Done on its page, or score 70% or more on its Quiz.
            </p>
          ) : (
            <ul className="mt-3 flex flex-wrap gap-2">
              {Object.keys(completed).map((slug) => {
                const concept = CONCEPT_BY_SLUG.get(slug);
                if (!concept) return null;
                return (
                  <li key={slug}>
                    <Link
                      to={`/concepts/${slug}`}
                      className="inline-flex items-center gap-1.5 rounded-full border border-ok/30 bg-ok/5 px-3 py-1.5 text-xs text-ink transition-colors hover:border-ok"
                    >
                      <Check className="h-3 w-3 text-ok" aria-hidden />
                      {concept.title}
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

export default ProgressPage;
