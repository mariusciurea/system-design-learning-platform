import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Check } from 'lucide-react';
import { Badge, difficultyTone, SegmentedControl } from '@/components/ui';
import { CATEGORY_BY_ID, categoryStyle } from '@/data/categories';
import { CategoryIcon } from '@/data/categoryIcons';
import { CONCEPTS_BY_CATEGORY } from '@/data/concepts';
import { useProgress } from '@/app/providers/ProgressProvider';
import type { CategoryId, Difficulty } from '@/types';

export function CategoryPage() {
  const { categoryId } = useParams();
  // Own keys only: /categories/constructor must not find a built-in of the lookup object.
  const category =
    categoryId && Object.prototype.hasOwnProperty.call(CATEGORY_BY_ID, categoryId)
      ? CATEGORY_BY_ID[categoryId as CategoryId]
      : undefined;
  const [difficulty, setDifficulty] = useState<Difficulty | 'all'>('all');
  const { completed, categoryProgress } = useProgress();

  if (!category) {
    return (
      <div className="mx-auto max-w-2xl px-5 py-16 text-center">
        <h1 className="text-xl font-semibold text-ink">Category not found</h1>
        <Link to="/" className="mt-4 inline-block text-sm text-brand hover:underline">
          Back to the dashboard
        </Link>
      </div>
    );
  }

  const concepts = (CONCEPTS_BY_CATEGORY[category.id] ?? []).filter(
    (concept) => difficulty === 'all' || concept.difficulty === difficulty,
  );
  const progress = categoryProgress(category.id);

  return (
    <div className="px-5 py-8 lg:px-8">
      <div className="mx-auto max-w-4xl">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <div className="flex items-center gap-3" style={categoryStyle(category.id)}>
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-cat/10 text-cat">
                <CategoryIcon name={category.icon} className="h-5 w-5" />
              </span>
              <h1 className="text-2xl font-semibold tracking-tight text-ink">{category.title}</h1>
            </div>
            <p className="mt-1.5 max-w-2xl text-sm text-muted">{category.blurb}</p>
            <div className="mt-3 flex items-center gap-3 text-xs text-faint">
              <span>
                {progress.done} of {progress.total} Done
              </span>
              <span className="h-1.5 w-32 overflow-hidden rounded-full bg-line" aria-hidden>
                <span className="block h-full rounded-full bg-ok" style={{ width: `${progress.percent}%` }} />
              </span>
            </div>
          </div>
          <SegmentedControl
            value={difficulty}
            size="sm"
            aria-label="Difficulty"
            options={[
              { value: 'all', label: 'All' },
              { value: 'Beginner', label: 'Beginner' },
              { value: 'Intermediate', label: 'Intermediate' },
              { value: 'Advanced', label: 'Advanced' },
            ]}
            onChange={setDifficulty}
          />
        </header>

        <ul className="mt-6 space-y-2">
          {concepts.map((concept) => (
            <li key={concept.slug}>
              <Link
                to={`/concepts/${concept.slug}`}
                className="group flex items-start gap-4 rounded-2xl border border-line bg-surface p-4 transition-all hover:border-brand/50 hover:shadow-card"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-sm font-semibold text-ink group-hover:text-brand">{concept.title}</h2>
                    <Badge tone={difficultyTone(concept.difficulty)}>{concept.difficulty}</Badge>
                    {completed[concept.slug] ? (
                      <Badge tone="ok">
                        <Check className="h-3 w-3" />
                        Done
                      </Badge>
                    ) : null}
                  </div>
                  <p className="mt-1 text-xs leading-relaxed text-muted">{concept.tagline}</p>
                </div>
              </Link>
            </li>
          ))}
        </ul>

        {concepts.length === 0 ? (
          <p className="mt-10 text-center text-sm text-muted">No concepts at this difficulty in this category.</p>
        ) : null}
      </div>
    </div>
  );
}

export default CategoryPage;
