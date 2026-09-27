import { Suspense } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, BookOpen, Loader2 } from 'lucide-react';
import { Badge, difficultyTone, ErrorBoundary } from '@/components/ui';
import { CATEGORY_BY_ID } from '@/data/categories';
import { CategoryTag } from '@/data/categoryIcons';
import { CONCEPT_BY_SLUG } from '@/data/concepts';
import { getLab } from './registry';

/** Full-width standalone view of a single lab, outside its concept page. */
export function LabRoute() {
  const { labId } = useParams();
  const lab = getLab(labId);

  if (!lab) {
    return (
      <div className="mx-auto max-w-2xl px-5 py-16 text-center">
        <h1 className="text-xl font-semibold text-ink">Lab not found</h1>
        <p className="mt-2 text-sm text-muted">This lab does not exist, or has not been built yet.</p>
        <Link
          to="/labs"
          className="mt-6 inline-flex h-10 items-center gap-2 rounded-xl border border-line px-4 text-sm font-medium text-ink transition-colors hover:border-brand hover:text-brand"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to all labs
        </Link>
      </div>
    );
  }

  const concept = CONCEPT_BY_SLUG.get(lab.concept);
  const category = CATEGORY_BY_ID[lab.category];

  return (
    <div className="px-5 py-6 lg:px-8">
      <div className="mx-auto max-w-[1600px]">
        {/* The lab shows its own title and description right below, so the page
            heading is for screen readers only and this row stays a toolbar. */}
        <h1 className="sr-only">{lab.title}</h1>
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <Link to="/labs" className="flex items-center gap-1.5 text-xs text-faint transition-colors hover:text-brand">
            <ArrowLeft className="h-3.5 w-3.5" />
            All labs
          </Link>
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={difficultyTone(lab.difficulty)}>{lab.difficulty}</Badge>
            <CategoryTag category={category} variant="chip" />
            {concept ? (
              <Link
                to={`/concepts/${concept.slug}`}
                className="inline-flex h-10 items-center gap-2 rounded-xl border border-line bg-elevated px-4 text-sm font-medium text-ink transition-colors hover:border-brand/50 hover:text-brand"
              >
                <BookOpen className="h-4 w-4" />
                Read the concept
              </Link>
            ) : null}
          </div>
        </div>

        <ErrorBoundary area={lab.title}>
          <Suspense
            fallback={
              <div className="flex h-64 items-center justify-center gap-2 text-sm text-muted">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading lab...
              </div>
            }
          >
            <lab.Component />
          </Suspense>
        </ErrorBoundary>
      </div>
    </div>
  );
}

export default LabRoute;
