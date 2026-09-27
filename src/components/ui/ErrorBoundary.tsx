import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, RotateCcw, WifiOff } from 'lucide-react';
import { Button } from './Button';

interface Props {
  children: ReactNode;
  /** Shown in the fallback so the user knows which part failed. */
  area?: string;
  /** The boundary around the whole app: nothing else is left running, so the fallback does not say so. */
  root?: boolean;
  /** Replaces the default card, for a part that needs its own recovery (a dialog that must close). */
  fallback?: (error: Error, reset: () => void) => ReactNode;
}

interface State {
  error: Error | null;
}

/** A failed code-split fetch: a stale document or a dropped connection, not a bug in the view. */
const isChunkError = (error: Error) =>
  /dynamically imported module|Importing a module script failed|Loading chunk|error loading dynamically/i.test(
    error.message,
  );

const isOffline = () => typeof navigator !== 'undefined' && navigator.onLine === false;

/**
 * Keeps one broken simulation from taking down the whole application - labs run
 * continuous loops, so an isolated failure should stay isolated.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[system-design-interactive]', this.props.area ?? 'app', error, info.componentStack);
  }

  // The offline and online wording follows the connection while the fallback shows.
  componentDidMount() {
    window.addEventListener('online', this.onConnectionChange);
    window.addEventListener('offline', this.onConnectionChange);
  }

  componentWillUnmount() {
    window.removeEventListener('online', this.onConnectionChange);
    window.removeEventListener('offline', this.onConnectionChange);
  }

  private onConnectionChange = () => {
    if (this.state.error) this.forceUpdate();
  };

  private reset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback(error, this.reset);

    const chunk = isChunkError(error);
    const offline = chunk && isOffline();

    return (
      <div role="alert" className="card m-4 p-6">
        <div className="flex items-start gap-3">
          {offline ? (
            <WifiOff className="mt-0.5 h-5 w-5 shrink-0 text-warn" aria-hidden />
          ) : (
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-danger" aria-hidden />
          )}
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold text-ink">
              {offline
                ? 'You are offline'
                : chunk
                  ? 'This view could not be loaded'
                  : this.props.area
                    ? `${this.props.area} crashed`
                    : 'Something went wrong'}
            </h2>
            <p className="mt-1 text-sm text-muted">
              {offline
                ? 'This part of the app was not downloaded before the connection dropped. Reconnect, then reload. The pages you already opened still work.'
                : chunk
                  ? 'A new version was deployed, or the connection dropped while it was downloading. Reloading fetches the current one.'
                  : this.props.root
                    ? 'Reset the app to try again.'
                    : 'The rest of the application is still running. Reset this view to try again.'}
            </p>
            {chunk ? null : <pre className="ascii mt-3 max-h-40 whitespace-pre-wrap break-words">{error.message}</pre>}
            <div className="mt-4 flex flex-wrap gap-2">
              {chunk ? (
                // A failed lazy import stays failed for this document, so only a reload can fix it.
                <Button variant="primary" disabled={offline} onClick={() => window.location.reload()}>
                  <RotateCcw className="h-4 w-4" aria-hidden />
                  {offline ? 'Reload when back online' : 'Reload the page'}
                </Button>
              ) : (
                <Button onClick={this.reset}>
                  <RotateCcw className="h-4 w-4" aria-hidden />
                  {this.props.root ? 'Reset the app' : 'Reset view'}
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }
}
