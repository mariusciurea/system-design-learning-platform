import { Suspense } from 'react';
import { Navigate, createBrowserRouter } from 'react-router-dom';
import { AppShell } from '@/components/layout/AppShell';
import { MERGED_CONCEPTS } from '@/data/concepts/merged';
import { lazyWithRetry } from '@/utils/lazyWithRetry';
import { Loader2 } from 'lucide-react';

const HomePage = lazyWithRetry(() => import('@/features/home/HomePage'));
const ConceptPage = lazyWithRetry(() => import('@/features/concept/ConceptPage'));
const CategoryPage = lazyWithRetry(() => import('@/features/categories/CategoryPage'));
const LabsPage = lazyWithRetry(() => import('@/features/labs/LabsPage'));
const LabRoute = lazyWithRetry(() => import('@/features/labs/LabRoute'));
const PlaygroundPage = lazyWithRetry(() => import('@/features/playground/PlaygroundPage'));
const ScenariosPage = lazyWithRetry(() => import('@/features/scenarios/ScenariosPage'));
const ScenarioPage = lazyWithRetry(() => import('@/features/scenarios/ScenarioPage'));
const GlossaryPage = lazyWithRetry(() => import('@/features/glossary/GlossaryPage'));
const ProgressPage = lazyWithRetry(() => import('@/features/progress/ProgressPage'));
const AccountPage = lazyWithRetry(() => import('@/features/account/AccountPage'));
const ComparePage = lazyWithRetry(() => import('@/features/compare/ComparePage'));
const EvolutionPage = lazyWithRetry(() => import('@/features/evolution/EvolutionPage'));
const NotFoundPage = lazyWithRetry(() => import('@/features/NotFoundPage'));

function PageFallback() {
  return (
    <div role="status" className="flex h-64 items-center justify-center gap-2 text-sm text-muted">
      <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
      Loading page...
    </div>
  );
}

const page = (element: React.ReactNode) => <Suspense fallback={<PageFallback />}>{element}</Suspense>;

export const router = createBrowserRouter([
  {
    path: '/',
    element: <AppShell />,
    children: [
      { index: true, element: page(<HomePage />) },
      { path: 'concepts/:slug', element: page(<ConceptPage />) },
      // Old links to a merged Concept land on the Concept it was merged into.
      ...Object.entries(MERGED_CONCEPTS).map(([retired, kept]) => ({
        path: `concepts/${retired}`,
        element: <Navigate to={`/concepts/${kept}`} replace />,
      })),
      { path: 'categories/:categoryId', element: page(<CategoryPage />) },
      { path: 'labs', element: page(<LabsPage />) },
      { path: 'labs/:labId', element: page(<LabRoute />) },
      { path: 'playground', element: page(<PlaygroundPage />) },
      { path: 'scenarios', element: page(<ScenariosPage />) },
      { path: 'scenarios/:slug', element: page(<ScenarioPage />) },
      { path: 'glossary', element: page(<GlossaryPage />) },
      { path: 'progress', element: page(<ProgressPage />) },
      { path: 'account', element: page(<AccountPage />) },
      { path: 'compare', element: page(<ComparePage />) },
      { path: 'evolution', element: page(<EvolutionPage />) },
      { path: '*', element: page(<NotFoundPage />) },
    ],
  },
]);
