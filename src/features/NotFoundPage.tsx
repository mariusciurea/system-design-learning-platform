import { Link } from 'react-router-dom';
import { Compass, FlaskConical, Layers3 } from 'lucide-react';

export function NotFoundPage() {
  return (
    <div className="mx-auto max-w-2xl px-5 py-20 text-center">
      <h1 className="text-2xl font-semibold text-ink">This route does not exist</h1>
      <p className="mt-2 text-sm text-muted">
        No load balancer can route a request to a server that was never registered. Try one of these instead.
      </p>

      <div className="mt-8 grid gap-3 sm:grid-cols-3">
        {[
          { to: '/', label: 'Home', Icon: Compass },
          { to: '/labs', label: 'Interactive Labs', Icon: FlaskConical },
          { to: '/playground', label: 'Playground', Icon: Layers3 },
        ].map(({ to, label, Icon }) => (
          <Link
            key={to}
            to={to}
            className="flex flex-col items-center gap-2 rounded-2xl border border-line bg-surface p-5 text-sm text-ink transition-colors hover:border-brand hover:text-brand"
          >
            <Icon className="h-5 w-5" aria-hidden />
            {label}
          </Link>
        ))}
      </div>

      {/* A touch screen has no Ctrl+K; there the Search button in the top bar is in plain sight. */}
      <p className="mt-8 text-xs text-faint coarse:hidden">Press Ctrl+K to search everything.</p>
    </div>
  );
}

export default NotFoundPage;
