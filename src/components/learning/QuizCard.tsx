import { useId, useRef, type CSSProperties } from 'react';
import { ArrowRight, Check, PartyPopper, RotateCcw, Target, X } from 'lucide-react';
import { cn } from '@/utils/cn';
import type { QuizQuestion } from '@/types';
import { Button } from '@/components/ui';
import { useProgress } from '@/app/providers/ProgressProvider';
import { passMark } from '@/app/providers/progressState';

/** The option picked for each question, by question id. */
export type QuizAnswers = Record<string, number>;

interface QuizCardProps {
  questions: QuizQuestion[];
  /** Concept slug the score is recorded against. */
  slug: string;
  /**
   * Held by the page, not here: the tab panel remounts on every tab switch, and a Learner who
   * leaves to watch the Diagram again must come back to the Quiz as they left it.
   */
  answers: QuizAnswers;
  onAnswersChange: (answers: QuizAnswers) => void;
  /** Where a Learner who did not pass can go back to study (the Diagram, the Lab). */
  review?: { id: string; label: string }[];
  onReview?: (id: string) => void;
}

/**
 * Scenario-based quiz. Each answer is revealed with its explanation the moment it is picked,
 * because the explanation is the teaching, not the score. The score is recorded once every
 * question has an answer, and the result card at the end lists what was missed.
 */
export function QuizCard({ questions, slug, answers, onAnswersChange, review = [], onReview }: QuizCardProps) {
  const { recordQuiz, quiz } = useProgress();
  const baseId = useId();
  const resultRef = useRef<HTMLElement>(null);

  const total = questions.length;
  const need = passMark(total);
  const isAnswered = (question: QuizQuestion) => answers[question.id] !== undefined;
  const isRight = (question: QuizQuestion) => answers[question.id] === question.answer;
  const answeredCount = questions.filter(isAnswered).length;
  const correctCount = questions.filter(isRight).length;
  const finished = total > 0 && answeredCount === total;
  const passed = finished && correctCount >= need;
  const missed = finished ? questions.filter((question) => !isRight(question)) : [];
  const best = quiz[slug];

  const questionId = (question: QuizQuestion) => `${baseId}-q-${question.id}`;
  const scrollBehavior = (): ScrollBehavior =>
    window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';

  const goTo = (element: HTMLElement | null) => {
    element?.scrollIntoView({ block: 'start', behavior: scrollBehavior() });
    element?.focus({ preventScroll: true });
  };

  const choose = (question: QuizQuestion, option: number) => {
    if (isAnswered(question)) return;
    const next = { ...answers, [question.id]: option };
    onAnswersChange(next);
    if (questions.every((item) => next[item.id] !== undefined)) {
      recordQuiz(slug, questions.filter((item) => next[item.id] === item.answer).length, total);
    }
  };

  // The right answers stay: only the missed questions open again.
  const retryMissed = () => {
    const kept: QuizAnswers = {};
    for (const question of questions) if (isRight(question)) kept[question.id] = question.answer;
    onAnswersChange(kept);
    const first = missed[0];
    if (first) requestAnimationFrame(() => goTo(document.getElementById(questionId(first))));
  };

  const startOver = () => {
    onAnswersChange({});
    const first = questions[0];
    if (first) requestAnimationFrame(() => goTo(document.getElementById(questionId(first))));
  };

  return (
    <div className="max-w-[38rem] space-y-4">
      <p className="max-w-[36rem] text-sm text-muted">
        Pick an answer to see at once why it is right or wrong. {need} of {total} right answers pass and make this
        Concept Done.
        {best ? (
          <span className="text-faint">
            {' '}
            Your best score: {best.correct}/{best.total}.
          </span>
        ) : null}
      </p>

      {/* Stays in view while the Learner works down the list, so the result is never lost below the fold. */}
      <div className="sticky top-0 z-10 -mx-1 flex min-h-11 items-center gap-3 rounded-xl border border-line bg-surface/95 px-3 py-2 backdrop-blur">
        <QuizTrack questions={questions} answers={answers} />
        <p className="min-w-0 flex-1 text-xs text-muted">
          {finished ? (
            <span className="font-medium text-ink">
              {correctCount}/{total} right - {passed ? 'passed' : `${need} pass`}
            </span>
          ) : (
            <>
              <span className="font-medium text-ink">
                {answeredCount}/{total}
              </span>{' '}
              answered, {correctCount} right
            </>
          )}
        </p>
        {finished ? (
          <Button size="sm" variant="ghost" onClick={() => goTo(resultRef.current)}>
            See result
            <ArrowRight className="h-3.5 w-3.5" aria-hidden />
          </Button>
        ) : null}
      </div>

      {questions.map((question, index) => {
        const selected = answers[question.id];
        const answered = selected !== undefined;
        const right = selected === question.answer;
        const promptId = `${questionId(question)}-prompt`;
        return (
          <section
            key={question.id}
            id={questionId(question)}
            tabIndex={-1}
            aria-labelledby={promptId}
            className={cn(
              'scroll-mt-20 rounded-2xl border bg-surface p-5 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-brand/60',
              !answered && 'border-line',
              answered && right && 'border-ok/40',
              answered && !right && 'border-warn/40',
            )}
          >
            <h2 id={promptId} className="text-sm font-medium leading-relaxed text-ink">
              <span className="mr-2 font-mono text-xs text-faint">{index + 1}.</span>
              {question.prompt}
            </h2>

            <div className="mt-3 space-y-2">
              {question.options.map((option, optionIndex) => {
                const isSelected = selected === optionIndex;
                const isCorrect = optionIndex === question.answer;
                return (
                  <button
                    key={option}
                    type="button"
                    disabled={answered}
                    aria-pressed={isSelected}
                    onClick={() => choose(question, optionIndex)}
                    className={cn(
                      'flex w-full items-start gap-3 rounded-xl border px-3.5 py-2.5 text-left text-sm transition-colors',
                      'disabled:cursor-default',
                      answered && isCorrect && 'border-ok bg-ok/10 text-ink',
                      answered && isSelected && !isCorrect && 'border-danger bg-danger/10 text-ink',
                      answered && !isCorrect && !isSelected && 'border-line text-faint',
                      !answered && 'border-line text-muted hover:border-brand/50 hover:text-ink',
                    )}
                  >
                    <span className="mt-0.5 font-mono text-xs text-faint">{String.fromCharCode(65 + optionIndex)}</span>
                    <span className="flex-1">{option}</span>
                    {answered && isCorrect ? (
                      <Check className="h-4 w-4 shrink-0 text-ok" role="img" aria-label="Right answer" />
                    ) : null}
                    {answered && isSelected && !isCorrect ? (
                      <X className="h-4 w-4 shrink-0 text-danger" role="img" aria-label="Your answer, wrong" />
                    ) : null}
                  </button>
                );
              })}
            </div>

            {/* Always in the page, so a screen reader reads the explanation out as it appears. */}
            <div aria-live="polite">
              {answered ? (
                <p
                  className={cn(
                    'mt-3 animate-fade-in rounded-xl border p-3 text-sm leading-relaxed text-muted',
                    right ? 'border-ok/30 bg-ok/5' : 'border-warn/30 bg-warn/5',
                  )}
                >
                  <strong className="text-ink">{right ? 'Right. ' : 'Not quite. '}</strong>
                  {question.explanation}
                </p>
              ) : null}
            </div>
          </section>
        );
      })}

      <div aria-live="polite">
        {finished ? (
          <section
            ref={resultRef}
            tabIndex={-1}
            aria-labelledby={`${baseId}-result`}
            className={cn(
              'scroll-mt-20 animate-fade-in space-y-4 rounded-2xl border p-5 outline-none focus-visible:ring-2 focus-visible:ring-brand/60',
              passed ? 'border-ok/40 bg-ok/5' : 'border-warn/40 bg-warn/5',
            )}
          >
            <h2 id={`${baseId}-result`} className="flex items-center gap-2 text-base font-semibold text-ink">
              {passed ? (
                <PartyPopper className="h-5 w-5 shrink-0 text-ok" aria-hidden />
              ) : (
                <Target className="h-5 w-5 shrink-0 text-warn" aria-hidden />
              )}
              {passed
                ? missed.length
                  ? 'Passed. This Concept is Done.'
                  : `All ${total} right. This Concept is Done.`
                : `Not yet: ${need} right answers pass.`}
            </h2>

            <QuizScore correct={correctCount} total={total} />

            {missed.length ? (
              <div>
                <h3 className="label mb-1.5">{passed ? 'Worth another look' : 'Go back to'}</h3>
                <ul className="space-y-0.5">
                  {missed.map((question) => (
                    <li key={question.id}>
                      <button
                        type="button"
                        onClick={() => goTo(document.getElementById(questionId(question)))}
                        className="flex w-full min-w-0 items-baseline gap-2 rounded-lg py-1 text-left text-sm text-muted transition-colors hover:text-ink"
                      >
                        <span className="shrink-0 font-mono text-xs text-faint">{questions.indexOf(question) + 1}.</span>
                        <span className="min-w-0 truncate underline decoration-line underline-offset-4">
                          {question.prompt}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            <div className="flex flex-wrap items-center gap-2">
              {missed.length ? (
                <Button variant={passed ? 'secondary' : 'primary'} onClick={retryMissed}>
                  <RotateCcw className="h-4 w-4" aria-hidden />
                  Try the missed {missed.length === 1 ? 'one' : 'ones'} again
                </Button>
              ) : null}
              {!passed && onReview
                ? review.map((target) => (
                    <Button key={target.id} onClick={() => onReview(target.id)}>
                      {target.label}
                    </Button>
                  ))
                : null}
              <Button variant="ghost" onClick={startOver}>
                Start over
              </Button>
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}

/**
 * One short bar per question in the sticky strip: empty until answered, then filled for a right
 * answer or hollow with a warning edge for a wrong one - so the shape tells them apart, not the
 * color alone. The words beside it carry the same count.
 */
function QuizTrack({ questions, answers }: { questions: QuizQuestion[]; answers: QuizAnswers }) {
  return (
    <span className="flex shrink-0 items-center gap-0.5" aria-hidden>
      {questions.map((question) => {
        const selected = answers[question.id];
        return (
          <span
            key={question.id}
            className={cn(
              'block h-2.5 w-1.5 rounded-sm sm:w-2',
              selected === undefined && 'bg-line',
              selected !== undefined && selected === question.answer && 'bg-ok',
              selected !== undefined && selected !== question.answer && 'border border-warn',
            )}
          />
        );
      })}
    </span>
  );
}

/**
 * The score as a row of bars, one per question, filled one right answer at a
 * time up to the pass mark. Passing is what makes the Concept Done, so the row
 * shows where that line is, and the sentence under it says which side the
 * Learner landed on (never color alone).
 */
function QuizScore({ correct, total }: { correct: number; total: number }) {
  const need = passMark(total);
  const passed = correct >= need;
  return (
    <div className="min-w-0 space-y-1.5">
      <div className="flex items-end gap-1" aria-hidden>
        {Array.from({ length: total }, (_, index) => (
          <span key={index} className="flex items-end gap-1">
            <span
              className={cn(
                'block h-3 w-2.5 rounded-sm sm:w-3',
                index < correct ? (passed ? 'bg-ok' : 'bg-warn') : 'bg-line',
                index < correct && 'tally-in',
              )}
              style={index < correct ? ({ '--i': index } as CSSProperties) : undefined}
            />
            {index === need - 1 && need < total ? <span className="block h-5 w-px bg-ink/40" /> : null}
          </span>
        ))}
      </div>
      <p className="tally-after text-sm text-muted" style={{ '--i': correct } as CSSProperties}>
        <span className="font-medium text-ink">
          {correct} / {total} right.
        </span>{' '}
        {passed
          ? `${need} were needed to pass.`
          : `${need - correct} more right ${need - correct === 1 ? 'answer passes' : 'answers pass'}.`}
      </p>
    </div>
  );
}
