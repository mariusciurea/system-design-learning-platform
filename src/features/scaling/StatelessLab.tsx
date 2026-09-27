import { useCallback, useRef } from 'react';
import { Ban, Power, RotateCw, UserCheck } from 'lucide-react';
import {
  ArchNode,
  DiagramCanvas,
  NodeStatRow,
  ParticleLegend,
  spread,
  type DiagramEdge,
  type Layout,
  type ParticleView,
} from '@/components/architecture';
import { Insight, LabShell, MetricsPanel } from '@/components/learning';
import { Button, Slider, Toggle } from '@/components/ui';
import { advanceParticles, nextParticleId, useEventLog, useTicker, type Particle } from '@/simulations/engine';
import { useLabSetup } from '@/hooks/useLabSetup';
import { useRerender } from '@/hooks/useRerender';
import { sampleArrivals } from '@/utils/math';
import { formatLatency, formatNumber, formatPercent } from '@/utils/format';
import type { LabFocus, LabProps, NodeStatus } from '@/types';
import { useLabRunning } from '@/hooks/useLabRunning';

type Mode = 'local' | 'sticky' | 'shared' | 'jwt';

const MODES: { value: Mode; label: string }[] = [
  { value: 'local', label: 'Local sessions' },
  { value: 'sticky', label: 'Sticky sessions' },
  { value: 'shared', label: 'Shared store' },
  { value: 'jwt', label: 'Stateless JWT' },
];

const MODE_NOTE: Record<Mode, string> = {
  local:
    'Sessions live in the memory of whichever server handled the login. Round robin sends the next request somewhere else, and that server has never heard of this user - so about two requests in three find no session.',
  sticky:
    'The load balancer pins each user to one server, so sessions are found - until that server dies and takes the sessions of its users with it. Kill a server and watch its users log in again. Load also becomes uneven.',
  shared:
    'Sessions live in Redis. Any server can serve any user and any server can die without logging anyone out, at the cost of one network hop per request and a new critical dependency - try Kill Redis.',
  jwt: 'The client carries a signed token. Every server checks the signature locally with the same key - no lookup, no shared store, and killing a server logs nobody out. The trade: revoking a token before it expires needs extra state. Try Revoke user A.',
};

const USERS = ['A', 'B', 'C', 'D', 'E', 'F'];
/** The user the Revoke control logs out. Their stolen copy keeps sending requests. */
const REVOKED_USER = 'A';

/** Every control of the lab, in one object so Reset cannot miss one. */
interface Setup {
  mode: Mode;
  traffic: number;
  /** JWT only: check a Redis denylist of revoked token ids on every request. */
  denylist: boolean;
  /** JWT only: access token lifetime in minutes, played back at 1 minute per second. */
  tokenMinutes: number;
}

/** What the lab opens on at /labs/stateless, with no Lab focus: the naive setup that breaks. */
const DEFAULT_SETUP: Setup = { mode: 'local', traffic: 6, denylist: false, tokenMinutes: 15 };

/**
 * The Lab focus of each Concept that hosts this lab. Stateless applications
 * opens on the shared session store; Stateful applications on sessions held
 * inside each instance (sticky, so the loss shows the moment a server dies);
 * JWT on a signed token any instance can verify.
 */
const FOCUS_SETUPS: Record<LabFocus<'stateless'>, Setup> = {
  'stateless-applications': { ...DEFAULT_SETUP, mode: 'shared' },
  'stateful-applications': { ...DEFAULT_SETUP, mode: 'sticky' },
  jwt: { ...DEFAULT_SETUP, mode: 'jwt' },
};

interface ServerModel {
  id: string;
  name: string;
  status: NodeStatus;
  /** Session ids held in local memory (local and sticky modes only). */
  sessions: Set<string>;
  handled: number;
}

interface RequestRow {
  id: number;
  user: string;
  server: string;
  result: 'ok' | 'lost' | 'blocked' | 'leaked';
  detail: string;
}

interface Revocation {
  /** Simulated seconds on the lab clock when the user was revoked. */
  at: number;
}

interface State {
  servers: ServerModel[];
  redisUp: boolean;
  particles: Particle[];
  cursor: number;
  /** Simulated seconds since the lab started. */
  clock: number;
  revoked: Revocation | null;
  ok: number;
  lost: number;
  lookups: number;
  /** Requests from the revoked user that were turned away - the correct outcome. */
  blocked: number;
  /** Requests from the revoked user that were still let in. */
  leaked: number;
  recent: RequestRow[];
}

/** Every user starts logged in, their session on the server round robin gave them. */
const createState = (): State => {
  const servers: ServerModel[] = [0, 1, 2].map((index) => ({
    id: `s${index}`,
    name: `Server ${index + 1}`,
    status: 'healthy',
    sessions: new Set<string>(),
    handled: 0,
  }));
  USERS.forEach((user, index) => servers[index % servers.length].sessions.add(user));
  return {
    servers,
    redisUp: true,
    particles: [],
    cursor: 0,
    clock: 0,
    revoked: null,
    ok: 0,
    lost: 0,
    lookups: 0,
    blocked: 0,
    leaked: 0,
    recent: [],
  };
};

const LAYOUT: Layout = {
  users: { x: 380, y: 14, w: 200, h: 73 },
  lb: { x: 380, y: 130, w: 200, h: 80 },
  s0: { x: 160, y: 256, w: 180, h: 124 },
  s1: { x: 390, y: 256, w: 180, h: 124 },
  s2: { x: 620, y: 256, w: 180, h: 124 },
  redis: { x: 390, y: 408, w: 180, h: 94 },
};

const SESSION_WHERE: Record<Mode, string> = {
  local: '',
  sticky: '',
  shared: 'in Redis',
  jwt: 'in the token',
};

export function StatelessLab({ focus }: LabProps<'stateless'>) {
  // The page keys this lab by Concept, so the focus never changes under a mounted lab.
  const start = focus ? FOCUS_SETUPS[focus] : DEFAULT_SETUP;
  const { setup, setSetup, change } = useLabSetup(start);
  const { mode, traffic, denylist, tokenMinutes } = setup;
  const [running, setRunning] = useLabRunning();
  const state = useRef<State>(createState());
  const rerender = useRerender(30);
  const { events, log, clear } = useEventLog();

  /**
   * Clears the counters but keeps the servers and their sessions. A new session
   * strategy also clears the revocation; the denylist switch keeps it, as if the
   * revocation had been written to the denylist too.
   */
  const resetStats = useCallback((keepRevocation = false) => {
    const current = state.current;
    current.ok = 0;
    current.lost = 0;
    current.lookups = 0;
    current.blocked = 0;
    current.leaked = 0;
    if (!keepRevocation) current.revoked = null;
    current.recent = [];
  }, []);

  const reset = useCallback(() => {
    // Back to this Concept's starting setup, not the lab's global default.
    setSetup(start);
    state.current = createState();
    clear();
  }, [clear, start, setSetup]);

  const login = useCallback(() => {
    const current = state.current;
    const healthy = current.servers.filter((server) => server.status === 'healthy');
    if (healthy.length === 0) return;
    for (const server of current.servers) server.sessions.clear();
    USERS.forEach((user, index) => {
      healthy[index % healthy.length].sessions.add(user);
    });
    current.revoked = null;
    log('All users logged in - a session or token issued by the server that handled each login', 'ok');
    rerender();
  }, [log, rerender]);

  const revoke = useCallback(() => {
    const current = state.current;
    current.revoked = { at: current.clock };
    current.blocked = 0;
    current.leaked = 0;
    // A server-side session can simply be deleted. A JWT has nothing to delete.
    for (const server of current.servers) server.sessions.delete(REVOKED_USER);
    if (mode === 'jwt') {
      log(
        denylist
          ? `User ${REVOKED_USER} revoked - token id added to the Redis denylist`
          : `User ${REVOKED_USER} revoked - but the token stays valid until it expires`,
        denylist ? 'ok' : 'warn',
      );
    } else {
      log(`User ${REVOKED_USER} revoked - session deleted, the stolen cookie is now useless`, 'ok');
    }
    rerender();
  }, [denylist, log, mode, rerender]);

  const toggleServer = useCallback(
    (id: string) => {
      const server = state.current.servers.find((item) => item.id === id);
      if (!server) return;
      if (server.status === 'healthy') {
        server.status = 'down';
        if (server.sessions.size && (mode === 'local' || mode === 'sticky')) {
          log(`${server.name} down - ${server.sessions.size} in-memory session${server.sessions.size > 1 ? 's' : ''} lost`, 'danger');
        } else {
          log(`${server.name} down - no sessions lived there, nobody is logged out`, 'warn');
        }
        server.sessions.clear();
      } else {
        server.status = 'healthy';
        log(`${server.name} back in the pool`, 'ok');
      }
      rerender();
    },
    [log, mode, rerender],
  );

  useTicker(running, (dt) => {
    const current = state.current;
    current.clock += dt;
    const healthy = current.servers.filter((server) => server.status === 'healthy');
    const arrivals = sampleArrivals(traffic, dt);
    const checksRedis = mode === 'shared' || (mode === 'jwt' && denylist);

    for (let index = 0; index < arrivals; index += 1) {
      const user = USERS[Math.floor(Math.random() * USERS.length)];

      if (healthy.length === 0) {
        // Every server is down: the request still arrives and still fails.
        current.lost += 1;
        current.recent.unshift({
          id: nextParticleId(),
          user,
          server: 'no server',
          result: 'lost',
          detail: 'NO HEALTHY SERVER - request failed',
        });
        current.recent = current.recent.slice(0, 8);
        current.particles.push({ id: nextParticleId(), route: ['users', 'lb'], leg: 0, t: 0, speed: 1.1, outcome: 'failure' });
        continue;
      }

      let server: ServerModel;
      if (mode === 'sticky') {
        // The load balancer keeps a user on the server that holds their session
        // (a cookie, in real life). Only users whose server is gone get re-pinned.
        server =
          healthy.find((item) => item.sessions.has(user)) ?? healthy[user.charCodeAt(0) % healthy.length];
      } else {
        current.cursor = (current.cursor + 1) % healthy.length;
        server = healthy[current.cursor];
      }

      let result: RequestRow['result'] = 'ok';
      let detail: string;
      const route: string[] = ['users', 'lb', server.id];
      if (checksRedis) {
        route.push('redis');
        current.lookups += 1;
      }
      const revokedHere = current.revoked !== null && user === REVOKED_USER;

      if (checksRedis && !current.redisUp) {
        // Fail closed: without the store nobody can prove a session (or that a token is not revoked).
        result = 'lost';
        detail =
          mode === 'shared'
            ? 'Redis unavailable - no session store'
            : 'Redis unavailable - denylist unreachable, fail closed';
      } else if (revokedHere && current.revoked) {
        if (mode === 'jwt' && !denylist) {
          const minutesLeft = tokenMinutes - (current.clock - current.revoked.at);
          if (minutesLeft > 0) {
            result = 'leaked';
            detail = `REVOKED token still valid - expires in ${Math.ceil(minutesLeft)} min`;
          } else {
            result = 'blocked';
            detail = 'token expired, refresh token revoked - rejected';
          }
        } else {
          result = 'blocked';
          detail =
            mode === 'jwt'
              ? 'token id on the denylist - rejected'
              : mode === 'shared'
                ? 'session deleted from Redis - rejected'
                : 'session deleted on logout - rejected';
        }
      } else if (mode === 'local') {
        if (server.sessions.has(user)) {
          detail = 'session found in local memory';
        } else {
          result = 'lost';
          detail = 'SESSION NOT FOUND - user logged out';
          // The user logs in again on this server. The new session cookie
          // replaces the old one, so the session on any other server is dead.
          for (const other of current.servers) other.sessions.delete(user);
          server.sessions.add(user);
        }
      } else if (mode === 'sticky') {
        if (server.sessions.has(user)) {
          detail = 'sticky route found the session';
        } else {
          result = 'lost';
          server.sessions.add(user);
          detail = 'SESSION NOT FOUND - re-pinned here, user logs in again';
        }
      } else if (mode === 'shared') {
        detail = 'session loaded from Redis (+1 network hop)';
      } else {
        detail = denylist ? 'signature verified, denylist checked (+1 hop)' : 'signature verified locally, no lookup';
      }

      if (result === 'ok') {
        current.ok += 1;
        server.handled += 1;
      } else if (result === 'lost') {
        current.lost += 1;
      } else if (result === 'blocked') {
        current.blocked += 1;
      } else {
        current.leaked += 1;
        server.handled += 1;
      }

      current.recent.unshift({ id: nextParticleId(), user, server: server.name, result, detail });
      current.recent = current.recent.slice(0, 8);

      current.particles.push({
        id: nextParticleId(),
        route,
        leg: 0,
        t: 0,
        speed: 1.1,
        outcome:
          result === 'ok'
            ? checksRedis
              ? 'cache-hit'
              : 'success'
            : result === 'leaked'
              ? 'warning'
              : 'failure',
      });
    }

    const { alive } = advanceParticles(current.particles, dt);
    current.particles = alive.slice(-60);
    rerender();
  });

  const current = state.current;
  const showRedis = mode === 'shared' || (mode === 'jwt' && denylist);
  const localState = mode === 'local' || mode === 'sticky';
  const total = current.ok + current.lost;
  const successRate = total ? current.ok / total : 1;
  const healthyCount = current.servers.filter((server) => server.status === 'healthy').length;
  const tokenLeft =
    current.revoked && mode === 'jwt' && !denylist
      ? Math.max(0, tokenMinutes - (current.clock - current.revoked.at))
      : 0;

  const layout: Layout = { ...LAYOUT };
  const serverXs = spread(3, 480, 180, 50);
  current.servers.forEach((server, index) => {
    layout[server.id] = { x: serverXs[index], y: 256, w: 180, h: 124 };
  });

  const edges: DiagramEdge[] = [
    { from: 'users', to: 'lb', tone: 'brand', width: 2 },
    ...current.servers.map<DiagramEdge>((server) => ({
      from: 'lb',
      to: server.id,
      tone: server.status === 'healthy' ? 'ok' : 'muted',
      dashed: server.status !== 'healthy',
      label:
        mode === 'sticky' && server.status === 'healthy'
          ? [...server.sessions].slice(0, 3).join(',') || undefined
          : undefined,
    })),
    // Every server talks to Redis, not just the one that happens to be busy -
    // the servers are replicas and are wired identically.
    ...(showRedis
      ? current.servers.map<DiagramEdge>((server) => ({
          from: server.id,
          to: 'redis',
          tone: current.redisUp ? 'ok' : 'muted',
          dashed: !current.redisUp,
        }))
      : []),
  ];

  const particleViews: ParticleView[] = current.particles.map((particle) => ({
    id: particle.id,
    from: particle.route[particle.leg],
    to: particle.route[particle.leg + 1],
    t: particle.t,
    outcome: particle.outcome ?? 'success',
  }));

  const insight = current.revoked ? (
    mode === 'jwt' && !denylist ? (
      tokenLeft > 0 ? (
        <>
          User {REVOKED_USER} was revoked, but a JWT is checked with the key alone - nothing on the servers says
          it was revoked. The stolen token keeps getting in for about {Math.ceil(tokenLeft)} more minutes, until
          its exp claim passes. Shorten the token lifetime to shrink that window, or turn on the denylist check to
          close it at the cost of a Redis lookup on every request.
        </>
      ) : (
        <>
          The revoked token has expired, and the refresh token that could mint a new one was deleted at
          revocation - so it is finally rejected. The exposure window was the access token lifetime:{' '}
          {tokenMinutes} minutes.
        </>
      )
    ) : (
      <>
        User {REVOKED_USER} was revoked and the next request with the stolen credential is rejected at once:{' '}
        {mode === 'jwt'
          ? 'every server checks the denylist in Redis. That lookup per request is exactly what JWT was meant to avoid.'
          : 'the session was stored on the server side, so deleting it is enough.'}
      </>
    )
  ) : (
    MODE_NOTE[mode]
  );

  return (
    <LabShell
      title="Stateless vs Stateful Lab"
      description="Six users, three servers, one load balancer. Switch where the session lives and watch which requests survive a round-robin hop, a dead server or a revoked login."
      running={running}
      onRunningChange={setRunning}
      onReset={reset}
      legend={
        <ParticleLegend
          outcomes={[
            { outcome: 'success', label: 'Served' },
            { outcome: 'cache-hit', label: 'Served, session read from Redis' },
            { outcome: 'warning', label: 'Revoked token let in' },
            { outcome: 'failure', label: 'Session lost, or revoked user turned away' },
          ]}
        />
      }
      events={events}
      actions={
        <>
          <Button onClick={login}>
            <UserCheck className="h-4 w-4" />
            Log all users in
          </Button>
          <Button variant="danger" onClick={revoke} disabled={current.revoked !== null}>
            <Ban className="h-4 w-4" />
            Revoke user {REVOKED_USER}
          </Button>
        </>
      }
      insight={<Insight title={MODES.find((item) => item.value === mode)?.label}>{insight}</Insight>}
      metrics={
        <>
          <MetricsPanel
            items={[
              {
                key: 'ok',
                label: 'Successful',
                value: formatPercent(successRate, 1),
                tone: successRate > 0.98 ? 'ok' : successRate > 0.8 ? 'warn' : 'danger',
                hint: 'Requests from logged-in users that found a valid session or token. Requests from a revoked user are counted apart.',
              },
              {
                key: 'lost',
                label: 'Lost / failed',
                value: formatNumber(current.lost),
                tone: current.lost > 0 ? 'danger' : 'ok',
                hint: 'Requests that landed on a server without the session, found no session store, or found no server up at all.',
              },
              {
                key: 'lookups',
                label: 'Store lookups',
                value: formatNumber(current.lookups),
                hint: 'Round trips to Redis: the session store, or the JWT denylist.',
              },
              {
                key: 'latency',
                label: 'Extra latency',
                value: showRedis ? formatLatency(2.5) : formatLatency(0),
                hint: 'Additional per-request cost of the session strategy: a Redis round trip, or a signature check that takes microseconds. An illustrative figure.',
                simulated: true,
              },
              { key: 'instances', label: 'Healthy servers', value: `${healthyCount}/3` },
              ...(current.revoked
                ? [
                    {
                      key: 'leaked',
                      label: `Revoked ${REVOKED_USER}: let in`,
                      value: formatNumber(current.leaked),
                      tone: current.leaked > 0 ? ('danger' as const) : ('ok' as const),
                      hint: 'Requests with the revoked credential that a server still accepted.',
                    },
                    {
                      key: 'blocked',
                      label: `Revoked ${REVOKED_USER}: rejected`,
                      value: formatNumber(current.blocked),
                      hint: 'Requests with the revoked credential that were turned away - the correct outcome.',
                    },
                  ]
                : []),
            ]}
          />
          <div className="card p-4">
            <p className="label mb-3">Recent requests</p>
            <div className="space-y-1 font-mono text-[11px]">
              {current.recent.length === 0 ? (
                <p className="text-faint">Run the simulation to see individual requests.</p>
              ) : (
                current.recent.map((row) => (
                  <p
                    key={row.id}
                    className={
                      row.result === 'ok' || row.result === 'blocked'
                        ? 'text-muted'
                        : row.result === 'leaked'
                          ? 'text-warn'
                          : 'text-danger'
                    }
                  >
                    <span className="text-faint">user {row.user}</span> {'->'} {row.server}{' '}
                    <span className="text-faint">{row.detail}</span>
                  </p>
                ))
              )}
            </div>
          </div>
        </>
      }
      controls={
        <>
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted">Where the session lives</p>
            <div role="group" aria-label="Where the session lives" className="grid grid-cols-2 gap-1.5">
              {MODES.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  aria-pressed={mode === item.value}
                  onClick={() => {
                    change('mode')(item.value);
                    // Each strategy is its own experiment. Without this the
                    // success rate keeps averaging in the sessions the previous
                    // strategy lost, so switching to JWT looked broken too.
                    resetStats();
                    log(`Strategy: ${item.label}`, 'info');
                  }}
                  className={`rounded-lg border px-2.5 py-2 text-xs font-medium transition-colors ${
                    mode === item.value
                      ? 'border-brand bg-brand/10 text-brand'
                      : 'border-line text-muted hover:border-brand/50 hover:text-ink'
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>
          <Slider
            label="Traffic"
            value={traffic}
            min={1}
            max={30}
            onChange={change('traffic')}
            format={(value) => `${value} req/sec`}
            hint="Kept low so individual requests stay visible."
          />
          {mode === 'jwt' ? (
            <div className="space-y-3">
              <Slider
                label="Access token lifetime"
                value={tokenMinutes}
                min={5}
                max={60}
                step={5}
                onChange={change('tokenMinutes')}
                format={(value) => `${value} min`}
                hint="Simplified: the lab plays one minute of token life per second, so a revoked token visibly expires. Real access tokens usually live 5-15 minutes."
              />
              <Toggle
                label="Denylist check in Redis"
                checked={denylist}
                onChange={(value) => {
                  change('denylist')(value);
                  resetStats(true);
                  log(value ? 'Denylist on - every request now checks Redis' : 'Denylist off - pure local verification', 'info');
                }}
                description="Rejects revoked tokens at once, for one lookup per request."
              />
            </div>
          ) : null}
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted">Failure injection</p>
            {current.servers.map((server) => (
              <Button
                key={server.id}
                size="sm"
                variant={server.status === 'down' ? 'success' : 'danger'}
                className="w-full justify-center"
                onClick={() => toggleServer(server.id)}
              >
                {server.status === 'down' ? <RotateCw className="h-3 w-3" /> : <Power className="h-3 w-3" />}
                {server.status === 'down' ? `Restart ${server.name}` : `Kill ${server.name}`}
              </Button>
            ))}
            {showRedis ? (
              <Button
                size="sm"
                variant={current.redisUp ? 'danger' : 'success'}
                className="w-full justify-center"
                onClick={() => {
                  current.redisUp = !current.redisUp;
                  log(
                    current.redisUp ? 'Redis recovered' : 'Redis down - every request that needs it fails',
                    current.redisUp ? 'ok' : 'danger',
                  );
                  rerender();
                }}
              >
                {current.redisUp ? 'Kill Redis' : 'Restart Redis'}
              </Button>
            ) : null}
          </div>
        </>
      }
    >
      <DiagramCanvas layout={layout} edges={edges} particles={particleViews} height={510} className="bg-canvas">
        <ArchNode
          kind="client"
          title={`${USERS.length} users`}
          subtitle={`${traffic} req/sec`}
          placed={layout.users}
          compact
        />
        <ArchNode
          kind="load-balancer"
          title="Load Balancer"
          subtitle={mode === 'sticky' ? 'sticky by user, 2 nodes' : 'round robin, 2 nodes'}
          placed={layout.lb}
          compact
        />
        {current.servers.map((server) => (
          <ArchNode
            key={server.id}
            kind="server"
            title={server.name}
            placed={layout[server.id]}
            status={server.status}
          >
            <NodeStatRow
              label="Sessions"
              value={localState ? [...server.sessions].join(' ') || 'none' : SESSION_WHERE[mode]}
            />
            <NodeStatRow label="Handled" value={formatNumber(server.handled)} />
          </ArchNode>
        ))}
        {showRedis ? (
          <ArchNode
            kind="cache"
            title="Redis"
            subtitle={mode === 'jwt' ? 'token denylist' : 'shared session store'}
            placed={layout.redis}
            status={current.redisUp ? 'healthy' : 'down'}
            compact
          >
            {mode === 'jwt' ? (
              <NodeStatRow label="Revoked ids" value={current.revoked ? 1 : 0} />
            ) : (
              <NodeStatRow label="Sessions" value={USERS.length - (current.revoked ? 1 : 0)} />
            )}
          </ArchNode>
        ) : null}
      </DiagramCanvas>
    </LabShell>
  );
}

export default StatelessLab;
