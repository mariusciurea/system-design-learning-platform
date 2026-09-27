import { useCallback, useRef, useState } from 'react';
import { Send } from 'lucide-react';
import { ArchNode, DiagramCanvas, NodeStatRow, type DiagramEdge, type Layout, type ParticleView } from '@/components/architecture';
import { Insight, LabShell, MetricsPanel } from '@/components/learning';
import { Badge, Button, Select, Toggle } from '@/components/ui';
import { useTicker } from '@/simulations/engine';
import { useRerender } from '@/hooks/useRerender';
import { cn } from '@/utils/cn';
import { formatNumber } from '@/utils/format';

type Endpoint = '/api/orders/123' | '/api/users/me' | '/api/payments' | '/api/unknown';

const ENDPOINTS: { value: Endpoint; label: string }[] = [
  { value: '/api/orders/123', label: 'GET /api/orders/123' },
  { value: '/api/users/me', label: 'GET /api/users/me' },
  { value: '/api/payments', label: 'POST /api/payments' },
  { value: '/api/unknown', label: 'GET /api/unknown' },
];

const ROUTES: Record<Endpoint, string | null> = {
  '/api/orders/123': 'orders',
  '/api/users/me': 'users',
  '/api/payments': 'payments',
  '/api/unknown': null,
};

interface Stage {
  id: string;
  label: string;
  detail: string;
  status: 'pass' | 'reject' | 'skipped';
}

const LAYOUT: Layout = {
  client: { x: 40, y: 200, w: 160, h: 82 },
  gateway: { x: 300, y: 147, w: 230, h: 196 },
  users: { x: 660, y: 60, w: 200, h: 96 },
  orders: { x: 660, y: 195, w: 200, h: 96 },
  payments: { x: 660, y: 330, w: 200, h: 96 },
};

export function ApiGatewayLab() {
  const [endpoint, setEndpoint] = useState<Endpoint>('/api/orders/123');
  const [validToken, setValidToken] = useState(true);
  const [authEnabled, setAuthEnabled] = useState(true);
  const [rateLimitEnabled, setRateLimitEnabled] = useState(true);
  const [quotaUsed, setQuotaUsed] = useState(0);
  const [stageIndex, setStageIndex] = useState(-1);
  const [sent, setSent] = useState(0);
  const [rejected, setRejected] = useState(0);
  const progress = useRef(0);
  const rerender = useRerender(30);

  const quota = 10;

  const buildStages = useCallback((): Stage[] => {
    const authStage: Stage = !authEnabled
      ? { id: 'auth', label: 'JWT validation', detail: 'Disabled - every service must now authenticate on its own', status: 'skipped' }
      : validToken
        ? { id: 'auth', label: 'JWT validation', detail: 'Signature, issuer, audience and expiry all valid -> sub=user_42', status: 'pass' }
        : { id: 'auth', label: 'JWT validation', detail: 'Invalid signature -> 401 Unauthorized, rejected at the edge', status: 'reject' };

    const overQuota = rateLimitEnabled && quotaUsed >= quota;
    const limitStage: Stage = !rateLimitEnabled
      ? { id: 'limit', label: 'Rate limit check', detail: 'Disabled - one client can consume all backend capacity', status: 'skipped' }
      : overQuota
        ? { id: 'limit', label: 'Rate limit check', detail: `Quota ${quotaUsed}/${quota} exhausted -> 429 Too Many Requests`, status: 'reject' }
        : { id: 'limit', label: 'Rate limit check', detail: `Fixed window: request ${quotaUsed + 1} of ${quota} in this window`, status: 'pass' };

    const target = ROUTES[endpoint];
    const routeStage: Stage = target
      ? { id: 'route', label: 'Route matching', detail: `${endpoint} matches ${target}-service`, status: 'pass' }
      : { id: 'route', label: 'Route matching', detail: 'No route matches this path -> 404 Not Found', status: 'reject' };

    const transformStage: Stage = {
      id: 'transform',
      label: 'Request transformation',
      detail: 'Adds X-Request-Id, X-User-Id and traceparent; keeps the token so the service can verify it too',
      status: 'pass',
    };

    const forwardStage: Stage = {
      id: 'forward',
      label: 'Forward to service',
      detail: target ? `Proxied to ${target}-service` : 'Never reached',
      status: target ? 'pass' : 'skipped',
    };

    const stages = [authStage, limitStage, routeStage, transformStage, forwardStage];
    const firstReject = stages.findIndex((stage) => stage.status === 'reject');
    if (firstReject >= 0) {
      return stages.map((stage, index) => (index > firstReject ? { ...stage, status: 'skipped' } : stage));
    }
    return stages;
  }, [authEnabled, validToken, rateLimitEnabled, quotaUsed, endpoint]);

  // The pipeline of the request last sent. While idle (stageIndex -1) the panel
  // previews what the current controls would do instead, so the pipeline, the
  // metrics and the response code never describe two different requests.
  const [sentStages, setSentStages] = useState<Stage[]>([]);
  const stages = stageIndex >= 0 ? sentStages : buildStages();

  const send = useCallback(() => {
    const next = buildStages();
    setSentStages(next);
    setStageIndex(0);
    progress.current = 0;
    setSent((value) => value + 1);
    if (next.some((stage) => stage.status === 'reject')) setRejected((value) => value + 1);
    // Only a request that reached the limiter and was let through spends quota;
    // one rejected earlier (bad token) never got that far.
    if (next.find((stage) => stage.id === 'limit')?.status === 'pass') setQuotaUsed((value) => value + 1);
  }, [buildStages]);

  /** Any control change starts a new preview instead of relabelling the last request. */
  const changed = <T,>(setter: (value: T) => void) => (value: T) => {
    setter(value);
    setStageIndex(-1);
  };

  useTicker(stageIndex >= 0 && stageIndex < stages.length, (dt) => {
    progress.current += dt * 1.6;
    if (progress.current >= 1) {
      progress.current = 0;
      const next = stageIndex + 1;
      setStageIndex(next >= stages.length || stages[next]?.status === 'skipped' ? stages.length : next);
    }
    rerender();
  });

  const active = stageIndex >= 0 && stageIndex < stages.length ? stages[stageIndex] : null;
  const rejectedStage = stages.find((stage) => stage.status === 'reject');
  const target = ROUTES[endpoint];
  const finished = stageIndex >= stages.length;

  const edges: DiagramEdge[] = [
    { from: 'client', to: 'gateway', tone: 'brand', width: 2 },
    ...(['users', 'orders', 'payments'] as const).map<DiagramEdge>((service) => ({
      from: 'gateway',
      to: service,
      tone: target === service ? 'ok' : 'muted',
      dashed: target !== service,
      animated: target === service && finished && !rejectedStage,
    })),
  ];

  // One request: it travels to the gateway during the first check, waits there
  // through the others, and only the forward step carries it to the service.
  const particles: ParticleView[] = !active
    ? []
    : active.id === 'forward' && target
      ? [{ id: 2, from: 'gateway', to: target, t: Math.min(1, progress.current), outcome: 'success' }]
      : [
          {
            id: 1,
            from: 'client',
            to: 'gateway',
            t: stageIndex === 0 ? Math.min(1, progress.current) : 1,
            outcome: active.status === 'reject' ? 'failure' : 'success',
          },
        ];

  return (
    <LabShell
      title="API Gateway Lab"
      description="One request, one pipeline. Toggle auth and rate limiting and watch where a request is rejected - before it costs backend capacity."
      onReset={() => {
        setEndpoint('/api/orders/123');
        setValidToken(true);
        setAuthEnabled(true);
        setRateLimitEnabled(true);
        setQuotaUsed(0);
        setSent(0);
        setRejected(0);
        setStageIndex(-1);
      }}
      actions={
        <Button variant="primary" onClick={send}>
          <Send className="h-4 w-4" />
          Send request
        </Button>
      }
      insight={
        <Insight
          title={
            stageIndex < 0
              ? rejectedStage
                ? `Would be rejected at: ${rejectedStage.label}`
                : 'Would be accepted'
              : rejectedStage
                ? `Rejected at: ${rejectedStage.label}`
                : 'Request accepted'
          }
        >
          {rejectedStage ? (
            <>
              {rejectedStage.detail}. The request never reached a backend service, so it consumed a few microseconds of
              gateway CPU instead of a database connection. Early rejection is the main reason cross-cutting concerns
              live at the edge.
            </>
          ) : (
            <>
              Authentication, quota enforcement, routing and header injection all happened once, in one place. Without a
              gateway each of the three services would implement these - inconsistently - and clients would need to
              know the topology.
            </>
          )}
        </Insight>
      }
      metrics={
        <>
          <MetricsPanel
            items={[
              { key: 'sent', label: 'Requests sent', value: formatNumber(sent) },
              { key: 'rejected', label: 'Rejected at edge', value: formatNumber(rejected), tone: rejected > 0 ? 'warn' : 'ok' },
              {
                key: 'quota',
                label: 'Quota used',
                value: `${quotaUsed}/${quota}`,
                tone: quotaUsed >= quota ? 'danger' : 'ok',
                hint: 'Requests this client made in the current fixed window. A real gateway resets the window on a timer; here the Reset quota window button does it.',
              },
              {
                key: 'route',
                label: 'Resolved route',
                value: target ? `${target}-service` : 'no match',
                tone: target ? 'brand' : 'danger',
              },
              {
                key: 'backendCost',
                label: 'Backend cost',
                value: rejectedStage ? 'none' : '1 call',
                tone: rejectedStage ? 'ok' : 'neutral',
                hint: 'Backend capacity consumed by this request.',
              },
            ]}
          />

          <div className="card p-4">
            <p className="label mb-3">Gateway pipeline</p>
            <ol className="space-y-2">
              {stages.map((stage, index) => {
                const isActive = index === stageIndex;
                const reached = stageIndex >= index;
                return (
                  <li
                    key={stage.id}
                    className={cn(
                      'flex items-start gap-3 rounded-xl border px-3.5 py-2.5 transition-colors',
                      isActive
                        ? 'border-brand bg-brand/5'
                        : stage.status === 'reject' && reached
                          ? 'border-danger/40 bg-danger/5'
                          : stage.status === 'skipped'
                            ? 'border-line opacity-50'
                            : 'border-line',
                    )}
                  >
                    <span className="mt-0.5 font-mono text-[11px] text-faint">{index + 1}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium text-ink">{stage.label}</span>
                      <span className="block text-xs text-muted">{stage.detail}</span>
                    </span>
                    <Badge
                      tone={
                        stage.status === 'reject' ? 'danger' : stage.status === 'skipped' ? 'neutral' : 'ok'
                      }
                    >
                      {stage.status === 'reject' ? 'reject' : stage.status === 'skipped' ? 'skipped' : 'pass'}
                    </Badge>
                  </li>
                );
              })}
            </ol>
            <pre className="ascii mt-4">{`${endpoint.startsWith('/api/payments') ? 'POST' : 'GET'} ${endpoint}
Authorization: Bearer ${validToken ? 'eyJhbGciOiJIUzI1NiIs...' : 'tampered.token.value'}

-> ${rejectedStage ? (rejectedStage.id === 'auth' ? '401 Unauthorized' : rejectedStage.id === 'limit' ? '429 Too Many Requests' : '404 Not Found') : '200 OK'}`}</pre>
          </div>
        </>
      }
      controls={
        <>
          <Select
            label="Endpoint"
            value={endpoint}
            options={ENDPOINTS}
            onChange={changed(setEndpoint)}
            hint="The gateway matches the path against its route table."
          />
          <Toggle
            label="JWT validation"
            checked={authEnabled}
            onChange={changed(setAuthEnabled)}
            description="Verify the token at the edge before any backend work"
          />
          <Toggle
            label="Rate limiting"
            checked={rateLimitEnabled}
            onChange={changed(setRateLimitEnabled)}
            description="Enforce a per-client quota at the gateway"
          />
          <Toggle
            label="Token is valid"
            checked={validToken}
            onChange={changed(setValidToken)}
            description="Off: simulate a tampered or expired token"
          />
          <Button className="w-full justify-center" onClick={() => changed(setQuotaUsed)(0)}>
            Reset quota window
          </Button>
          <div className="border-t border-line pt-4 text-[11px] text-muted">
            <p className="label mb-2">Watch out for</p>
            <ul className="space-y-1">
              <li>Business logic creeping into the gateway</li>
              <li>A single gateway instance - it is on every request path</li>
              <li>Services that trust any caller because "the gateway checked"</li>
            </ul>
          </div>
        </>
      }
    >
      <DiagramCanvas layout={LAYOUT} edges={edges} particles={particles} height={460} className="bg-canvas">
        <ArchNode kind="client" title="Client" subtitle={endpoint} placed={LAYOUT.client} compact />
        <ArchNode
          kind="api-gateway"
          title="API Gateway x2"
          subtitle="auth - limits - routing"
          placed={LAYOUT.gateway}
        >
          {stages.map((stage, index) => (
            <NodeStatRow
              key={stage.id}
              label={stage.label.replace(' check', '').replace(' validation', '')}
              value={stage.status === 'reject' ? 'reject' : stage.status === 'skipped' ? 'off' : 'ok'}
              tone={
                index === stageIndex
                  ? 'text-brand'
                  : stage.status === 'reject'
                    ? 'text-danger'
                    : stage.status === 'skipped'
                      ? 'text-faint'
                      : 'text-ok'
              }
            />
          ))}
        </ArchNode>
        <ArchNode kind="service" title="Users Service" placed={LAYOUT.users} compact selected={target === 'users'} />
        <ArchNode kind="service" title="Orders Service" placed={LAYOUT.orders} compact selected={target === 'orders'} />
        <ArchNode kind="service" title="Payments Service" placed={LAYOUT.payments} compact selected={target === 'payments'} />
      </DiagramCanvas>
    </LabShell>
  );
}

export default ApiGatewayLab;
