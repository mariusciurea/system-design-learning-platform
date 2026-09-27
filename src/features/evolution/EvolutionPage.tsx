import { useCallback, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, ArrowRight, Check, ChevronLeft, ChevronRight, Sparkles } from 'lucide-react';
import { ArchNode, DiagramCanvas, ParticleLegend, type ParticleView } from '@/components/architecture';
import type { FitRange } from '@/hooks/useFitScale';
import { PlayPauseButton, useAutoplay } from '@/components/architecture/FlowVisual';
import { Badge, Button, Stat } from '@/components/ui';
import { advanceParticles, nextParticleId, useTicker, type Particle } from '@/simulations/engine';
import { useRerender } from '@/hooks/useRerender';
import { cn } from '@/utils/cn';
import { STAGES, stageLayout } from './stages';

const DESIGN_WIDTH = 960;
const DESIGN_HEIGHT = 540;

/**
 * The stage never shrinks below 0.6x: the evolution stages carry more text per
 * node than a concept diagram, and below that it stops being readable. Past the
 * floor the canvas scrolls inside its card instead.
 */
const EVOLUTION_FIT: FitRange = { min: 0.6, max: 1 };

export function EvolutionPage() {
  const [index, setIndex] = useState(0);
  const [answered, setAnswered] = useState<number | null>(null);
  const particles = useRef<Particle[]>([]);
  const rerender = useRerender(30);

  const stage = STAGES[index];
  const layout = stageLayout(stage);
  // Same promise as every other animated diagram: starts paused under reduced
  // motion, has an explicit Pause/Play, and stops ticking while off screen.
  const autoplay = useAutoplay<HTMLDivElement>();

  const go = useCallback((next: number) => {
    setIndex(next);
    setAnswered(null);
    particles.current = [];
  }, []);

  // Send a trickle of requests along the current stage's edges so every
  // architecture is shown working, not just drawn. A hot standby carries no
  // traffic until the active node fails, so its edges (in and out) stay quiet. Only reads
  // from the cache are drawn as cache hits; queue and event traffic is normal
  // work, not a warning or a retry.
  useTicker(autoplay.running, (dt) => {
    const busy = stage.edges.filter(
      (edge) => !stage.nodes.some((node) => node.standby && (node.id === edge.to || node.id === edge.from)),
    );
    if (Math.random() < dt * 6 && busy.length > 0) {
      const edge = busy[Math.floor(Math.random() * busy.length)];
      const toCache = stage.nodes.some((node) => node.id === edge.to && node.kind === 'cache');
      particles.current.push({
        id: nextParticleId(),
        route: [edge.from, edge.to],
        leg: 0,
        t: 0,
        speed: 0.9 + Math.random() * 0.4,
        outcome: toCache ? 'cache-hit' : 'success',
      });
    }
    const { alive } = advanceParticles(particles.current, dt);
    particles.current = alive.slice(-40);
    rerender();
  });

  const particleViews: ParticleView[] = particles.current
    .filter((particle) => layout[particle.route[0]] && layout[particle.route[1]])
    .map((particle) => ({
      id: particle.id,
      from: particle.route[particle.leg],
      to: particle.route[particle.leg + 1],
      t: particle.t,
      outcome: particle.outcome ?? 'success',
    }));

  const chosen = answered !== null ? stage.options[answered] : null;
  const canAdvance = chosen?.recommended === true;

  return (
    <div className="px-5 py-8 lg:px-8">
      <div className="mx-auto max-w-6xl min-[1700px]:max-w-[1340px]">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">System Evolution</h1>
          <p className="mt-1.5 max-w-3xl text-sm text-muted">
            One system, eight stages. Each component appears because the previous architecture failed in a specific,
            observable way - and each one brings a new cost. That is the whole discipline in one page.
          </p>
        </header>

        {/* Stage rail. Eight 44px touch targets do not fit one phone row, so
            below sm they sit in two even rows of four instead of wrapping 6 + 2. */}
        <ol className="mt-6 grid grid-cols-4 gap-1.5 sm:flex sm:flex-wrap">
          {STAGES.map((item, position) => (
            <li key={item.id}>
              <button
                type="button"
                onClick={() => go(position)}
                // The titles already start with "Stage N - ".
                aria-label={item.title}
                title={item.title}
                aria-current={position === index ? 'step' : undefined}
                className={cn(
                  'w-full rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors sm:w-auto',
                  position === index
                    ? 'border-brand bg-brand/10 text-brand'
                    : 'border-line text-muted hover:border-brand/40 hover:text-ink',
                )}
              >
                {position + 1}
              </button>
            </li>
          ))}
        </ol>

        {/* The question column sits beside the diagram from 1280px, where most
            laptops are. It is 300px wide there so the diagram column keeps about
            610px with the sidebar open - 0.63x, above the 0.6x floor, so the
            stage still fits its card without scrolling. From 1700px the page is
            wide enough for a 360px column and the diagram at its full 960px. */}
        <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_300px] min-[1700px]:grid-cols-[minmax(0,1fr)_360px]">
          <div className="space-y-4">
            <div ref={autoplay.ref} className="card overflow-hidden">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3">
                <h2 className="text-sm font-semibold text-ink">{stage.title}</h2>
                <div className="flex flex-wrap gap-2">
                  {stage.metrics.map((metric) => (
                    <span
                      key={metric.label}
                      className={cn(
                        'rounded-lg border px-2.5 py-1 font-mono text-[11px]',
                        metric.tone === 'danger'
                          ? 'border-danger/30 bg-danger/5 text-danger'
                          : metric.tone === 'warn'
                            ? 'border-warn/30 bg-warn/5 text-warn'
                            : metric.tone === 'ok'
                              ? 'border-ok/30 bg-ok/5 text-ok'
                              : 'border-line text-muted',
                      )}
                    >
                      {metric.label}: {metric.value}
                    </span>
                  ))}
                </div>
              </div>

              {/* Below 0.6x the labels get unreadable, so a phone scrolls sideways instead. */}
              <DiagramCanvas
                layout={layout}
                edges={stage.edges}
                particles={particleViews}
                width={DESIGN_WIDTH}
                height={DESIGN_HEIGHT}
                className="bg-canvas"
                fit={EVOLUTION_FIT}
              >
                {stage.nodes.map((node) => (
                  <ArchNode
                    key={node.id}
                    kind={node.kind}
                    title={node.title}
                    subtitle={node.subtitle}
                    placed={node.placed}
                    compact
                    selected={node.isNew}
                    badge={node.isNew ? <Badge tone="brand">new</Badge> : undefined}
                  />
                ))}
              </DiagramCanvas>

              <div className="flex items-center gap-3 border-t border-line px-5 py-2.5">
                <ParticleLegend outcomes={['success', 'cache-hit']} />
                <PlayPauseButton
                  playing={autoplay.playing}
                  onToggle={() => autoplay.setPlaying((value) => !value)}
                  className="ml-auto shrink-0"
                />
              </div>
            </div>

            {/* On a phone the buttons say "Previous" / "Next" (the word "stage"
                is still read out), so the row fits 375px on one line. */}
            <div className="flex items-center justify-between gap-2">
              <Button variant="secondary" disabled={index === 0} onClick={() => go(index - 1)} className="shrink-0">
                <ChevronLeft className="h-4 w-4" />
                <span>
                  Previous<span className="sr-only sm:not-sr-only"> stage</span>
                </span>
              </Button>
              <span className="whitespace-nowrap text-xs text-faint">
                Stage {index + 1} of {STAGES.length}
              </span>
              <Button
                variant={canAdvance ? 'primary' : 'secondary'}
                disabled={index === STAGES.length - 1}
                onClick={() => go(index + 1)}
                className="shrink-0"
              >
                <span>
                  Next<span className="sr-only sm:not-sr-only"> stage</span>
                </span>
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>

          {/* Right column */}
          <div className="space-y-4">
            {stage.introduced ? (
              <div className="card p-4">
                <p className="label mb-2 flex items-center gap-1.5 text-brand">
                  <Sparkles className="h-3.5 w-3.5" />
                  Introduced here
                </p>
                <p className="text-sm font-semibold text-ink">{stage.introduced.component}</p>
                <div className="mt-3 space-y-2 text-xs leading-relaxed">
                  <p>
                    <span className="font-semibold text-ok">Because: </span>
                    <span className="text-muted">{stage.introduced.because}</span>
                  </p>
                  <p>
                    <span className="font-semibold text-danger">It costs: </span>
                    <span className="text-muted">{stage.introduced.cost}</span>
                  </p>
                </div>
                <Link
                  to={`/concepts/${stage.introduced.concept}`}
                  className="mt-3 inline-flex items-center gap-1 text-xs text-brand hover:underline"
                >
                  Learn this concept <ArrowRight className="h-3 w-3" />
                </Link>
              </div>
            ) : null}

            <div className="card p-4">
              <p className="label mb-2 flex items-center gap-1.5 text-warn">
                <AlertTriangle className="h-3.5 w-3.5" />
                The problem
              </p>
              <p className="text-sm leading-relaxed text-muted">{stage.problem}</p>
            </div>

            <div className="card p-4">
              <p className="label mb-2">What would you do?</p>
              <p className="text-sm leading-relaxed text-ink">{stage.question}</p>
              <div className="mt-3 space-y-2">
                {stage.options.map((option, position) => {
                  const isChosen = answered === position;
                  return (
                    <button
                      key={option.label}
                      type="button"
                      aria-pressed={isChosen}
                      onClick={() => setAnswered(position)}
                      className={cn(
                        'w-full rounded-xl border px-3.5 py-2.5 text-left text-xs transition-colors',
                        isChosen && option.recommended
                          ? 'border-ok bg-ok/10 text-ink'
                          : isChosen
                            ? 'border-warn bg-warn/10 text-ink'
                            : 'border-line text-muted hover:border-brand/50 hover:text-ink',
                      )}
                    >
                      <span className="flex items-start gap-2">
                        {isChosen && option.recommended ? <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ok" /> : null}
                        {option.label}
                      </span>
                    </button>
                  );
                })}
              </div>

              {/* Always rendered, so a screen reader hears the feedback when an option is picked. */}
              <div aria-live="polite">
                {chosen ? (
                  <p
                    className={cn(
                      'mt-3 rounded-xl border p-3 text-xs leading-relaxed',
                      chosen.recommended ? 'border-ok/30 bg-ok/5 text-muted' : 'border-warn/30 bg-warn/5 text-muted',
                    )}
                  >
                    {chosen.feedback}
                  </p>
                ) : null}
              </div>
            </div>

            <div className="card p-4">
              <p className="label mb-3">Why this works as a method</p>
              <div className="grid grid-cols-2 gap-2">
                <Stat label="Stages" value={STAGES.length} size="sm" />
                <Stat label="Current" value={index + 1} size="sm" tone="brand" />
              </div>
              <p className="mt-3 text-xs leading-relaxed text-muted">
                Nothing here was added because it is modern. Each component removed one measured bottleneck and
                introduced a named cost. If you cannot say which problem a component solves, it does not belong in the
                diagram.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default EvolutionPage;
