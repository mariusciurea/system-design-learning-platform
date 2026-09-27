import { RouterProvider } from 'react-router-dom';
import { ErrorBoundary } from '@/components/ui';
import { ThemeProvider } from './providers/ThemeProvider';
import { AccountProvider } from './providers/AccountProvider';
import { ProgressProvider } from './providers/ProgressProvider';
import { LayoutProvider } from './providers/LayoutProvider';
import { router } from './router';

export function App() {
  return (
    <ErrorBoundary area="Application" root>
      <ThemeProvider>
        <AccountProvider>
          <ProgressProvider>
            <LayoutProvider>
              <RouterProvider router={router} />
            </LayoutProvider>
          </ProgressProvider>
        </AccountProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}
