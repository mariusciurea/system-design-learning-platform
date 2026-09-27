import { useCallback, useMemo, useRef, useState } from 'react';
import { ArchNode, DiagramCanvas, NodeStatRow, ParticleLegend, type DiagramEdge, type Layout, type ParticleView } from '@/components/architecture';
import { Insight, LabShell, MetricsPanel, SIMULATED_HINT } from '@/components/learning';
import { SegmentedControl, Toggle } from '@/components/ui';
import { advanceParticles, nextParticleId, useEventLog, useTicker, type Particle } from '@/simulations/engine';
import { useRerender } from '@/hooks/useRerender';
import { cn } from '@/utils/cn';
import { formatNumber } from '@/utils/format';
import type { LabFocus, LabProps, RequestOutcome } from '@/types';
import { useLabRunning } from '@/hooks/useLabRunning';

/*
 * The Auth Lab: one request path with two checkpoints. The API gateway asks
 * "who are you?" (authentication, 401 when it cannot tell) and the invoices
 * service asks "may you do this to this invoice?" (authorization, 403 - or 404
 * when the service hides that the invoice exists).
 *
 * The gateway knows three kinds of credential: a session cookie (looked up in
 * the session store), an API key (its hash looked up in the key store) and a
 * bearer access token - a JWT the gateway verifies on its own with the public
 * key of the issuer, fetched once and cached, so no lookup runs per request.
 *
 * Simplified model: a fixed cast of callers, one gateway, one service and two
 * invoices. The 30 minute idle timeout, the 15 minute token life, the key names
 * and the rules are illustrative. The counters count the simulated requests on this canvas - they
 * are not measurements.
 */

type CallerId =
  | 'anonymous'
  | 'alice'
  | 'alice-expired'
  | 'guessed'
  | 'bob'
  | 'alice-token'
  | 'alice-token-expired'
  | 'integration'
  | 'attacker';
type RequestId = 'read-own' | 'read-other' | 'delete-own';
type KeyState = 'active' | 'revoked' | 'rotated';
type Checkpoint = 'gateway' | 'service';

interface Caller {
  /** Button text in the controls. */
  label: string;
  /** Title on the client node. */
  title: string;
  credential: 'none' | 'session' | 'key' | 'token';
  /** Who the caller really is, for the insight - the gateway may believe otherwise. */
  tenant: number;
  role: 'member' | 'admin' | null;
  /** The identity a valid credential proves. */
  identity: string;
}

const CALLERS: Record<CallerId, Caller> = {
  anonymous: { label: 'Anonymous - no credential', title: 'Anonymous', credential: 'none', tenant: 0, role: null, identity: '' },
  alice: { label: 'Alice - valid session cookie', title: 'Alice', credential: 'session', tenant: 3, role: 'member', identity: 'Alice (user 42)' },
  'alice-expired': {
    label: 'Alice - session expired',
    title: 'Alice',
    credential: 'session',
    tenant: 3,
    role: 'member',
    identity: 'Alice (user 42)',
  },
  guessed: { label: 'Guessed session id', title: 'Guesser', credential: 'session', tenant: 0, role: null, identity: '' },
  bob: { label: 'Bob - admin, valid session', title: 'Bob', credential: 'session', tenant: 3, role: 'admin', identity: 'Bob (user 7)' },
  'alice-token': {
    label: 'Alice app - access token (JWT)',
    title: 'Alice',
    credential: 'token',
    tenant: 3,
    role: 'member',
    identity: 'Alice (user 42)',
  },
  'alice-token-expired': {
    label: 'Alice app - access token expired',
    title: 'Alice',
    credential: 'token',
    tenant: 3,
    role: 'member',
    identity: 'Alice (user 42)',
  },
  integration: { label: 'Integration A - API key', title: 'Integration A', credential: 'key', tenant: 3, role: null, identity: 'Integration A' },
  attacker: {
    label: 'Attacker - leaked key of Integration A',
    title: 'Attacker',
    credential: 'key',
    tenant: 0,
    role: null,
    identity: 'Integration A',
  },
};

const CALLER_ORDER: CallerId[] = [
  'anonymous',
  'alice',
  'alice-expired',
  'guessed',
  'bob',
  'alice-token',
  'alice-token-expired',
  'integration',
  'attacker',
];

interface InvoiceRequest {
  label: string;
  method: 'GET' | 'DELETE';
  invoice: number;
  /** Tenant that owns the invoice. */
  tenant: number;
}

const REQUESTS: Record<RequestId, InvoiceRequest> = {
  'read-own': { label: 'GET /invoices/4711', method: 'GET', invoice: 4711, tenant: 3 },
  'read-other': { label: 'GET /invoices/9182', method: 'GET', invoice: 9182, tenant: 7 },
  'delete-own': { label: 'DELETE /invoices/4711', method: 'DELETE', invoice: 4711, tenant: 3 },
};

const REQUEST_ORDER: RequestId[] = ['read-own', 'read-other', 'delete-own'];

/** The key Integration A was issued first - and the one that leaked. */
const OLD_KEY = 'sk_live_9f2c';
/** The key issued by a rotation. Only Integration A has it. */
const NEW_KEY = 'sk_live_77e1';
/** Illustrative access token life. Real issuers pick their own, usually minutes to an hour. */
const TOKEN_LIFE_MIN = 15;
/** The scope the token of the Alice app carries. The role and the tenant are claims in the token too. */
const TOKEN_SCOPE = 'invoices:read invoices:write';

interface Setup {
  caller: CallerId;
  request: RequestId;
  /** The service compares the tenant of the invoice with the tenant of the caller. */
  ownershipCheck: boolean;
  /** Answer 404 instead of 403 for an invoice of another tenant. */
  hideExistence: boolean;
  keyState: KeyState;
}

/** What the lab opens on at /labs/auth, with no Lab focus: a normal, allowed request. */
const DEFAULT_SETUP: Setup = {
  caller: 'alice',
  request: 'read-own',
  ownershipCheck: true,
  hideExistence: false,
  keyState: 'active',
};

/**
 * The Lab focus of each Concept that hosts this lab. Authentication opens on a
 * caller with no credential, so the first thing on screen is a 401 bouncing off
 * the gateway. Authorization opens on a logged-in Alice asking for the invoice
 * of another tenant, so the 403 comes from the service, after identity passed.
 * API keys opens on the attacker holding a leaked key, served as if it were
 * Integration A, with the revoke and rotate control one click away.
 */
const FOCUS_SETUPS: Record<LabFocus<'auth'>, Setup> = {
  authentication: { ...DEFAULT_SETUP, caller: 'anonymous' },
  authorization: { ...DEFAULT_SETUP, caller: 'alice', request: 'read-other' },
  'api-keys': { ...DEFAULT_SETUP, caller: 'attacker', request: 'read-own' },
};

type CheckResult = 'pass' | 'fail' | 'skip' | 'leak';

interface Check {
  label: string;
  at: Checkpoint;
  result: CheckResult;
  detail: string;
}

interface Decision {
  status: 200 | 401 | 403 | 404;
  /** Where the answer is decided - the node the response starts from. */
  at: Checkpoint;
  /** Who the gateway believes is calling, or null when it cannot tell. */
  identity: string | null;
  store: 'sessions' | 'keys' | null;
  reachesService: boolean;
  reachesDb: boolean;
  /** Answered 200, but to someone who should not have the data. */
  leak: 'idor' | 'stolen-key' | null;
  /** The credential the caller sends, as the client node shows it. */
  credentialText: string;
  checks: Check[];
}

const STATUS_TEXT: Record<Decision['status'], string> = {
  200: '200 OK',
  401: '401 Unauthorized',
  403: '403 Forbidden',
  404: '404 Not Found',
};

/** The two checkpoints, in order, applied to one request. Pure: the ticker and the controls both call it. */
function evaluate(setup: Setup): Decision {
  const caller = CALLERS[setup.caller];
  const request = REQUESTS[setup.request];
  const checks: Check[] = [];
  const keyUsed = setup.caller === 'integration' && setup.keyState === 'rotated' ? NEW_KEY : OLD_KEY;
  const credentialText =
    caller.credential === 'none'
      ? 'no credential'
      : caller.credential === 'key'
        ? `key ${keyUsed}`
        : caller.credential === 'token'
          ? 'Bearer eyJhbGci...'
          : setup.caller === 'guessed'
            ? 'cookie sid=0000...'
            : 'cookie sid=7f3a...';
  const base = { credentialText, checks };

  // Checkpoint 1, at the gateway: is there a credential at all?
  if (caller.credential === 'none') {
    checks.push({ label: 'Credential sent', at: 'gateway', result: 'fail', detail: 'No cookie and no Authorization header.' });
    return { ...base, status: 401, at: 'gateway', identity: null, store: null, reachesService: false, reachesDb: false, leak: null };
  }
  checks.push({ label: 'Credential sent', at: 'gateway', result: 'pass', detail: credentialText });

  // Checkpoint 1, at the gateway: does the credential prove an identity?
  // A token is verified locally with the cached public key of the issuer: no store lookup.
  const store = caller.credential === 'session' ? 'sessions' : caller.credential === 'key' ? 'keys' : null;
  let invalid: string | null = null;
  if (setup.caller === 'alice-expired') invalid = 'Session found, but idle 45 min - past the 30 min timeout.';
  else if (setup.caller === 'alice-token-expired')
    invalid = 'Signature checks out with the issuer public key, but the exp claim passed 5 min ago.';
  else if (setup.caller === 'guessed') invalid = 'No session with this id in the store.';
  else if (caller.credential === 'key' && keyUsed === OLD_KEY && setup.keyState !== 'active')
    invalid = `The hash of ${OLD_KEY} matches a key that was ${setup.keyState === 'rotated' ? 'rotated out' : 'revoked'}.`;
  if (invalid) {
    checks.push({ label: 'Credential valid', at: 'gateway', result: 'fail', detail: invalid });
    return { ...base, status: 401, at: 'gateway', identity: null, store, reachesService: false, reachesDb: false, leak: null };
  }
  checks.push({
    label: 'Credential valid',
    at: 'gateway',
    result: 'pass',
    detail:
      caller.credential === 'key'
        ? `Hash of ${keyUsed} matches ${caller.identity}.`
        : caller.credential === 'token'
          ? `Signature verified with the cached issuer public key, exp in ${TOKEN_LIFE_MIN - 3} min: sub 42, ${caller.identity}. No call to the issuer.`
          : `Session found: ${caller.identity}.`,
  });
  const identity = caller.identity;
  // The gateway cannot tell who holds a key: possession is the whole credential.
  const stolen = setup.caller === 'attacker';
  const failAt = (status: 403 | 404, at: Checkpoint, reachesDb: boolean): Decision => ({
    ...base,
    status,
    at,
    identity,
    store,
    reachesService: at === 'service',
    reachesDb,
    leak: null,
  });

  // Checkpoint 2 starts at the gateway for keys: a coarse scope check needs no data.
  if (caller.credential === 'key') {
    if (request.method === 'DELETE') {
      checks.push({ label: 'Scope allows it', at: 'gateway', result: 'fail', detail: 'Key scope is invoices:read - DELETE needs invoices:write.' });
      return failAt(403, 'gateway', false);
    }
    checks.push({ label: 'Scope allows it', at: 'gateway', result: 'pass', detail: 'Key scope invoices:read allows GET.' });
  } else if (caller.credential === 'token') {
    checks.push({ label: 'Scope allows it', at: 'gateway', result: 'pass', detail: `Token scope ${TOKEN_SCOPE} allows ${request.method}.` });
  } else {
    checks.push({ label: 'Scope allows it', at: 'gateway', result: 'skip', detail: 'A session has no scope - the service checks the role.' });
  }

  // Checkpoint 2, in the service: does the role allow this action?
  // A session keeps the role in the store; a token carries it as a signed claim.
  if (caller.credential === 'session' || caller.credential === 'token') {
    if (request.method === 'DELETE' && caller.role !== 'admin') {
      checks.push({ label: 'Role allows it', at: 'service', result: 'fail', detail: 'A member may read invoices; only an admin may delete.' });
      return failAt(403, 'service', false);
    }
    checks.push({
      label: 'Role allows it',
      at: 'service',
      result: 'pass',
      detail: `Role ${caller.role}${caller.credential === 'token' ? ' (a claim in the token)' : ''} may ${request.method === 'GET' ? 'read' : 'delete'}.`,
    });
  } else {
    checks.push({ label: 'Role allows it', at: 'service', result: 'skip', detail: 'A key has scopes, not roles - checked at the gateway.' });
  }

  // Checkpoint 2, in the service: does this invoice belong to the tenant of the caller?
  // It needs the invoice row, so it runs after the database read.
  const callerTenant = stolen ? 3 : caller.tenant;
  if (request.tenant !== callerTenant) {
    if (setup.ownershipCheck) {
      checks.push({
        label: 'Invoice is theirs',
        at: 'service',
        result: 'fail',
        detail: `Invoice ${request.invoice} is tenant ${request.tenant}; the caller is tenant ${callerTenant}.`,
      });
      return failAt(setup.hideExistence ? 404 : 403, 'service', true);
    }
    checks.push({
      label: 'Invoice is theirs',
      at: 'service',
      result: 'leak',
      detail: `Check is off: invoice of tenant ${request.tenant} sent to tenant ${callerTenant}.`,
    });
    return { ...base, status: 200, at: 'service', identity, store, reachesService: true, reachesDb: true, leak: 'idor' };
  }
  checks.push({
    label: 'Invoice is theirs',
    at: 'service',
    result: setup.ownershipCheck ? 'pass' : 'skip',
    detail: setup.ownershipCheck ? `Invoice ${request.invoice} is tenant ${request.tenant}, like the caller.` : 'Check is off - it happens to be theirs.',
  });
  return { ...base, status: 200, at: 'service', identity, store, reachesService: true, reachesDb: true, leak: stolen ? 'stolen-key' : null };
}

/** The hops a request walks to the checkpoint that answers it, and the way the answer walks back. */
function routesFor(decision: Decision) {
  const request = ['client', 'gateway'];
  if (decision.store) request.push(decision.store, 'gateway');
  if (decision.reachesService) request.push('service');
  if (decision.reachesDb) request.push('db', 'service');
  const response = decision.at === 'gateway' ? ['gateway', 'client'] : ['service', 'gateway', 'client'];
  return { request, response };
}

const responseOutcome = (decision: Decision): RequestOutcome =>
  decision.status !== 200 ? 'failure' : decision.leak ? 'warning' : 'success';

interface Counts {
  ok: number;
  leaked: number;
  unauthorized: number;
  forbidden: number;
}

interface SimState {
  particles: Particle[];
  spawnCarry: number;
  counts: Counts;
}

/** One request leaves the client every 0.9 s - slow enough to follow a single one. */
const SPAWN_EVERY_S = 0.9;
const LEGS_PER_SECOND = 1.35;

const createState = (): SimState => ({
  particles: [],
  // Starts full, so the first request leaves as soon as the lab runs.
  spawnCarry: SPAWN_EVERY_S,
  counts: { ok: 0, leaked: 0, unauthorized: 0, forbidden: 0 },
});

// The three identity sources sit under the gateway, so each wire leaves its bottom edge.
// Heights fit the stat rows each card holds (a card grows past its box otherwise), and the
// row centres stay on one line so the request wires run straight.
const LAYOUT: Layout = {
  client: { x: 20, y: 130, w: 190, h: 110 },
  gateway: { x: 270, y: 98, w: 220, h: 175 },
  service: { x: 550, y: 105, w: 220, h: 160 },
  db: { x: 800, y: 120, w: 150, h: 130 },
  sessions: { x: 70, y: 345, w: 195, h: 130 },
  keys: { x: 280, y: 345, w: 195, h: 130 },
  issuer: { x: 490, y: 345, w: 195, h: 130 },
};

export function AuthLab({ focus }: LabProps<'auth'>) {
  // The page keys this lab by Concept, so the focus never changes under a mounted lab.
  const start = focus ? FOCUS_SETUPS[focus] : DEFAULT_SETUP;
  // Every control lives in one object, so Reset cannot miss one.
  const [setup, setSetup] = useState(start);
  const [running, setRunning] = useLabRunning();
  const state = useRef<SimState>(createState());
  const rerender = useRerender(30);
  const { events, log, clear } = useEventLog();

  const decision = useMemo(() => evaluate(setup), [setup]);
  const caller = CALLERS[setup.caller];
  const request = REQUESTS[setup.request];

  const describe = useCallback((next: Setup) => {
    const result = evaluate(next);
    const where = result.at === 'gateway' ? 'the gateway' : 'the invoices service';
    const tone = result.leak ? 'danger' : result.status === 200 ? 'ok' : 'warn';
    return {
      message: `${CALLERS[next.caller].title}: ${REQUESTS[next.request].label} -> ${STATUS_TEXT[result.status]} from ${where}${
        result.leak ? ' - served to the wrong caller' : ''
      }`,
      tone,
    } as const;
  }, []);

  const change = <K extends keyof Setup>(key: K) => (value: Setup[K]) => {
    const next = { ...setup, [key]: value };
    setSetup(next);
    // In-flight requests carry the old answer; clear them so the canvas shows the new one at once.
    state.current.particles = [];
    state.current.spawnCarry = SPAWN_EVERY_S;
    const { message, tone } = describe(next);
    log(message, tone);
  };

  const reset = () => {
    // Back to this Concept's starting setup, not the lab's global default.
    setSetup(start);
    state.current = createState();
    clear();
  };

  useTicker(running, (dt) => {
    const current = state.current;
    current.spawnCarry += dt;
    if (current.spawnCarry >= SPAWN_EVERY_S) {
      current.spawnCarry -= SPAWN_EVERY_S;
      current.particles.push({
        id: nextParticleId(),
        route: routesFor(decision).request,
        leg: 0,
        t: 0,
        speed: LEGS_PER_SECOND,
        outcome: 'success',
        meta: { phase: 'request' },
      });
    }

    const { alive, finished } = advanceParticles(current.particles, dt);
    for (const particle of finished) {
      if (particle.meta?.phase !== 'request') continue;
      // The request reached the checkpoint that answers it: count the answer there, send it back.
      if (decision.status === 401) current.counts.unauthorized += 1;
      else if (decision.status !== 200) current.counts.forbidden += 1;
      else if (decision.leak) current.counts.leaked += 1;
      else current.counts.ok += 1;
      alive.push({
        id: nextParticleId(),
        route: routesFor(decision).response,
        leg: 0,
        t: 0,
        speed: LEGS_PER_SECOND,
        outcome: responseOutcome(decision),
        meta: { phase: 'response' },
      });
    }
    current.particles = alive.slice(-40);
    rerender();
  });

  const particleViews: ParticleView[] = state.current.particles.map((particle) => ({
    id: particle.id,
    from: particle.route[particle.leg],
    to: particle.route[particle.leg + 1],
    t: particle.t,
    outcome: particle.outcome ?? 'success',
  }));

  // Wires the current request does not use fade, so the path it takes stands out.
  const edges: DiagramEdge[] = [
    { from: 'client', to: 'gateway', tone: 'brand', width: 2 },
    { from: 'gateway', to: 'sessions', tone: 'violet', faded: decision.store !== 'sessions', label: 'session lookup', labelT: 0.65 },
    { from: 'gateway', to: 'keys', tone: 'violet', faded: decision.store !== 'keys', label: 'key hash lookup' },
    // Dashed: the public key was fetched once and cached. No request travels this wire.
    {
      from: 'gateway',
      to: 'issuer',
      tone: 'violet',
      dashed: true,
      faded: caller.credential !== 'token',
      label: 'public key, cached',
      labelT: 0.65,
    },
    { from: 'gateway', to: 'service', tone: 'brand', faded: !decision.reachesService },
    { from: 'service', to: 'db', tone: 'default', faded: !decision.reachesDb },
  ];

  const counts = state.current.counts;
  const rejectedAt = decision.status === 200 ? null : decision.at;
  const keyRows = [
    { key: OLD_KEY, state: setup.keyState === 'active' ? 'active' : setup.keyState === 'revoked' ? 'revoked' : 'rotated out' },
    { key: NEW_KEY, state: setup.keyState === 'rotated' ? 'active' : 'not issued' },
  ];

  return (
    <LabShell
      title="Auth Lab"
      description="One request, two checkpoints. The gateway asks who is calling - by session, API key or access token - and answers 401 when it cannot tell; the service asks whether that caller may do this to this invoice (403 when not)."
      running={running}
      onRunningChange={setRunning}
      onReset={reset}
      legend={
        <ParticleLegend
          outcomes={[
            { outcome: 'success', label: 'Request or 200 answer' },
            { outcome: 'warning', label: '200 to the wrong caller' },
            { outcome: 'failure', label: '401, 403 or 404 answer' },
          ]}
        />
      }
      events={events}
      insight={<Insight>{insightFor(setup, decision)}</Insight>}
      metrics={
        <>
          <MetricsPanel
            items={[
              {
                key: 'status',
                label: 'Response',
                value: STATUS_TEXT[decision.status],
                tone: decision.leak ? 'danger' : decision.status === 200 ? 'ok' : 'warn',
                hint: 'What the caller gets back for the request in the controls.',
              },
              {
                key: 'decided',
                label: 'Answered by',
                value: decision.at === 'gateway' ? 'Gateway' : 'Service',
                hint: 'The checkpoint that decided: the gateway checks identity, the service checks permission on the data.',
              },
              {
                key: 'identity',
                label: 'Gateway believes',
                value: decision.identity ?? 'unknown',
                tone: setup.caller === 'attacker' && decision.identity ? 'danger' : 'neutral',
                hint: 'The identity the credential proved. A key or a bearer token proves only that the caller holds it.',
              },
              { key: 'ok', label: '200 to the right caller', value: formatNumber(counts.ok), tone: 'ok', simulated: true },
              { key: 'unauthorized', label: '401 sent', value: formatNumber(counts.unauthorized), tone: counts.unauthorized ? 'warn' : 'neutral', simulated: true },
              { key: 'forbidden', label: '403 / 404 sent', value: formatNumber(counts.forbidden), tone: counts.forbidden ? 'warn' : 'neutral', simulated: true },
              {
                key: 'leaked',
                label: '200 to the wrong caller',
                value: formatNumber(counts.leaked),
                tone: counts.leaked ? 'danger' : 'neutral',
                hint: 'Answered with data the caller should not have: an attacker with a leaked key, or another tenant through a missing ownership check.',
                simulated: true,
              },
            ]}
          />
          <div className="card p-4">
            <p className="label mb-3">
              Decision trace: {caller.title}, {request.label}
            </p>
            <ol className="space-y-2">
              {decision.checks.map((check) => (
                <li key={check.label} className="flex items-start gap-3">
                  <span
                    className={cn(
                      'mt-0.5 w-11 shrink-0 rounded px-1.5 py-0.5 text-center font-mono text-[11px] font-semibold',
                      check.result === 'pass' && 'bg-ok/15 text-ok',
                      check.result === 'fail' && 'bg-danger/15 text-danger',
                      check.result === 'leak' && 'bg-warn/15 text-warn',
                      check.result === 'skip' && 'bg-line text-faint',
                    )}
                  >
                    {check.result.toUpperCase()}
                  </span>
                  <span className="min-w-0 text-xs">
                    <span className="font-medium text-ink">{check.label}</span>
                    <span className="text-faint"> - {check.at === 'gateway' ? 'gateway' : 'service'}</span>
                    <span className="block text-muted">{check.detail}</span>
                  </span>
                </li>
              ))}
              <li className="flex items-start gap-3 border-t border-line pt-2">
                <span className="mt-0.5 w-11 shrink-0 rounded bg-elevated px-1.5 py-0.5 text-center font-mono text-[11px] font-semibold text-ink">
                  {decision.status}
                </span>
                <span className="text-xs text-muted">
                  {STATUS_TEXT[decision.status]} from the {decision.at === 'gateway' ? 'gateway' : 'invoices service'}
                  {decision.status === 401 ? ', with a WWW-Authenticate header saying how to authenticate.' : '.'}
                </span>
              </li>
            </ol>
            <p className="mt-3 text-xs text-faint">
              {SIMULATED_HINT} A fixed cast of callers, one gateway, one service and two invoices. The
              30 min idle timeout, the {TOKEN_LIFE_MIN} min token life and the key names are illustrative, and the counters
              count the requests on this canvas.
            </p>
          </div>
        </>
      }
      controls={
        <>
          <OptionList
            title="Caller"
            value={setup.caller}
            options={CALLER_ORDER.map((id) => ({ value: id, label: CALLERS[id].label }))}
            onChange={change('caller')}
          />
          <OptionList
            title="Request"
            value={setup.request}
            options={REQUEST_ORDER.map((id) => ({
              value: id,
              label: `${REQUESTS[id].label} (tenant ${REQUESTS[id].tenant})`,
            }))}
            onChange={change('request')}
          />
          <Toggle
            label="Ownership check"
            checked={setup.ownershipCheck}
            onChange={change('ownershipCheck')}
            description="The service compares the tenant of the invoice with the tenant of the caller"
          />
          <Toggle
            label="Hide other tenants with 404"
            checked={setup.hideExistence}
            onChange={change('hideExistence')}
            disabled={!setup.ownershipCheck}
            description="Answer 404 instead of 403, so the caller cannot learn the invoice exists"
          />
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted">Key {OLD_KEY} of Integration A</p>
            <SegmentedControl
              size="sm"
              className="w-full"
              value={setup.keyState}
              options={[
                { value: 'active', label: 'Active' },
                { value: 'revoked', label: 'Revoked' },
                { value: 'rotated', label: 'Rotated' },
              ]}
              onChange={change('keyState')}
            />
            <p className="text-[11px] text-faint">
              Revoked: the key stops working for everyone who holds it. Rotated: Integration A got {NEW_KEY} first, then
              the old key was revoked.
            </p>
          </div>
        </>
      }
    >
      <DiagramCanvas layout={LAYOUT} edges={edges} particles={particleViews} height={485} className="bg-canvas">
        <ArchNode kind="client" title={caller.title} subtitle={decision.credentialText} placed={LAYOUT.client}>
          <NodeStatRow label="Sends" value={`${request.method} ${request.invoice}`} />
        </ArchNode>
        <ArchNode
          kind="api-gateway"
          title="API Gateway"
          subtitle="Identity check: who?"
          placed={LAYOUT.gateway}
          alert={rejectedAt === 'gateway'}
        >
          <NodeStatRow
            label="Identity"
            value={decision.identity ?? 'unknown'}
            tone={decision.identity ? (setup.caller === 'attacker' ? 'text-danger' : 'text-ok') : 'text-danger'}
          />
          <NodeStatRow label="Checked with" value={CHECKED_WITH[caller.credential]} />
          <NodeStatRow label="401 sent" value={formatNumber(counts.unauthorized)} tone={counts.unauthorized ? 'text-warn' : 'text-ink'} />
          <NodeStatRow label="Answer" value={decision.at === 'gateway' ? String(decision.status) : 'passes on'} />
        </ArchNode>
        <ArchNode
          kind="service"
          title="Invoices service"
          subtitle="Permission check: may they?"
          placed={LAYOUT.service}
          alert={rejectedAt === 'service'}
          status={decision.leak === 'idor' ? 'degraded' : 'healthy'}
          statusLabel={decision.leak === 'idor' ? 'Leaking' : undefined}
        >
          <NodeStatRow label="Rule" value={setup.ownershipCheck ? 'role + tenant' : 'role only'} tone={setup.ownershipCheck ? 'text-ink' : 'text-danger'} />
          <NodeStatRow label="403 / 404 sent" value={formatNumber(counts.forbidden)} tone={counts.forbidden ? 'text-warn' : 'text-ink'} />
          <NodeStatRow label="Answer" value={decision.reachesService ? String(decision.status) : 'not reached'} />
        </ArchNode>
        <ArchNode kind="sql" title="Invoices DB" subtitle="rows by tenant" placed={LAYOUT.db}>
          <NodeStatRow label="4711" value="tenant 3" />
          <NodeStatRow label="9182" value="tenant 7" />
        </ArchNode>
        <ArchNode kind="cache" title="Session store" subtitle="idle timeout 30 min" placed={LAYOUT.sessions}>
          <NodeStatRow label="sid=7f3a..." value="user 42" />
          <NodeStatRow label="sid=0000..." value="not found" tone="text-faint" />
        </ArchNode>
        <ArchNode kind="sql" title="API key store" subtitle="SHA-256 hashes only" placed={LAYOUT.keys}>
          {keyRows.map((row) => (
            <NodeStatRow
              key={row.key}
              label={row.key}
              value={row.state}
              tone={row.state === 'active' ? 'text-ok' : row.state === 'not issued' ? 'text-faint' : 'text-danger'}
            />
          ))}
        </ArchNode>
        <ArchNode kind="service" title="Token issuer" subtitle="signed the token at login" placed={LAYOUT.issuer}>
          <NodeStatRow label="Signs with" value="private key" />
          <NodeStatRow label="Token life" value={`${TOKEN_LIFE_MIN} min`} />
        </ArchNode>
      </DiagramCanvas>
    </LabShell>
  );
}

/** What the gateway checks the credential against - the identity wire that lights up. */
const CHECKED_WITH: Record<Caller['credential'], string> = {
  none: 'nothing',
  session: 'session store',
  key: 'key store',
  token: 'public key',
};

/** What to notice for the current setup, in the words of the Concept it teaches. */
function insightFor(setup: Setup, decision: Decision) {
  const caller = CALLERS[setup.caller];
  if (decision.status === 401) {
    if (caller.credential === 'none')
      return 'The gateway answers 401 Unauthorized before any business code runs: there is no credential, so there is no identity to check permissions for. A 401 means "we do not know who you are" - pick a caller with a valid session or key and the same request goes through. Nothing reached the service or the database.';
    if (caller.credential === 'token')
      return 'The signature is fine - the issuer really did sign this token for Alice - but its exp claim is in the past, so the gateway answers 401 Unauthorized with error="invalid_token". The app does not ask Alice for her password again: it sends its refresh token to the issuer, gets a new access token and retries. The gateway decided alone, with the cached public key; the issuer was not called.';
    if (caller.credential === 'key')
      return setup.caller === 'integration'
        ? 'Revoking cut off the attacker - and Integration A with it, because both hold the same string. Switch the key to Rotated: Integration A gets a second key first, then the old one is revoked, so only the holder of the leaked key is left with a 401.'
        : 'The leaked key now gets 401 Unauthorized: the hash still matches a row in the key store, but that row is no longer active. Pick Integration A to see who still gets in after this change.';
    return `The gateway looked the session up and could not accept it (${
      setup.caller === 'alice-expired' ? 'it expired after 30 min idle' : 'no such session id exists'
    }), so it answers 401 Unauthorized. The fix is to authenticate again - which is exactly what a 401 tells the client. The permission check in the service never runs.`;
  }
  if (decision.status === 403 && decision.at === 'gateway')
    return 'The key is valid, so identity passed - but its scope is invoices:read and this is a DELETE. The gateway can refuse this with 403 Forbidden on its own, because a scope needs no invoice data. Scoped keys are what keep a leaked key from becoming a full-account incident.';
  if (decision.status === 403 || decision.status === 404) {
    const byRole = REQUESTS[setup.request].method === 'DELETE' && caller.role !== 'admin';
    if (byRole)
      return `${caller.title} is authenticated - the gateway knows exactly who this is - but a member may not delete. The service answers 403 Forbidden. Logging in again would not help: identity is not the problem, permission is. Pick Bob, an admin, and the same DELETE succeeds.`;
    return `Identity passed at the gateway, so this is not a 401. The service read invoice ${REQUESTS[setup.request].invoice}, saw it belongs to tenant ${
      REQUESTS[setup.request].tenant
    }, and refused with ${STATUS_TEXT[decision.status]}${
      decision.status === 404 ? ', which does not even confirm the invoice exists' : ''
    }. Only the service can make this decision: it needs the invoice row. Turn the ownership check off to see what one missing clause costs.`;
  }
  if (decision.leak === 'idor')
    return 'The ownership check is off, so the service checked only the role and returned the invoice of another tenant with 200 OK. This is broken object level authorization (IDOR) - number one in the OWASP API Security Top 10. Nothing in the logs looks wrong, which is why it is found by attackers rather than by alerts.';
  if (decision.leak === 'stolen-key')
    return 'The gateway sees a valid key and believes this is Integration A - it cannot tell otherwise, because possession of an API key is the whole credential. The attacker reads invoices of tenant 3 with 200 OK. Revoke or rotate the key to cut it off; note the attacker still cannot DELETE, because the key is scoped to invoices:read.';
  if (caller.credential === 'token' && decision.status === 200)
    return 'The gateway verified the signature of the access token with the public key of the issuer, which it fetched once and cached, then read the claims: who (sub 42), until when (exp) and what (scope, role, tenant). No store lookup on the request path - the dashed wire carries no traffic. The cost: the gateway cannot see a revocation until the token expires, which is why access tokens live minutes, not days. Pick the expired token to see the 401.';
  return `${caller.title} proved an identity at the gateway (401 avoided) and had permission in the service (403 avoided), so the answer is 200 OK. Two separate questions, asked at two places on the path. Now change the caller or the invoice and watch which checkpoint says no.`;
}

interface OptionListProps<T extends string> {
  title: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}

function OptionList<T extends string>({ title, value, options, onChange }: OptionListProps<T>) {
  return (
    <div className="space-y-2">
      <p className="text-xs font-medium text-muted">{title}</p>
      <div className="space-y-1.5">
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            aria-pressed={value === option.value}
            onClick={() => onChange(option.value)}
            className={cn(
              'w-full rounded-lg border px-3 py-1.5 text-left text-xs font-medium transition-colors',
              value === option.value ? 'border-brand bg-brand/10 text-brand' : 'border-line text-muted hover:border-brand/50 hover:text-ink',
            )}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export default AuthLab;
