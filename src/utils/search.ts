import { CONCEPTS } from '@/data/concepts';
import { GLOSSARY } from '@/data/glossary';
import { SCENARIOS } from '@/data/scenarios';
import { CATEGORY_BY_ID } from '@/data/categories';

export type SearchKind = 'concept' | 'lab' | 'scenario' | 'glossary' | 'category';

export interface SearchResult {
  id: string;
  kind: SearchKind;
  title: string;
  subtitle: string;
  to: string;
  score: number;
}

const normalise = (value: string) => value.toLowerCase().trim();

/**
 * Scores a haystack against a query. Exact and prefix matches on the title rank
 * far above a keyword match so that typing "load" surfaces Load Balancing first.
 */
function score(query: string, title: string, keywords: string[]): number {
  const q = normalise(query);
  const t = normalise(title);
  if (!q) return 0;
  if (t === q) return 100;
  if (t.startsWith(q)) return 80;
  if (t.includes(q)) return 60;
  for (const keyword of keywords) {
    const k = normalise(keyword);
    if (k === q) return 50;
    if (k.startsWith(q)) return 35;
    if (k.includes(q)) return 20;
  }
  return 0;
}

/**
 * Global search across every surface of the app. Kept in one place so the
 * command palette, the glossary and the category pages all rank identically.
 */
export function search(query: string, limit = 24): SearchResult[] {
  if (!query.trim()) return [];
  const results: SearchResult[] = [];

  for (const concept of CONCEPTS) {
    const keywords = [...(concept.keywords ?? []), concept.tagline, concept.category];
    const value = score(query, concept.title, keywords);
    if (value > 0) {
      results.push({
        id: `concept:${concept.slug}`,
        // Every Concept hosts a Lab, so a Concept result is a Concept: it opens the Concept page.
        kind: 'concept',
        title: concept.title,
        subtitle: `${CATEGORY_BY_ID[concept.category].title} - ${concept.difficulty}`,
        to: `/concepts/${concept.slug}`,
        score: value,
      });
    }
  }

  for (const scenario of SCENARIOS) {
    const value = score(query, scenario.title, [scenario.tagline, ...scenario.concepts]);
    if (value > 0) {
      results.push({
        id: `scenario:${scenario.slug}`,
        kind: 'scenario',
        title: scenario.title,
        subtitle: `Scenario - ${scenario.difficulty}`,
        to: `/scenarios/${scenario.slug}`,
        score: value,
      });
    }
  }

  for (const entry of GLOSSARY) {
    const value = score(query, entry.term, [entry.definition]);
    if (value > 0) {
      results.push({
        id: `glossary:${entry.term}`,
        kind: 'glossary',
        title: entry.term,
        subtitle: entry.definition,
        to: entry.slug ? `/concepts/${entry.slug}` : '/glossary',
        score: value - 10,
      });
    }
  }

  for (const category of Object.values(CATEGORY_BY_ID)) {
    const value = score(query, category.title, [category.blurb]);
    if (value > 0) {
      results.push({
        id: `category:${category.id}`,
        kind: 'category',
        title: category.title,
        subtitle: category.blurb,
        to: `/categories/${category.id}`,
        score: value - 5,
      });
    }
  }

  return results.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Concepts related to a query, used for the "Related concepts" search column. */
export function relatedConcepts(query: string, exclude: string[] = [], limit = 5) {
  return search(query, 30)
    .filter((result) => (result.kind === 'concept' || result.kind === 'lab') && !exclude.includes(result.title))
    .slice(0, limit);
}
