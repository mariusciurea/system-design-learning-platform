import { Link } from 'react-router-dom';
import { ArrowRight, FlaskConical, Layers3, Play, Route, Waypoints } from 'lucide-react';
import { CategoryIcon, CategoryTag } from '@/data/categoryIcons';
import { FlowVisual } from '@/components/architecture/FlowVisual';
import { HERO_VISUAL } from '@/data/visuals/hero';
import { Badge, difficultyTone } from '@/components/ui';
import { CATEGORIES, CATEGORY_BY_ID, categoryStyle } from '@/data/categories';
import { CONCEPTS, CONCEPTS_BY_CATEGORY } from '@/data/concepts';
import { SCENARIOS } from '@/data/scenarios';
import { FEATURED_LABS, LABS } from '@/features/labs/registry';
import { useProgress } from '@/app/providers/ProgressProvider';

export function HomePage() {
  const { overall, categoryProgress } = useProgress();

  return (
    <div className="pb-14">
      {/* Hero */}
      <section className="relative overflow-hidden border-b border-line">
        <div
          className="absolute inset-0 bg-gradient-to-br from-brand/10 via-transparent to-violet/10"
          aria-hidden
        />
        <div className="relative mx-auto max-w-6xl px-5 py-16 lg:px-8 lg:py-20">
          <h1 className="max-w-3xl text-4xl font-semibold leading-tight tracking-tight text-ink lg:text-5xl">
            System Design
            <span className="block">Interactive</span>
          </h1>
          <p className="mt-4 max-w-2xl text-base text-muted lg:text-lg">
            Learn architecture by seeing systems work. Generate traffic, overload a server, kill a database, add a
            cache - and watch what actually changes.
          </p>

          <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
            <Link
              to="/concepts/what-is-system-design"
              className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-brand px-5 text-sm font-medium text-on-fill transition-colors hover:bg-brand/90"
            >
              <Play className="h-4 w-4" />
              Start learning
            </Link>
            <Link
              to="/playground"
              className="inline-flex h-11 items-center justify-center gap-2 rounded-xl border border-line bg-surface px-5 text-sm font-medium text-ink transition-colors hover:border-brand hover:text-brand"
            >
              <Layers3 className="h-4 w-4" />
              Open playground
            </Link>
            <Link
              to="/labs"
              className="inline-flex h-11 items-center justify-center gap-2 rounded-xl border border-line bg-surface px-5 text-sm font-medium text-ink transition-colors hover:border-brand hover:text-brand"
            >
              <FlaskConical className="h-4 w-4" />
              Browse labs
            </Link>
          </div>
          <p className="mt-4 text-sm text-faint">
            {CONCEPTS.length} concepts and {LABS.length} labs.
          </p>

          <div className="mt-8 max-w-3xl">
            <FlowVisual spec={HERO_VISUAL} className="bg-surface/70" />
            <p className="mt-2 text-xs text-faint">
              Every component here is something you can add, overload, kill and restart yourself.
            </p>
          </div>
        </div>
      </section>

      {/* Progress */}
      {overall.done > 0 ? (
        <section className="border-b border-line bg-surface">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-4 px-5 py-4 lg:px-8">
            <span className="text-sm text-muted">
              Your progress: <strong className="text-ink">{overall.done}</strong> of {overall.total} concepts
            </span>
            <span className="h-2 w-40 overflow-hidden rounded-full bg-line" aria-hidden>
              <span className="block h-full rounded-full bg-ok" style={{ width: `${overall.percent}%` }} />
            </span>
            <Link to="/progress" className="text-sm text-brand hover:underline">
              See details
            </Link>
          </div>
        </section>
      ) : null}

      {/* Featured labs */}
      <section className="mx-auto max-w-6xl px-5 py-12 lg:px-8">
        <div className="flex items-end justify-between gap-4">
          <div>
            <h2 className="text-xl font-semibold text-ink">Labs to start with</h2>
            <p className="mt-1 text-sm text-muted">Simulations where changing a control changes the outcome.</p>
          </div>
          <Link to="/labs" className="flex items-center gap-1 text-sm text-brand hover:underline">
            All {LABS.length} labs <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </div>

        <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURED_LABS.map((lab) => (
            <Link
              key={lab.id}
              to={`/labs/${lab.id}`}
              style={categoryStyle(lab.category)}
              className="group flex flex-col rounded-2xl border border-line bg-surface p-5 transition-all hover:border-brand/50 hover:shadow-card"
            >
              <div className="flex items-start justify-between">
                <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-cat/10 text-cat">
                  <FlaskConical className="h-4 w-4" />
                </span>
                <Badge tone={difficultyTone(lab.difficulty)}>{lab.difficulty}</Badge>
              </div>
              <h3 className="mt-3 text-sm font-semibold text-ink group-hover:text-brand">{lab.title}</h3>
              <p className="mt-1.5 flex-1 text-xs leading-relaxed text-muted">{lab.blurb}</p>
              <CategoryTag category={CATEGORY_BY_ID[lab.category]} className="mt-3" />
            </Link>
          ))}
        </div>
      </section>

      {/* Categories */}
      <section className="mx-auto max-w-6xl px-5 pb-12 lg:px-8">
        <h2 className="text-xl font-semibold text-ink">Explore System Design</h2>
        <p className="mt-1 text-sm text-muted">
          {CONCEPTS.length} concepts, each one built around a visual explanation first.
        </p>

        <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {CATEGORIES.map((category) => {
            const progress = categoryProgress(category.id);
            // Distinct Labs: every Concept hosts one, and a shared Lab counts once.
            const labCount = new Set((CONCEPTS_BY_CATEGORY[category.id] ?? []).map((concept) => concept.lab)).size;
            return (
              <Link
                key={category.id}
                to={`/categories/${category.id}`}
                style={categoryStyle(category.id)}
                className="group rounded-2xl border border-line bg-surface p-5 transition-all hover:border-brand/50 hover:shadow-card"
              >
                <div className="flex items-start gap-3">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-cat/10 text-cat">
                    <CategoryIcon name={category.icon} className="h-4 w-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <h3 className="text-sm font-semibold text-ink group-hover:text-brand">{category.title}</h3>
                    <p className="mt-1 text-xs leading-relaxed text-muted">{category.blurb}</p>
                    <div className="mt-3 flex items-center gap-3 text-[11px] text-faint">
                      <span>{progress.total} concepts</span>
                      {labCount > 0 ? (
                        <span className="flex items-center gap-1 text-brand">
                          <FlaskConical className="h-3 w-3" />
                          {labCount} lab{labCount > 1 ? 's' : ''}
                        </span>
                      ) : null}
                      {progress.done > 0 ? <span className="text-ok">{progress.percent}% done</span> : null}
                    </div>
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      </section>

      {/* Scenarios + tools */}
      <section className="mx-auto max-w-6xl px-5 lg:px-8">
        <div className="grid gap-4 lg:grid-cols-3">
          <Link
            to="/scenarios"
            className="group rounded-2xl border border-line bg-surface p-6 transition-all hover:border-brand/50"
          >
            <Route className="h-5 w-5 text-brand" />
            <h3 className="mt-3 text-sm font-semibold text-ink group-hover:text-brand">Scenarios</h3>
            <p className="mt-1.5 text-xs leading-relaxed text-muted">
              {SCENARIOS.length} end-to-end walkthroughs - requirements, estimation, high-level design, bottlenecks and
              trade-offs.
            </p>
          </Link>
          <Link
            to="/evolution"
            className="group rounded-2xl border border-line bg-surface p-6 transition-all hover:border-brand/50"
          >
            <Waypoints className="h-5 w-5 text-brand" />
            <h3 className="mt-3 text-sm font-semibold text-ink group-hover:text-brand">System Evolution</h3>
            <p className="mt-1.5 text-xs leading-relaxed text-muted">
              Watch one architecture grow from client-server to a distributed system - and see which problem forced
              each component in.
            </p>
          </Link>
          <Link
            to="/playground"
            className="group rounded-2xl border border-line bg-surface p-6 transition-all hover:border-brand/50"
          >
            <Layers3 className="h-5 w-5 text-brand" />
            <h3 className="mt-3 text-sm font-semibold text-ink group-hover:text-brand">Playground</h3>
            <p className="mt-1.5 text-xs leading-relaxed text-muted">
              Drag components onto a canvas, connect them, run traffic through your design and let it find your
              bottlenecks and single points of failure.
            </p>
          </Link>
        </div>
      </section>

      <section className="mx-auto mt-12 max-w-6xl px-5 lg:px-8">
        <div className="rounded-2xl border border-line bg-surface p-6">
          <h2 className="text-sm font-semibold text-ink">The learning loop this app is built around</h2>
          <ol className="mt-5 grid gap-x-6 gap-y-4 text-xs text-muted sm:grid-cols-2 lg:grid-cols-4">
            {[
              ['Start simple', 'One client, one server, one database.'],
              ['Generate traffic', 'Push the system until something gives.'],
              ['Observe the problem', 'Latency climbs, errors appear, a queue grows.'],
              ['Introduce a concept', 'Add the component that removes that specific bottleneck.'],
              ['Modify the architecture', 'Change the diagram, not just the explanation.'],
              ['Run it again', 'Same traffic, new shape.'],
              ['Observe the improvement', 'And the new bottleneck it exposed.'],
              ['Discuss trade-offs', 'Name what the fix cost you.'],
            ].map(([title, body], index) => (
              <li key={title} className="flex gap-3">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand/10 text-[11px] font-semibold tabular-nums text-brand">
                  {index + 1}
                </span>
                <div className="min-w-0">
                  <p className="font-semibold text-ink">{title}</p>
                  <p className="mt-0.5 leading-relaxed">{body}</p>
                </div>
              </li>
            ))}
          </ol>
          <p className="mt-5 text-xs text-faint">
            The goal is not only &ldquo;what is Redis?&rdquo; but &ldquo;what went wrong in our architecture that made
            introducing Redis useful?&rdquo;
          </p>
        </div>
      </section>
    </div>
  );
}

export default HomePage;
