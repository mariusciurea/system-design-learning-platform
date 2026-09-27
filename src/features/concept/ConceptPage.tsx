import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import {
  AlertTriangle,
  BookOpen,
  Calculator,
  Check,
  FlaskConical,
  HelpCircle,
  Languages,
  Lightbulb,
  Loader2,
  Minus,
  PanelRightClose,
  PanelRightOpen,
  Play,
  Plus,
  RotateCcw,
  Scale,
  Sparkles,
} from 'lucide-react';
import { ConceptHeader, AsciiBlock, ExplanationCard, QuizCard, type QuizAnswers } from '@/components/learning';
import { Badge, Button, ErrorBoundary, Expandable, Tabs, type TabItem } from '@/components/ui';
import { FlowVisual } from '@/components/architecture/FlowVisual';
import { getConcept, loadConcept, peekConcept, resolveRelated } from '@/data/concepts';
import { loadDepth } from '@/data/concepts/deep';
import { getVisual } from '@/data/visuals';
import { useProgress } from '@/app/providers/ProgressProvider';
import { useLayout } from '@/app/providers/LayoutProvider';
import { XL_QUERY, useMediaQuery } from '@/hooks/useMediaQuery';
import { getLab } from '@/features/labs/registry';
import { cn } from '@/utils/cn';
import type {
  Analogy,
  Concept,
  ConceptDepth,
  ConceptSummary,
  DeepDiveSection,
  JargonTerm,
  WorkedExample,
} from '@/types';

/** Keeps sidebar chips to one readable line instead of a paragraph. */
const short = (text: string, max = 78) => {
  const clean = text.split(' - ')[0].split('. ')[0].replace(/\.$/, '');
  if (clean.length <= max) return clean;
  // Cut at the last whole word, so a line never ends on half a word ("ser...").
  const cut = clean.slice(0, max - 3);
  const space = cut.lastIndexOf(' ');
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:(]+$/, '')}...`;
};

export function ConceptPage() {
  const { slug } = useParams();
  // The index answers "does it exist" and draws the header at once; the lesson
  // itself arrives with its category chunk.
  const summary = getConcept(slug);
  const { concept, failed, retry } = useFullConcept(summary);
  const { markVisited } = useProgress();

  useEffect(() => {
    if (summary) markVisited(summary.slug);
  }, [summary, markVisited]);

  if (!summary) {
    return (
      <div className="mx-auto max-w-2xl px-5 py-16 text-center">
        <h1 className="text-xl font-semibold text-ink">Concept not found</h1>
        <p className="mt-2 text-sm text-muted">Press Ctrl+K to search, or browse a category.</p>
        <Link to="/" className="mt-6 inline-block text-sm text-brand hover:underline">
          Back to the dashboard
        </Link>
      </div>
    );
  }

  return (
    <article>
      <ConceptHeader concept={summary} />
      {concept ? (
        <ConceptBody concept={concept} />
      ) : failed ? (
        <div className="mx-auto max-w-2xl px-5 py-12 text-center">
          <AlertTriangle className="mx-auto h-5 w-5 text-danger" aria-hidden />
          <p className="mt-2 text-sm text-ink">This concept could not be loaded.</p>
          <p className="mt-1 text-xs text-muted">
            Check your connection and try again. If it still fails, a new version was deployed while the page
            was open, and reloading fetches it.
          </p>
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            <Button variant="primary" onClick={retry}>
              <RotateCcw className="h-4 w-4" aria-hidden />
              Try again
            </Button>
            <Button onClick={() => window.location.reload()}>Reload the page</Button>
          </div>
        </div>
      ) : (
        <div role="status" className="flex h-64 items-center justify-center gap-2 text-sm text-muted">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          Loading the concept...
        </div>
      )}
    </article>
  );
}

/**
 * The full lesson for a concept from the index. A category is one chunk, so
 * the first concept opened in it fetches it and the rest render immediately
 * from memory. Retries once for the same stale-deploy reason as useConceptDepth.
 */
function useFullConcept(summary: ConceptSummary | undefined): {
  concept?: Concept;
  failed: boolean;
  retry: () => void;
} {
  const category = summary?.category;
  const slug = summary?.slug;
  const [state, setState] = useState<{ slug?: string; concept?: Concept; failed: boolean }>({ failed: false });
  // Bumped by "Try again": the same slug loads again, with no page reload (which offline would
  // replace the app with the browser's own error page).
  const [attempt, setAttempt] = useState(0);
  const retry = () => {
    setState({ failed: false });
    setAttempt((value) => value + 1);
  };
  const cached = category && slug ? peekConcept(category, slug) : undefined;

  useEffect(() => {
    if (!category || !slug || peekConcept(category, slug)) return;
    let current = true;
    const load = () => loadConcept(category, slug);

    load()
      .catch(() => new Promise((resolve) => setTimeout(resolve, 400)).then(load))
      .then((concept) => {
        if (current) setState({ slug, concept, failed: !concept });
      })
      .catch(() => {
        if (current) setState({ slug, failed: true });
      });

    return () => {
      current = false;
    };
  }, [category, slug, attempt]);

  if (cached) return { concept: cached, failed: false, retry };
  // Ignore a result that belongs to the previous slug.
  return state.slug === slug ? { ...state, retry } : { failed: false, retry };
}

/** Links the fold button and the reopen tab to the column they control. */
const ASIDE_ID = 'concept-notes';
/** Links "Read the full explanation" to the part of the Lesson it unfolds. */
const LESSON_ID = 'concept-lesson';
/** One empty object, so a Concept with no answers yet does not rebuild its tabs on every render. */
const NO_ANSWERS: QuizAnswers = {};

function ConceptBody({ concept }: { concept: Concept }) {
  const related = useMemo(() => resolveRelated(concept), [concept]);
  // The notes column sits beside the content only from xl up; below that it
  // stacks under the content and cannot be folded, whatever was saved.
  const isWide = useMediaQuery(XL_QUERY);
  const { asideFolded: savedFolded, setFolded } = useLayout();
  // The open tab lives in the URL (?tab=quiz), so a refresh keeps it and a link can open the Quiz.
  // It replaces the history entry: Back leaves the Concept instead of stepping through its tabs.
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = searchParams.get('tab') ?? '';
  const tabsTop = useRef<HTMLDivElement>(null);
  // A lab has its own control column, so the notes step aside while its tab is
  // open. Reopening them there lasts until the learner leaves the tab and never
  // touches the saved choice.
  const [notesInLab, setNotesInLab] = useState(false);
  // The control that was clicked disappears with the fold, so hand focus to
  // the one that replaces it instead of dropping it on the page body.
  const hideButton = useRef<HTMLButtonElement>(null);
  const showTab = useRef<HTMLButtonElement>(null);
  const moveFocus = useRef(false);
  // Fade the column in only when the learner reopens it, not on every page load.
  const reopened = useRef(false);
  const lab = concept.lab ? getLab(concept.lab) : undefined;
  const visual = getVisual(concept.slug);
  // The tab panel remounts on every tab switch, so the Lesson's open state lives
  // here. It lasts while the learner stays on this concept; any other concept,
  // including coming back to this one, starts folded again.
  const [lessonExpanded, setLessonExpanded] = useState(false);
  const [lessonSlug, setLessonSlug] = useState(concept.slug);
  if (lessonSlug !== concept.slug) {
    setLessonSlug(concept.slug);
    setLessonExpanded(false);
  }
  const toggleLesson = useCallback(() => setLessonExpanded((open) => !open), []);
  // The Quiz answers live here for the same reason: a Learner who leaves to watch the Diagram
  // again comes back to the Quiz as they left it.
  const [quizAnswers, setQuizAnswers] = useState<{ slug: string; answers: QuizAnswers }>({
    slug: concept.slug,
    answers: {},
  });
  const answers = quizAnswers.slug === concept.slug ? quizAnswers.answers : NO_ANSWERS;
  const changeAnswers = useCallback(
    (next: QuizAnswers) => setQuizAnswers({ slug: concept.slug, answers: next }),
    [concept.slug],
  );

  // The Lesson sits on the Diagram tab, where the notes show unless the Learner folded them.
  const notesShown = !(isWide && savedFolded);
  const selectTab = useCallback(
    (id: string) => {
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current);
          // The Diagram is where a Concept opens, so it needs no parameter.
          if (id === 'diagram') next.delete('tab');
          else next.set('tab', id);
          return next;
        },
        { replace: true },
      );
      if (id !== 'lab') setNotesInLab(false);
    },
    [setSearchParams],
  );
  // From the Quiz result back to the material: open that tab and bring its top into view.
  const reviewTab = useCallback(
    (id: string) => {
      selectTab(id);
      requestAnimationFrame(() => tabsTop.current?.scrollIntoView({ block: 'start' }));
    },
    [selectTab],
  );

  const tabs = useMemo<TabItem[]>(() => {
    const items: TabItem[] = [];

    items.push({
      id: 'diagram',
      label: 'Diagram',
      icon: <Play className="h-3.5 w-3.5" />,
      content: (
        <div className="space-y-5">
          {/* Keyed by slug so another concept starts on Live, with none of this one's traffic. */}
          {visual ? <FlowVisual key={concept.slug} spec={visual} walkthrough /> : null}
          <Lesson concept={concept} expanded={lessonExpanded} onToggle={toggleLesson} notesShown={notesShown} />
        </div>
      ),
    });

    if (lab) {
      items.push({
        id: 'lab',
        label: 'Interactive lab',
        shortLabel: 'Lab',
        icon: <FlaskConical className="h-3.5 w-3.5" />,
        content: (
          <ErrorBoundary area={lab.title}>
            <Suspense
              fallback={
                <div role="status" className="flex h-64 items-center justify-center gap-2 text-sm text-muted">
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                  Loading the lab...
                </div>
              }
            >
              {/* Keyed by slug: two Concepts sharing this Lab each start on their own focus. */}
              <lab.Component key={concept.slug} focus={concept.labFocus} />
            </Suspense>
          </ErrorBoundary>
        ),
      });
    }

    if (concept.tradeoffs?.length) {
      items.push({
        id: 'tradeoffs',
        label: 'Trade-offs',
        icon: <Scale className="h-3.5 w-3.5" />,
        content: <TradeOffBoard concept={concept} />,
      });
    }

    if (concept.quiz?.length) {
      items.push({
        id: 'quiz',
        label: 'Quiz',
        icon: <HelpCircle className="h-3.5 w-3.5" />,
        content: (
          <QuizCard
            questions={concept.quiz}
            slug={concept.slug}
            answers={answers}
            onAnswersChange={changeAnswers}
            review={[
              ...(visual ? [{ id: 'diagram', label: 'Watch the Diagram again' }] : []),
              ...(lab ? [{ id: 'lab', label: 'Try it in the Lab' }] : []),
            ]}
            onReview={reviewTab}
          />
        ),
      });
    }

    return items;
  }, [concept, lab, visual, lessonExpanded, toggleLesson, notesShown, answers, changeAnswers, reviewTab]);

  const activeTab = tabs.some((item) => item.id === tab) ? tab : (tabs[0]?.id ?? '');
  const inLab = activeTab === 'lab';
  // The Quiz stands alone: the notes beside it would show the answers it asks for.
  const inQuiz = activeTab === 'quiz';
  const asideFolded = isWide && !inQuiz && (inLab ? !notesInLab : savedFolded);
  const foldAside = (folded: boolean) => {
    moveFocus.current = true;
    reopened.current = !folded;
    if (inLab) setNotesInLab(!folded);
    else setFolded('asideFolded', folded);
  };
  useEffect(() => {
    if (!moveFocus.current) return;
    moveFocus.current = false;
    (asideFolded ? showTab : hideButton).current?.focus();
  }, [asideFolded]);

  const when = concept.when ?? [];
  // With several approaches, the first one is an option (Sticky sessions, Round
  // robin), not the concept itself - so its gains and costs are labelled with its
  // name instead of reading as the gains and costs of the whole concept.
  const firstTradeoff = concept.tradeoffs?.[0];
  const option = (concept.tradeoffs?.length ?? 0) > 1 ? firstTradeoff?.approach : undefined;
  const costs = firstTradeoff?.costs ?? [];
  // The option name sits on its own line under the label, in its own case: the uppercase label
  // would turn "60s" into "60S".
  const gains = concept.advantages ?? firstTradeoff?.gains ?? [];
  const gainsOption = concept.advantages ? undefined : option;
  // The Trade-offs tab is these same gains and costs in full, so the notes do not repeat them there.
  const inTradeoffs = activeTab === 'tradeoffs';
  const oneLine = concept.what ? short(concept.what, 150) : '';

  return (
    <div className="px-5 py-5 lg:px-8">
      <div
        className={cn(
          'mx-auto grid max-w-[1600px] gap-4',
          asideFolded ? 'xl:grid-cols-[minmax(0,1fr)_auto]' : 'xl:grid-cols-[minmax(0,1fr)_320px]',
        )}
      >
        {/* Diagram first - it is the content, not an illustration */}
        <div ref={tabsTop} className={cn('min-w-0 scroll-mt-4', inQuiz && 'xl:col-span-2')}>
          <Tabs items={tabs} value={activeTab} onChange={selectTab} />
        </div>

        {/* Short notes only. Anything longer lives in the Lesson under the Diagram. */}
        <aside
          id={ASIDE_ID}
          aria-label="Notes"
          className={cn(
            // Stacked under the content below xl, it keeps a reading width instead of the full row.
            'max-w-[38rem] space-y-3 xl:sticky xl:top-[4.5rem] xl:max-w-none xl:self-start',
            reopened.current && 'xl:animate-fade-in',
            (asideFolded || inQuiz) && 'hidden',
          )}
        >
          {isWide && !inQuiz ? (
            <div className="flex justify-end">
              <Button
                size="sm"
                variant="ghost"
                ref={hideButton}
                onClick={() => foldAside(true)}
                aria-controls={ASIDE_ID}
                aria-expanded
              >
                <PanelRightClose className="h-3.5 w-3.5" />
                Hide notes
              </Button>
            </div>
          ) : null}

          {concept.what ? (
            <section className="card p-4">
              <h2 className="label mb-1.5">In one line</h2>
              <p className="text-sm leading-relaxed text-ink">
                {oneLine.endsWith('...') ? oneLine : `${oneLine}.`}
              </p>
            </section>
          ) : null}

          {when.length ? (
            <section className="card p-4">
              <h2 className="label mb-2 text-brand">Use it when</h2>
              <ul className="space-y-1.5">
                {when.slice(0, 3).map((item) => (
                  <li key={item} className="flex gap-2 text-xs leading-relaxed text-muted">
                    <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand" aria-hidden />
                    {short(item, 90)}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {/* Gains and costs in the same colors and marks as the Trade-offs tab beside them. */}
          {costs.length && !inTradeoffs ? (
            <section className="card p-4">
              <h2 className="label text-danger">What it costs</h2>
              {option ? <p className="mt-1 text-xs font-medium text-ink">{option}</p> : null}
              <ul className="mt-2 space-y-1.5">
                {costs.slice(0, 3).map((item) => (
                  <li key={item} className="flex gap-2 text-xs leading-relaxed text-muted">
                    <Minus className="mt-0.5 h-3.5 w-3.5 shrink-0 text-danger" aria-hidden />
                    {short(item, 90)}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {gains.length && !inTradeoffs ? (
            <section className="card p-4">
              <h2 className="label text-ok">What you gain</h2>
              {gainsOption ? <p className="mt-1 text-xs font-medium text-ink">{gainsOption}</p> : null}
              <ul className="mt-2 space-y-1.5">
                {gains.slice(0, 3).map((item) => (
                  <li key={item} className="flex gap-2 text-xs leading-relaxed text-muted">
                    <Plus className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ok" aria-hidden />
                    {short(item, 90)}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {/* Related, not "Next": Concepts have no set order. */}
          {related.length ? (
            <section className="card p-4">
              <h2 className="label mb-2">Related</h2>
              <ul className="flex flex-wrap gap-1.5">
                {related.map((item) => (
                  <li key={item.slug}>
                    <Link
                      to={`/concepts/${item.slug}`}
                      className="inline-flex items-center rounded-full border border-line px-2.5 py-1 text-[11px] text-muted transition-colors hover:border-brand hover:text-brand"
                    >
                      {item.title}
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </aside>

        {/* Its own narrow grid column, so the reopen tab never covers the content (a lab's controls, say). */}
        {asideFolded ? (
          <button
            type="button"
            ref={showTab}
            onClick={() => foldAside(false)}
            aria-controls={ASIDE_ID}
            aria-expanded={false}
            className="sticky top-[4.5rem] flex animate-fade-in flex-col items-center gap-2 self-start rounded-lg border border-line bg-surface px-1.5 py-3 text-xs font-medium text-muted shadow-card transition-colors hover:bg-elevated hover:text-ink"
          >
            <PanelRightOpen className="h-3.5 w-3.5" />
            <span className="[writing-mode:vertical-rl]">Show notes</span>
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** Gains and costs as two short lists per approach, then the mistakes people make with it. */
function TradeOffBoard({ concept }: { concept: Concept }) {
  return (
    <div className="space-y-3">
      {(concept.tradeoffs ?? []).map((tradeoff) => (
        <section key={tradeoff.approach} className="overflow-hidden rounded-2xl border border-line bg-surface">
          <h2 className="border-b border-line bg-elevated px-4 py-2.5 text-sm font-semibold text-ink">
            {tradeoff.approach}
          </h2>
          <div className="grid gap-px bg-line sm:grid-cols-2">
            {(
              [
                ['What you gain', tradeoff.gains, 'ok', Plus],
                ['What it costs', tradeoff.costs, 'danger', Minus],
              ] as const
            ).map(([label, list, tone, Icon]) => (
              <div key={label} className="bg-surface p-4">
                <h3 className={cn('label mb-2', tone === 'ok' ? 'text-ok' : 'text-danger')}>{label}</h3>
                <ul className="space-y-2">
                  {list.map((item) => (
                    <li key={item} className="flex gap-2 text-sm leading-relaxed text-muted">
                      <Icon
                        className={cn('mt-1 h-3.5 w-3.5 shrink-0', tone === 'ok' ? 'text-ok' : 'text-danger')}
                        aria-hidden
                      />
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>
      ))}

      {concept.mistakes?.length ? (
        <section className="rounded-2xl border border-warn/30 bg-warn/5 p-4">
          <h2 className="label mb-2 flex items-center gap-1.5 text-warn">
            <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
            Common mistakes
          </h2>
          <ul className="max-w-[36rem] space-y-2">
            {concept.mistakes.map((item) => (
              <li key={item} className="flex gap-2.5 text-sm leading-relaxed text-muted">
                <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-warn" aria-hidden />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <p className="max-w-[31rem] px-1 text-xs text-muted">
        Every gain here comes with a cost. Which one matters more depends on your requirements.
      </p>
    </div>
  );
}

/**
 * The long-form lesson, under the Diagram. Only the Analogy shows at first - the
 * picture the learner already has in their head. Unfolded, it starts with what to
 * carry away and a worked example with real numbers; each longer section then
 * waits behind its own title, so the unfold never lands as one wall of text.
 */
function Lesson({
  concept,
  expanded,
  onToggle,
  notesShown,
}: {
  concept: Concept;
  expanded: boolean;
  onToggle: () => void;
  /** The notes column already says "In one line"; the Lesson repeats the definition only when it says more. */
  notesShown: boolean;
}) {
  const { depth, failed, retry } = useConceptDepth(concept);
  const toggle = useRef<HTMLButtonElement>(null);
  const trim = (text: string) => text.replace(/(\.|\.\.\.)$/, '');
  const what =
    concept.what && (!notesShown || trim(short(concept.what, 150)) !== trim(concept.what)) ? concept.what : undefined;
  // The Trade-offs tab lists the mistakes; the Lesson keeps them only when there is no such tab.
  const mistakes = concept.tradeoffs?.length ? [] : (concept.mistakes ?? []);

  // Folding from the end of a long Lesson brings the reader back to where it opened.
  const hide = () => {
    onToggle();
    requestAnimationFrame(() => {
      toggle.current?.scrollIntoView({ block: 'nearest' });
      toggle.current?.focus({ preventScroll: true });
    });
  };

  return (
    <div className="max-w-[38rem] space-y-3">
      {depth ? <AnalogyCard analogy={depth.analogy} /> : null}
      {!depth && !failed ? (
        <div role="status" className="flex items-center gap-2 rounded-2xl border border-line bg-surface p-5 text-sm text-muted">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          Loading the lesson...
        </div>
      ) : null}
      {failed ? (
        <div className="flex flex-wrap items-start gap-3 rounded-2xl border border-warn/30 bg-warn/5 p-5 text-sm text-muted">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warn" aria-hidden />
          <span className="min-w-0 flex-1">
            The lesson could not be loaded. Check your connection, then try again.
          </span>
          <Button size="sm" onClick={retry}>
            <RotateCcw className="h-3.5 w-3.5" aria-hidden />
            Try again
          </Button>
        </div>
      ) : null}

      <Button
        ref={toggle}
        variant="secondary"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-controls={expanded ? LESSON_ID : undefined}
      >
        <BookOpen className="h-3.5 w-3.5" aria-hidden />
        {expanded ? 'Hide the full explanation' : 'Read the full explanation'}
      </Button>

      {expanded ? (
        <div id={LESSON_ID} className="space-y-3 animate-fade-in">
          {depth ? <RememberCard lines={depth.remember} /> : null}

          {depth?.examples.map((example) => <ExampleCard key={example.title} example={example} />)}

          {what ? (
            <ExplanationCard title="What is it?" tone="brand">
              {what}
            </ExplanationCard>
          ) : null}
          {concept.why ? <ExplanationCard title="Why does it exist?">{concept.why}</ExplanationCard> : null}

          {depth?.deepDive.map((section) => (
            <Expandable key={section.heading} title={section.heading}>
              <DeepDiveBody section={section} />
            </Expandable>
          ))}

          {concept.how?.length ? (
            <Expandable title="How it works, step by step">
              <ol className="space-y-2">
                {concept.how.map((step, index) => (
                  <li key={step} className="flex gap-2.5">
                    <span className="font-mono text-[11px] text-faint">{index + 1}</span>
                    <span>{step}</span>
                  </li>
                ))}
              </ol>
            </Expandable>
          ) : null}
          {concept.diagram ? (
            <Expandable title="Plain-text sketch" hint="ASCII">
              <AsciiBlock>{concept.diagram}</AsciiBlock>
            </Expandable>
          ) : null}
          {concept.when?.length ? (
            <Expandable title="When to use it">
              <ul className="space-y-1.5">
                {concept.when.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </Expandable>
          ) : null}
          {concept.realWorld?.length ? (
            <Expandable title="In production">
              <ul className="space-y-1.5">
                {concept.realWorld.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </Expandable>
          ) : null}
          {mistakes.length ? (
            <Expandable title="Common mistakes">
              <ul className="space-y-1.5">
                {mistakes.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </Expandable>
          ) : null}

          {depth ? <JargonCard terms={depth.jargon} /> : null}

          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Badge>{concept.difficulty}</Badge>
            {(concept.keywords ?? []).slice(0, 6).map((keyword) => (
              <Badge key={keyword}>{keyword}</Badge>
            ))}
          </div>

          <Button variant="ghost" onClick={hide} aria-controls={LESSON_ID} aria-expanded>
            <BookOpen className="h-3.5 w-3.5" aria-hidden />
            Hide the full explanation
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Fetches the long-form content for this concept. It is a separate chunk per
 * category, so nothing of it is in the main bundle; the first concept opened in
 * a category fetches it, and the rest of that category reads it from memory.
 *
 * The retry is the same problem `lazyWithRetry` solves: after a redeploy the
 * open document points at a chunk that no longer exists. Here that must not
 * take the page down, so a second failure degrades to the short explanation
 * plus a note, rather than an endless spinner.
 */
function useConceptDepth(concept: Concept): { depth?: ConceptDepth; failed: boolean; retry: () => void } {
  const [state, setState] = useState<{ slug?: string; depth?: ConceptDepth; failed: boolean }>({ failed: false });
  const [attempt, setAttempt] = useState(0);
  const retry = () => {
    setState({ failed: false });
    setAttempt((value) => value + 1);
  };

  useEffect(() => {
    let current = true;
    const slug = concept.slug;
    const load = () => loadDepth(concept.category, slug);

    load()
      .catch(() => new Promise((resolve) => setTimeout(resolve, 400)).then(load))
      .then((depth) => {
        if (current) setState({ slug, depth, failed: !depth });
      })
      .catch(() => {
        if (current) setState({ slug, failed: true });
      });

    return () => {
      current = false;
    };
  }, [concept.category, concept.slug, attempt]);

  // A result for the previous concept reads as "still loading" for this one.
  return state.slug === concept.slug ? { ...state, retry } : { failed: false, retry };
}

/** The picture the learner already has in their head, borrowed for the concept. */
function AnalogyCard({ analogy }: { analogy: Analogy }) {
  return (
    <section className="flex gap-3 rounded-2xl border border-violet/30 bg-violet/5 p-5">
      <Lightbulb className="mt-0.5 h-4 w-4 shrink-0 text-violet" aria-hidden />
      <div className="min-w-0">
        <p className="label text-violet">Think of it like</p>
        <h2 className="mt-1 text-sm font-semibold text-ink">{analogy.title}</h2>
        <p className="mt-1.5 text-sm leading-relaxed text-muted">{analogy.body}</p>
      </div>
    </section>
  );
}

/** One long-form teaching section inside its Expandable: prose, optional bullets, optional snippet. */
function DeepDiveBody({ section }: { section: DeepDiveSection }) {
  return (
    <>
      <div className="space-y-2.5">
        {section.paragraphs.map((paragraph) => (
          <p key={paragraph}>{paragraph}</p>
        ))}
      </div>
      {section.bullets?.length ? (
        <ul className="mt-3 space-y-2">
          {section.bullets.map((item) => (
            <li key={item} className="flex gap-2.5">
              <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-faint" aria-hidden />
              <span>{item}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {section.code ? (
        <div className="mt-3">
          {section.code.caption ? (
            <p className="mb-1.5 text-[11px] text-faint">{section.code.caption}</p>
          ) : null}
          <AsciiBlock>{section.code.body}</AsciiBlock>
        </div>
      ) : null}
    </>
  );
}

/** Numbers make an abstract idea concrete, and concrete ideas are remembered. */
function ExampleCard({ example }: { example: WorkedExample }) {
  return (
    <section className="rounded-2xl border border-info/30 bg-info/5 p-5">
      <p className="label flex items-center gap-1.5 text-info">
        <Calculator className="h-3.5 w-3.5" aria-hidden />
        Worked example
      </p>
      <h2 className="mt-1 text-sm font-semibold text-ink">{example.title}</h2>
      <p className="mt-1.5 text-sm leading-relaxed text-muted">{example.setup}</p>
      <ol className="mt-3 space-y-2">
        {example.walkthrough.map((step, index) => (
          <li key={step} className="flex gap-2.5 text-sm leading-relaxed text-muted">
            <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-info/40 font-mono text-[11px] text-info">
              {index + 1}
            </span>
            <span>{step}</span>
          </li>
        ))}
      </ol>
      <p className="mt-3 border-t border-info/20 pt-3 text-sm leading-relaxed text-ink">{example.result}</p>
    </section>
  );
}

/** The words seniors say without explaining them. */
function JargonCard({ terms }: { terms: JargonTerm[] }) {
  return (
    <section className="rounded-2xl border border-line bg-surface p-5">
      <h2 className="label flex items-center gap-1.5">
        <Languages className="h-3.5 w-3.5" aria-hidden />
        Jargon decoder
      </h2>
      <dl className="mt-3 space-y-2.5">
        {terms.map((term) => (
          <div key={term.term} className="grid gap-1 sm:grid-cols-[minmax(0,180px)_minmax(0,1fr)] sm:gap-3">
            <dt className="text-sm font-medium text-ink">{term.term}</dt>
            <dd className="text-sm leading-relaxed text-muted">{term.plain}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** The few lines worth carrying out of the page. */
function RememberCard({ lines }: { lines: string[] }) {
  return (
    <section className="rounded-2xl border border-brand/30 bg-brand/5 p-5">
      <h2 className="label flex items-center gap-1.5 text-brand">
        <Sparkles className="h-3.5 w-3.5" aria-hidden />
        Remember this
      </h2>
      <ul className="mt-3 space-y-2">
        {lines.map((line) => (
          <li key={line} className="flex gap-2.5 text-sm leading-relaxed text-ink">
            <Check className="mt-0.5 h-4 w-4 shrink-0 text-brand" aria-hidden />
            <span>{line}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export default ConceptPage;
