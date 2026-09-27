import { useEffect, useId, useRef, useState, type FocusEvent, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { NavLink, matchPath, useLocation } from 'react-router-dom';
import { Check, ChevronDown, FlaskConical, Shapes, BookMarked, Route, Columns2, Waypoints } from 'lucide-react';
import { CategoryIcon } from '@/data/categoryIcons';
import { cn } from '@/utils/cn';
import { CATEGORIES, categoryStyle } from '@/data/categories';
import { CONCEPTS_BY_CATEGORY, getConcept } from '@/data/concepts';
import { useProgress } from '@/app/providers/ProgressProvider';
import type { Category, CategoryId, Difficulty } from '@/types';

const DIFFICULTY_DOT: Record<Difficulty, string> = {
  Beginner: 'bg-ok',
  Intermediate: 'bg-warn',
  Advanced: 'bg-danger',
};

/**
 * Current-page marker for a Tool or a strip icon: a bar on the left edge as well as the tint, so it does
 * not rely on color alone. Callers add the `before:-left-*` offset that puts the bar on the sidebar edge.
 */
const ACTIVE_MARKER = 'bg-brand/10 text-brand before:absolute before:h-5 before:w-1 before:rounded-r before:bg-brand';

const TOOLS = [
  { to: '/labs', label: 'Interactive Labs', Icon: FlaskConical },
  { to: '/playground', label: 'Playground', Icon: Shapes },
  { to: '/evolution', label: 'System Evolution', Icon: Waypoints },
  { to: '/compare', label: 'Compare Mode', Icon: Columns2 },
  { to: '/scenarios', label: 'Scenarios', Icon: Route },
  { to: '/glossary', label: 'Glossary', Icon: BookMarked },
];

interface SidebarProps {
  /** Difficulty filter shared with the topbar control. */
  difficulty: Difficulty | 'all';
  /** Show only the icon strip (wide screens, when the learner folded the sidebar). */
  folded?: boolean;
  /** Asks the shell to open the full sidebar again (a category icon in the strip was clicked). */
  onUnfold?: () => void;
  onNavigate?: () => void;
}

export function Sidebar({ difficulty, folded = false, onUnfold, onNavigate }: SidebarProps) {
  const { completed, categoryProgress } = useProgress();
  const [open, setOpen] = useState<Record<string, boolean>>({ 'getting-started': true, scaling: true });
  const { pathname } = useLocation();
  const activeCategory = useActiveCategory();
  const toolsTitleId = useId();
  const navRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  /** Category picked from the strip, scrolled into view once the full sidebar is back. */
  const revealRef = useRef<CategoryId | null>(null);

  // The current Concept stays in sight: its Category opens (below) and the list scrolls to it. Only the
  // part that scrolls moves - scrollIntoView could also scroll the page or the closed drawer's parents.
  useEffect(() => {
    const list = listRef.current;
    const link = list?.querySelector<HTMLElement>('a[aria-current="page"]');
    if (!list || !link) return;
    // The list scrolls on its own under pinned Tools; in the drawer and on a short screen the whole nav does.
    const scroller = getComputedStyle(list).overflowY === 'visible' ? navRef.current : list;
    if (!scroller) return;
    const box = scroller.getBoundingClientRect();
    const row = link.getBoundingClientRect();
    // Out of sight, it moves to the middle, so the Concepts around it show too.
    if (row.top < box.top || row.bottom > box.bottom) scroller.scrollTop += row.top + row.height / 2 - (box.top + box.height / 2);
  }, [pathname, folded]);

  useEffect(() => {
    const id = revealRef.current;
    if (folded || !id) return;
    revealRef.current = null;
    // The strip icon that was clicked is gone, so focus moves to the category row it opened.
    const row = navRef.current?.querySelector<HTMLElement>(`[data-category="${id}"]`);
    row?.scrollIntoView({ block: 'nearest' });
    row?.querySelector('button')?.focus({ preventScroll: true });
  }, [folded]);

  const openAt = (id: CategoryId) => {
    setOpen((current) => ({ ...current, [id]: true }));
    revealRef.current = id;
    onUnfold?.();
  };

  const conceptsIn = (id: CategoryId) =>
    (CONCEPTS_BY_CATEGORY[id] ?? []).filter((concept) => difficulty === 'all' || concept.difficulty === difficulty);
  const visibleCategories = CATEGORIES.filter((category) => conceptsIn(category.id).length > 0);

  if (folded) return <SidebarStrip categories={visibleCategories} onOpenCategory={openAt} />;

  return (
    <nav
      ref={navRef}
      aria-label="Concept navigation"
      className="flex h-full flex-col max-lg:overflow-y-auto max-lg:overscroll-contain short:overflow-y-auto"
    >
      {/* In the desktop column the Tools stay pinned and only the Category list below the divider
          scrolls. In the drawer (a phone or tablet) and on a short screen, pinned Tools would leave
          the Categories a small box to scroll in, so the whole menu scrolls as one. */}
      <div role="group" aria-labelledby={toolsTitleId} className="shrink-0 space-y-0.5 border-b border-line px-3 pb-3 pt-4">
        <p id={toolsTitleId} className="label px-3 pb-1">
          Tools
        </p>
        {TOOLS.map(({ to, label, Icon }) => (
          <NavLink
            key={to}
            to={to}
            onClick={onNavigate}
            className={({ isActive }) =>
              cn(
                'relative flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                isActive ? cn(ACTIVE_MARKER, 'before:-left-3') : 'text-muted hover:bg-elevated hover:text-ink',
              )
            }
          >
            <Icon className="h-4 w-4 shrink-0" />
            {label}
          </NavLink>
        ))}
      </div>

      <div ref={listRef} className="min-h-0 flex-1 space-y-1 overflow-y-auto px-3 pb-8 pt-3 max-lg:flex-none max-lg:overflow-visible short:flex-none short:overflow-visible">
        {visibleCategories.map((category) => {
          const concepts = conceptsIn(category.id);
          // Until the Learner opens or closes it, a Category is open when the current page is in it.
          const isOpen = open[category.id] ?? category.id === activeCategory;
          const progress = categoryProgress(category.id);

          return (
            <div key={category.id} data-category={category.id} style={categoryStyle(category.id)}>
              <button
                type="button"
                aria-expanded={isOpen}
                onClick={() => setOpen((current) => ({ ...current, [category.id]: !isOpen }))}
                className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm font-medium text-ink transition-colors hover:bg-elevated"
              >
                <CategoryIcon name={category.icon} className="h-4 w-4 shrink-0 text-cat" />
                <span className="flex-1 truncate">{category.title}</span>
                <span className="font-mono text-[11px] tabular-nums text-faint">
                  {progress.done}/{progress.total}
                </span>
                <ChevronDown className={cn('h-3.5 w-3.5 shrink-0 text-faint transition-transform', isOpen && 'rotate-180')} />
              </button>

              {isOpen ? (
                <ul className="ml-[22px] space-y-0.5 border-l border-cat/30 pl-2">
                  {concepts.map((concept) => (
                    <li key={concept.slug}>
                      <NavLink
                        to={`/concepts/${concept.slug}`}
                        onClick={onNavigate}
                        className={({ isActive }) =>
                          cn(
                            'group flex items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px] transition-colors',
                            isActive ? 'bg-brand/10 font-medium text-brand' : 'text-muted hover:bg-elevated hover:text-ink',
                          )
                        }
                      >
                        <span
                          className={cn('h-1.5 w-1.5 shrink-0 rounded-full', DIFFICULTY_DOT[concept.difficulty])}
                          title={concept.difficulty}
                          aria-hidden
                        />
                        <span className="flex-1 truncate">{concept.title}</span>
                        <span className="sr-only">, {concept.difficulty}</span>
                        {completed[concept.slug] ? (
                          <Check className="h-3 w-3 shrink-0 text-ok" aria-label="Done" />
                        ) : null}
                      </NavLink>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          );
        })}
      </div>
    </nav>
  );
}

/** The category the current page belongs to: a category page, or a concept page in it. */
function useActiveCategory(): CategoryId | undefined {
  const { pathname } = useLocation();
  const concept = matchPath('/concepts/:slug', pathname);
  if (concept) return getConcept(concept.params.slug)?.category;
  return matchPath('/categories/:categoryId', pathname)?.params.categoryId as CategoryId | undefined;
}

interface TipState {
  text: string;
  top: number;
  left: number;
}

const STRIP_ITEM =
  'relative flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-colors outline-none focus-visible:ring-2 focus-visible:ring-brand';
/** The marker bar sits on the strip edge: the 36px icon is centered in the 56px strip, 10px in. */
const STRIP_ACTIVE = cn(ACTIVE_MARKER, 'before:-left-2.5');

/**
 * The folded sidebar: one icon per tool and per category. Each icon names
 * itself in a tooltip on hover or focus, and a category adds its Done count. The tooltip is
 * portalled to the body because the strip clips anything that leaves it.
 */
function SidebarStrip({
  categories,
  onOpenCategory,
}: {
  categories: Category[];
  /** Opens the full sidebar with this category expanded. */
  onOpenCategory: (id: CategoryId) => void;
}) {
  const { categoryProgress } = useProgress();
  const activeCategory = useActiveCategory();
  const [tip, setTip] = useState<TipState | null>(null);

  const show = (text: string) => (event: MouseEvent<HTMLElement> | FocusEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setTip({ text, top: rect.top + rect.height / 2, left: rect.right + 10 });
  };
  // Visual only: every icon already carries the same text (and the Done count) in its aria-label.
  const tipProps = (text: string) => ({
    onMouseEnter: show(text),
    onFocus: show(text),
    onMouseLeave: () => setTip(null),
    onBlur: () => setTip(null),
  });

  return (
    <nav aria-label="Concept navigation" className="flex h-full w-14 flex-col items-center gap-0.5 overflow-y-auto py-4">
      {TOOLS.map(({ to, label, Icon }) => (
        <NavLink
          key={to}
          to={to}
          aria-label={label}
          {...tipProps(label)}
          className={({ isActive }) =>
            cn(STRIP_ITEM, isActive ? STRIP_ACTIVE : 'text-muted hover:bg-elevated hover:text-ink')
          }
        >
          <Icon className="h-4 w-4" />
        </NavLink>
      ))}

      <div className="my-2 h-px w-8 shrink-0 bg-line" />

      {categories.map((category) => {
        const progress = categoryProgress(category.id);
        const isActive = category.id === activeCategory;
        return (
          <button
            key={category.id}
            type="button"
            aria-label={`${category.title}, ${progress.done} of ${progress.total} done`}
            aria-current={isActive ? 'page' : undefined}
            {...tipProps(`${category.title} ${progress.done}/${progress.total}`)}
            onClick={() => onOpenCategory(category.id)}
            style={categoryStyle(category.id)}
            className={cn(STRIP_ITEM, isActive ? STRIP_ACTIVE : 'text-cat hover:bg-cat/10')}
          >
            <CategoryIcon name={category.icon} className="h-4 w-4" />
          </button>
        );
      })}

      {tip
        ? createPortal(
            <span
              aria-hidden
              style={{ top: tip.top, left: tip.left }}
              className="pointer-events-none fixed z-50 -translate-y-1/2 whitespace-nowrap rounded-lg border border-line bg-surface px-2.5 py-1.5 text-xs font-medium text-ink shadow-card animate-fade-in"
            >
              {tip.text}
            </span>,
            document.body,
          )
        : null}
    </nav>
  );
}
