/**
 * Local progress as one record per Concept, each with the time of its last
 * change, so that two devices can be merged with "latest change wins" (see
 * docs/adr/0001-backend-with-rented-auth.md).
 *
 * Pure functions only - no React, no storage, no clock. Every change takes
 * `now`, so the rules can be run and checked outside the browser. No imports
 * either, so Node can run this file and its tests as they are.
 */

export interface QuizResult {
  correct: number;
  total: number;
  at: number;
}

export interface ConceptProgress {
  /** Time of the first visit. */
  visitedAt?: number;
  done: boolean;
  /** Time Done was last set or cleared - un-marking keeps this record instead of deleting it. */
  doneAt: number;
  /** The best result, not the latest. */
  quiz?: QuizResult;
  /** Time of the last Reset: a visit or a quiz from before it no longer counts. */
  clearedAt?: number;
  /** Time of the last change of any kind. */
  changedAt: number;
}

export interface ProgressState {
  concepts: Record<string, ConceptProgress>;
}

/** The shape the pages read: the same three maps progress had before it kept change times. */
export interface ProgressView {
  visited: Record<string, number>;
  completed: Record<string, true>;
  quiz: Record<string, QuizResult>;
}

/** Saved progress as found in storage: the current format, and the one before it. */
export interface SavedProgress {
  current: string | null;
  legacy: string | null;
}

export const EMPTY_PROGRESS: ProgressState = { concepts: {} };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Keeps only the entries whose value passes `keep` - anything else in storage is dropped. */
function pick<T>(value: unknown, keep: (entry: unknown) => entry is T): Record<string, T> {
  if (!isRecord(value)) return {};
  const result: Record<string, T> = {};
  for (const [key, entry] of Object.entries(value)) {
    // `__proto__` is an own key after JSON.parse, but assigning it would swap the prototype.
    if (key !== '__proto__' && keep(entry)) result[key] = entry;
  }
  return result;
}

const isFiniteNumber = (entry: unknown): entry is number => typeof entry === 'number' && Number.isFinite(entry);
const isTrue = (entry: unknown): entry is true => entry === true;
const isQuizResult = (entry: unknown): entry is QuizResult =>
  isRecord(entry) &&
  isFiniteNumber(entry.correct) &&
  isFiniteNumber(entry.total) &&
  entry.total > 0 &&
  isFiniteNumber(entry.at);

function parseJson(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const VERSION = 2;

const isOptional = <T>(entry: unknown, check: (value: unknown) => value is T) => entry === undefined || check(entry);

const isConceptProgress = (entry: unknown): entry is ConceptProgress =>
  isRecord(entry) &&
  typeof entry.done === 'boolean' &&
  isFiniteNumber(entry.doneAt) &&
  isFiniteNumber(entry.changedAt) &&
  isOptional(entry.visitedAt, isFiniteNumber) &&
  isOptional(entry.quiz, isQuizResult) &&
  isOptional(entry.clearedAt, isFiniteNumber);

/** Rebuilt with known fields only, so a stray field in storage is not carried along forever. */
function cleanRecord(entry: ConceptProgress): ConceptProgress {
  const record: ConceptProgress = { done: entry.done, doneAt: entry.doneAt, changedAt: entry.changedAt };
  if (entry.visitedAt !== undefined) record.visitedAt = entry.visitedAt;
  if (entry.quiz) record.quiz = { correct: entry.quiz.correct, total: entry.quiz.total, at: entry.quiz.at };
  if (entry.clearedAt !== undefined) record.clearedAt = entry.clearedAt;
  return record;
}

function fromCurrent(saved: Record<string, unknown>): ProgressState {
  const concepts: Record<string, ConceptProgress> = {};
  for (const [slug, entry] of Object.entries(pick(saved.concepts, isConceptProgress))) concepts[slug] = cleanRecord(entry);
  return { concepts };
}

/**
 * The format before change times: three maps, and no time for Done. A Done
 * Concept gets the latest time it is known to have changed, which is no later
 * than the real one, so a newer change on another device still wins over it.
 * A Concept that is not Done was never un-marked as far as we know, so it gets
 * no time for Done at all and cannot un-mark it elsewhere.
 */
function fromLegacy(saved: Record<string, unknown>): ProgressState {
  const visited = pick(saved.visited, isFiniteNumber);
  const completed = pick(saved.completed, isTrue);
  const quiz = pick(saved.quiz, isQuizResult);
  const concepts: Record<string, ConceptProgress> = {};
  for (const slug of new Set([...Object.keys(visited), ...Object.keys(completed), ...Object.keys(quiz)])) {
    const known = Math.max(0, visited[slug] ?? 0, quiz[slug]?.at ?? 0);
    const done = Boolean(completed[slug]);
    const record: ConceptProgress = { done, doneAt: done ? known : 0, changedAt: known };
    if (visited[slug] !== undefined) record.visitedAt = visited[slug];
    if (quiz[slug]) record.quiz = quiz[slug];
    concepts[slug] = record;
  }
  return { concepts };
}

const quizRatio = (result: QuizResult) => result.correct / result.total;

/** The better score; on a tie, the later attempt, then the longer quiz - so the order of `a` and `b` never matters. */
function bestQuiz(a: QuizResult | undefined, b: QuizResult | undefined): QuizResult | undefined {
  if (!a || !b) return a ?? b;
  const order = quizRatio(b) - quizRatio(a) || b.at - a.at || b.total - a.total;
  return order > 0 ? b : a;
}

function earliest(a: number | undefined, b: number | undefined): number | undefined {
  return a === undefined || b === undefined ? (a ?? b) : Math.min(a, b);
}

function latest(a: number | undefined, b: number | undefined): number | undefined {
  return a === undefined || b === undefined ? (a ?? b) : Math.max(a, b);
}

/**
 * Two records of one Concept as one: the latest change to Done wins (Done on
 * a tie), the best quiz score and the first visit are kept.
 *
 * A Reset starts the visits and the quiz over. Only the side with the latest
 * Reset counts for them: a record keeps only its first visit and its best
 * score, not every attempt, so it cannot tell which ones came after a Reset it
 * did not see. Dropping all of that side is what keeps the merge the same in
 * any order and grouping, which a sync of three devices needs. The cost: a
 * visit or a quiz on a device that had not heard of the Reset yet is lost.
 * Done has its own time, and a Reset sets it too, so a later Done survives.
 */
function mergeConcept(a: ConceptProgress, b: ConceptProgress): ConceptProgress {
  const doneFrom = b.doneAt > a.doneAt || (b.doneAt === a.doneAt && b.done) ? b : a;
  const record: ConceptProgress = {
    done: doneFrom.done,
    doneAt: doneFrom.doneAt,
    changedAt: Math.max(a.changedAt, b.changedAt),
  };
  const since = (side: ConceptProgress) => side.clearedAt ?? -Infinity;
  const cleared = latest(a.clearedAt, b.clearedAt);
  const counted = [a, b].filter((side) => since(side) === Math.max(since(a), since(b)));
  const visitedAt = counted.map((side) => side.visitedAt).reduce(earliest);
  if (visitedAt !== undefined) record.visitedAt = visitedAt;
  const quiz = counted.map((side) => side.quiz).reduce(bestQuiz);
  if (quiz) record.quiz = quiz;
  if (cleared !== undefined) record.clearedAt = cleared;
  return record;
}

/**
 * Progress saved under a merged Concept moves to the Concept it was merged
 * into, and the retired key is dropped, so the next save no longer carries it.
 * Unlike two devices, these are two Concepts: un-marking one never un-marked
 * the other, so here Done wins over a later un-mark.
 */
function carryMerged(state: ProgressState, merged: Readonly<Record<string, string>>): ProgressState {
  const concepts = { ...state.concepts };
  for (const [retired, kept] of Object.entries(merged)) {
    const from = concepts[retired];
    if (!from) continue;
    const into = concepts[kept];
    let record = into ? mergeConcept(into, from) : from;
    if (!record.done && into) {
      const done = [into, from].filter((side) => side.done);
      if (done.length) record = { ...record, done: true, doneAt: Math.max(...done.map((side) => side.doneAt)) };
    }
    concepts[kept] = record;
    delete concepts[retired];
  }
  return { concepts };
}

/**
 * Storage is outside our control - an older schema, a manual edit or a
 * truncated write must not crash the app later, so the saved state is rebuilt
 * field by field.
 */
export function parseProgress(saved: SavedProgress, merged: Readonly<Record<string, string>>): ProgressState {
  const current = parseJson(saved.current);
  if (current?.version === VERSION) return carryMerged(fromCurrent(current), merged);
  const legacy = parseJson(saved.legacy);
  return legacy ? carryMerged(fromLegacy(legacy), merged) : EMPTY_PROGRESS;
}

export function serializeProgress(state: ProgressState): string {
  return JSON.stringify({ version: VERSION, concepts: state.concepts });
}

/** Done Concepts are listed in the order they became Done, as they were before change times. */
export function progressView(state: ProgressState): ProgressView {
  const view: ProgressView = { visited: {}, completed: {}, quiz: {} };
  const records = Object.entries(state.concepts);
  for (const [slug, record] of records) {
    if (record.visitedAt !== undefined) view.visited[slug] = record.visitedAt;
    if (record.quiz) view.quiz[slug] = record.quiz;
  }
  const done = records.filter(([, record]) => record.done).sort(([, a], [, b]) => a.doneAt - b.doneAt);
  for (const [slug] of done) view.completed[slug] = true;
  return view;
}

const UNTOUCHED: ConceptProgress = { done: false, doneAt: 0, changedAt: 0 };

function change(state: ProgressState, slug: string, record: ConceptProgress): ProgressState {
  return { concepts: { ...state.concepts, [slug]: record } };
}

/** Records the first visit only - opening a Concept again is not a change. */
export function markVisited(state: ProgressState, slug: string, now: number): ProgressState {
  const record = state.concepts[slug] ?? UNTOUCHED;
  if (record.visitedAt !== undefined) return state;
  return change(state, slug, { ...record, visitedAt: now, changedAt: now });
}

/** Un-marking does not delete: it keeps the time Done was cleared, so an older Done elsewhere cannot win. */
export function toggleDone(state: ProgressState, slug: string, now: number): ProgressState {
  const record = state.concepts[slug] ?? UNTOUCHED;
  return change(state, slug, { ...record, done: !record.done, doneAt: now, changedAt: now });
}

/** The share of a Quiz a Learner must get right for the Concept to become Done. */
export const PASS_RATIO = 0.7;

/** The fewest right answers that pass a Quiz of `total` questions (7 of 10). */
export const passMark = (total: number) => Math.ceil(total * PASS_RATIO - 1e-9);

/**
 * Keeps the best score. A pass makes the Concept Done, and records the time
 * even when it already was, so it wins over an older un-mark on another
 * device. A failed attempt that is not a better score is not a change.
 */
export function recordQuiz(state: ProgressState, slug: string, correct: number, total: number, now: number): ProgressState {
  const record = state.concepts[slug] ?? UNTOUCHED;
  const attempt: QuizResult = { correct, total, at: now };
  const quiz = bestQuiz(record.quiz, attempt) ?? attempt;
  const passes = total > 0 && correct >= passMark(total);
  if (quiz === record.quiz && !passes) return state;
  return change(state, slug, {
    ...record,
    quiz,
    ...(passes ? { done: true, doneAt: now } : {}),
    changedAt: now,
  });
}

/**
 * Clears every Concept but keeps one record each with the time it was
 * cleared, so a device that still holds the old progress cannot bring it back.
 * `slugs` is every Concept of the app: one this device never opened may still
 * have progress on another device.
 */
export function resetProgress(state: ProgressState, slugs: readonly string[], now: number): ProgressState {
  const concepts: Record<string, ConceptProgress> = {};
  for (const slug of new Set([...slugs, ...Object.keys(state.concepts)]))
    concepts[slug] = { done: false, doneAt: now, clearedAt: now, changedAt: now };
  return { concepts };
}

/**
 * The progress of two devices as one, for the sync of an Account: for each
 * Concept the latest change to Done wins (so un-marking on one device
 * un-marks on the other), a Quiz keeps its best score, and the first visit is
 * the earliest; a Reset wins over the visits and scores it did not see (see
 * mergeConcept). Any order and grouping of merges gives the same records, so
 * a server and several devices end on the same progress.
 */
export function mergeProgress(a: ProgressState, b: ProgressState): ProgressState {
  const concepts = { ...a.concepts };
  for (const [slug, record] of Object.entries(b.concepts)) {
    const other = concepts[slug];
    concepts[slug] = other ? mergeConcept(other, record) : record;
  }
  return { concepts };
}
