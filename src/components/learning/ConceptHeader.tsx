import { Link } from 'react-router-dom';
import { Check } from 'lucide-react';
import type { ConceptSummary } from '@/types';
import { Badge, Button, difficultyTone } from '@/components/ui';
import { CATEGORY_BY_ID, categoryStyle } from '@/data/categories';
import { CategoryTag } from '@/data/categoryIcons';
import { useProgress } from '@/app/providers/ProgressProvider';

export function ConceptHeader({ concept }: { concept: ConceptSummary }) {
  const { completed, toggleCompleted } = useProgress();
  const isDone = Boolean(completed[concept.slug]);
  const category = CATEGORY_BY_ID[concept.category];

  return (
    <header className="border-b border-line bg-surface px-5 py-4 sm:py-6 lg:px-8">
      {/* The same width as the body under it, so the two left edges line up on a wide screen. */}
      <div className="mx-auto max-w-[1600px]">
        <div className="flex items-center gap-2 text-xs text-faint">
          <Link
            to={`/categories/${category.id}`}
            style={categoryStyle(category.id)}
            className="inline-flex items-center transition-colors hover:text-cat"
          >
            {category.title}
          </Link>
          <span aria-hidden>/</span>
          <span className="min-w-0 truncate">{concept.title}</span>
        </div>

        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-ink lg:text-3xl">{concept.title}</h1>
        <p className="mt-1.5 max-w-3xl text-sm text-muted">{concept.tagline}</p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Badge tone={difficultyTone(concept.difficulty)}>{concept.difficulty}</Badge>
          <CategoryTag category={category} variant="chip" />
          {/* Passing the Quiz is the way to Done, so this manual mark stays quiet beside the badges. */}
          <Button
            size="sm"
            variant={isDone ? 'success' : 'ghost'}
            onClick={() => toggleCompleted(concept.slug)}
            aria-pressed={isDone}
            className="ml-auto"
          >
            <Check className="h-3.5 w-3.5" aria-hidden />
            {isDone ? 'Done' : 'Mark as Done'}
          </Button>
        </div>
      </div>
    </header>
  );
}
