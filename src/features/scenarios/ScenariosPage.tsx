import { Link } from 'react-router-dom';
import { ArrowRight, Route } from 'lucide-react';
import { Badge, difficultyTone } from '@/components/ui';
import { CONCEPT_BY_SLUG } from '@/data/concepts';
import { SCENARIOS } from '@/data/scenarios';

export function ScenariosPage() {
  return (
    <div className="px-5 py-8 lg:px-8">
      <div className="mx-auto max-w-5xl">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">Scenarios</h1>
          <p className="mt-1.5 max-w-2xl text-sm text-muted">
            End-to-end walkthroughs of real products: requirements, capacity estimation, high-level design, database
            choice, API, scaling, caching, reliability, bottlenecks and trade-offs.
          </p>
        </header>

        <div className="mt-6 grid gap-4 md:grid-cols-2">
          {SCENARIOS.map((scenario) => (
            <Link
              key={scenario.slug}
              to={`/scenarios/${scenario.slug}`}
              className="group flex flex-col rounded-2xl border border-line bg-surface p-5 transition-all hover:border-brand/50 hover:shadow-card"
            >
              <div className="flex items-start justify-between gap-3">
                <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand/10 text-brand">
                  <Route className="h-4 w-4" />
                </span>
                <Badge tone={difficultyTone(scenario.difficulty)}>{scenario.difficulty}</Badge>
              </div>
              <h2 className="mt-3 text-sm font-semibold text-ink group-hover:text-brand">{scenario.title}</h2>
              <p className="mt-1.5 flex-1 text-xs leading-relaxed text-muted">{scenario.tagline}</p>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {scenario.concepts.slice(0, 4).map((slug) => {
                  const concept = CONCEPT_BY_SLUG.get(slug);
                  return concept ? (
                    <span key={slug} className="rounded-full border border-line px-2 py-0.5 text-[11px] text-faint">
                      {concept.title}
                    </span>
                  ) : null;
                })}
              </div>
              <span className="mt-3 flex items-center gap-1 text-xs text-brand">
                Open scenario <ArrowRight className="h-3 w-3" />
              </span>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}

export default ScenariosPage;
