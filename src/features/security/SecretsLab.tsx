import { useRef, useState } from 'react';
import { KeyRound, RefreshCw } from 'lucide-react';
import {
  ArchNode,
  DiagramCanvas,
  NodeStatRow,
  ParticleLegend,
  type DiagramEdge,
  type Layout,
  type ParticleView,
} from '@/components/architecture';
import { Insight, LabShell, MetricsPanel, SIMULATED_HINT } from '@/components/learning';
import { Button, SegmentedControl, Slider, Toggle } from '@/components/ui';
import { advanceParticles, nextParticleId, useEventLog, useTicker, type Particle } from '@/simulations/engine';
import { useRerender } from '@/hooks/useRerender';
import { formatSeconds } from '@/utils/format';
import type { NodeStatus, RequestOutcome } from '@/types';
import { useLabRunning } from '@/hooks/useLabRunning';

/**
 * Secrets management: three services use a database. The database password
 * lives in the code, in a .env file on every host, or in a secrets vault that
 * hands each service its own credential at runtime. The learner leaks the
 * Orders API credential and rotates it, and watches which services break,
 * for how long, and how long the attacker keeps access.
 *
 * Simplified model, not a measurement: one simulated second stands in for
 * minutes of real time (a rebuild and redeploy takes 6 s here, an edit and
 * restart of one host 3 s, a vault poll 5 s), rotations of code and .env files
 * go one service at a time, and a service that holds the vault credential
 * fetches again as soon as the database rejects it. In code and .env modes all
 * three services share one database user, which is the common case, not a rule.
 */

type Storage = 'code' | 'env' | 'vault';
type ServiceId = 'orders' | 'billing' | 'reports';

interface Setup {
  storage: Storage;
  /** Dual-key window: the database accepts the old and the new credential until every holder has the new one. */
  overlap: boolean;
  /** Vault only: every credential is a new database user with a lease that expires by itself. */
  dynamic: boolean;
  /** Vault only, simulated seconds. */
  leaseTtl: number;
  /** Vault only. */
  vaultUp: boolean;
}

/** Opens on a password in the code with no dual-key window, so the first rotation is an outage. */
const DEFAULT_SETUP: Setup = { storage: 'code', overlap: false, dynamic: true, leaseTtl: 20, vaultUp: true };

const STORAGES: { value: Storage; label: string }[] = [
  { value: 'code', label: 'In code' },
  { value: 'env', label: '.env file' },
  { value: 'vault', label: 'Vault' },
];

const SERVICES: { id: ServiceId; title: string; subtitle: string }[] = [
  { id: 'orders', title: 'Orders API', subtitle: 'writes orders' },
  { id: 'billing', title: 'Billing worker', subtitle: 'reads orders' },
  { id: 'reports', title: 'Reports job', subtitle: 'reads orders' },
];
const SERVICE_IDS: ServiceId[] = SERVICES.map((service) => service.id);

/** Simulated seconds. */
const QUERY_S = 1;
const ATTACK_S = 0.9;
const REDEPLOY_S = 6;
const RESTART_S = 3;
const POLL_S = 5;
const FETCH_RETRY_S = 1;
const LEG_SPEED = 1.4;

// Heights fit the stat rows of each card: two for a service, three for the database.
const LAYOUT: Layout = {
  orders: { x: 30, y: 20, w: 200, h: 117 },
  billing: { x: 30, y: 176, w: 200, h: 117 },
  reports: { x: 30, y: 332, w: 200, h: 117 },
  source: { x: 400, y: 16, w: 240, h: 117 },
  db: { x: 730, y: 172, w: 200, h: 140 },
  attacker: { x: 730, y: 340, w: 200, h: 104 },
};

interface Credential {
  id: string;
  owner: ServiceId | 'shared';
  /** Database-side expiry (a lease). Null for a static password. */
  expiresAt: number | null;
  revoked: boolean;
}

interface Service {
  id: ServiceId;
  cred: string | null;
  /** Has held a credential at least once, so a missing one counts as an outage. */
  started: boolean;
  nextQueryAt: number;
  /** Vault: when this service asks the vault next. */
  nextFetchAt: number | null;
  fetching: boolean;
  /** Code and .env: when the new value lands on this service (redeploy or restart). */
  deployAt: number | null;
  downtime: number;
  ok: number;
  rejected: number;
}

interface Rotation {
  startedAt: number;
  oldCred: string;
  newCred: string | null;
  pending: Set<ServiceId>;
  overlap: boolean;
  /** The revoke of the old credential is on its way to the database. */
  revokeSent: boolean;
  oldRevoked: boolean;
  finishedAt: number | null;
}

interface Leak {
  cred: string;
  at: number;
  deadAt: number | null;
}

type Hop =
  | { kind: 'query'; svc: ServiceId; cred: string }
  | { kind: 'answer'; svc: ServiceId }
  | { kind: 'fetch'; svc: ServiceId }
  | { kind: 'create'; cred: string; deliverTo: ServiceId | null }
  | { kind: 'deliver'; svc: ServiceId; cred: string | null }
  | { kind: 'revoke'; cred: string }
  | { kind: 'attack'; cred: string }
  | { kind: 'attack-answer' };

interface SimState {
  clock: number;
  particles: Particle[];
  creds: Map<string, Credential>;
  services: Record<ServiceId, Service>;
  /** Latest static version per owner, for the vault in static mode and for the shared password. */
  latest: Record<string, string>;
  counter: number;
  leak: Leak | null;
  attackNextAt: number;
  attackAccepted: number;
  attackRejected: number;
  tracedNoted: boolean;
  rotation: Rotation | null;
  lastRotationTook: number | null;
  vaultReads: number;
  fetchFailures: number;
}

const newService = (id: ServiceId, index: number): Service => ({
  id,
  cred: null,
  started: false,
  nextQueryAt: 0.3 + index * 0.33,
  nextFetchAt: 0.1 + index * 0.25,
  fetching: false,
  deployAt: null,
  downtime: 0,
  ok: 0,
  rejected: 0,
});

const createState = (storage: Storage): SimState => {
  const state: SimState = {
    clock: 0,
    particles: [],
    creds: new Map(),
    services: {
      orders: newService('orders', 0),
      billing: newService('billing', 1),
      reports: newService('reports', 2),
    },
    latest: {},
    counter: 1,
    leak: null,
    attackNextAt: 0,
    attackAccepted: 0,
    attackRejected: 0,
    tracedNoted: false,
    rotation: null,
    lastRotationTook: null,
    vaultReads: 0,
    fetchFailures: 0,
  };
  if (storage !== 'vault') {
    // One database user, app_user, whose password every service was built or started with.
    const id = 'app_user v1';
    state.creds.set(id, { id, owner: 'shared', expiresAt: null, revoked: false });
    state.latest.shared = id;
    for (const svc of SERVICE_IDS) {
      state.services[svc].cred = id;
      state.services[svc].started = true;
      state.services[svc].nextFetchAt = null;
    }
  }
  return state;
};

const hopOf = (particle: Particle) => particle.meta as unknown as Hop;

const isValid = (state: SimState, id: string | null) => {
  if (id === null) return false;
  const cred = state.creds.get(id);
  if (!cred || cred.revoked) return false;
  return cred.expiresAt === null || state.clock < cred.expiresAt;
};

const titleOf = (svc: ServiceId) => SERVICES.find((service) => service.id === svc)?.title ?? svc;

/** Forgets credentials that no longer work and that nobody holds, so a long run does not grow the map. */
const pruneCreds = (state: SimState) => {
  if (state.creds.size <= 40) return;
  const held = new Set<string>();
  for (const svc of SERVICE_IDS) if (state.services[svc].cred) held.add(state.services[svc].cred as string);
  if (state.leak) held.add(state.leak.cred);
  if (state.rotation) held.add(state.rotation.oldCred);
  for (const id of [...state.creds.keys()]) if (!held.has(id) && !isValid(state, id)) state.creds.delete(id);
};

export function SecretsLab() {
  const [setup, setSetup] = useState(DEFAULT_SETUP);
  const { storage, overlap, dynamic, leaseTtl, vaultUp } = setup;
  const [running, setRunning] = useLabRunning();
  const sim = useRef<SimState>(createState(DEFAULT_SETUP.storage));
  const rerender = useRerender(30);
  const { events, log, clear } = useEventLog();

  const change =
    <K extends keyof Setup>(key: K) =>
    (value: Setup[K]) =>
      setSetup((current) => ({ ...current, [key]: value }));

  /** Changing where the secret lives is a different system, so the simulation starts over. */
  const changeStorage = (value: Storage) => {
    if (value === storage) return;
    setSetup((current) => ({ ...current, storage: value }));
    sim.current = createState(value);
    clear();
    rerender();
  };

  const changeDynamic = (value: boolean) => {
    setSetup((current) => ({ ...current, dynamic: value }));
    sim.current = createState('vault');
    clear();
    log(value ? 'Dynamic leases on: every fetch creates a new database user that expires by itself' : 'Dynamic leases off: each service gets one static credential from the vault', 'info');
    rerender();
  };

  const spawn = (route: string[], outcome: RequestOutcome, hop: Hop) => {
    sim.current.particles.push({
      id: nextParticleId(),
      route,
      leg: 0,
      t: 0,
      speed: LEG_SPEED,
      outcome,
      meta: hop as unknown as Record<string, unknown>,
    });
  };

  const newCredId = (owner: ServiceId | 'shared') => {
    const state = sim.current;
    state.counter += 1;
    return owner === 'shared' ? `app_user v${state.counter}` : `v-${owner}-${state.counter}`;
  };

  const revoke = (id: string) => {
    const cred = sim.current.creds.get(id);
    if (cred) cred.revoked = true;
  };

  const finishRotationIfDone = () => {
    const state = sim.current;
    const rotation = state.rotation;
    if (!rotation || rotation.finishedAt !== null) return;
    if (rotation.pending.size === 0 && rotation.oldRevoked) {
      rotation.finishedAt = state.clock;
      state.lastRotationTook = state.clock - rotation.startedAt;
      log(`Rotation finished in ${formatSeconds(state.lastRotationTook)}: every holder has the new credential and the old one is revoked`, 'ok');
    }
  };

  /** A service now holds a credential. Moves a rotation forward when it is the new one. */
  const receive = (svc: ServiceId, credId: string) => {
    const state = sim.current;
    const service = state.services[svc];
    service.cred = credId;
    service.started = true;
    const rotation = state.rotation;
    if (!rotation || rotation.finishedAt !== null || !rotation.pending.has(svc)) return;
    const isNew = rotation.newCred === null ? credId !== rotation.oldCred : credId === rotation.newCred;
    if (!isNew) return;
    rotation.pending.delete(svc);
    if (rotation.pending.size === 0 && !rotation.revokeSent) {
      // Every holder has moved over: now the old credential can go.
      rotation.revokeSent = true;
      spawn(['source', 'db'], 'warning', { kind: 'revoke', cred: rotation.oldCred });
    }
    finishRotationIfDone();
  };

  const startFetch = (svc: ServiceId) => {
    const service = sim.current.services[svc];
    if (service.fetching) return;
    service.fetching = true;
    service.nextFetchAt = null;
    spawn([svc, 'source'], 'success', { kind: 'fetch', svc });
  };

  const leak = () => {
    const state = sim.current;
    const cred = state.services.orders.cred;
    if (cred === null) return;
    state.leak = { cred, at: state.clock, deadAt: isValid(state, cred) ? null : state.clock };
    state.attackNextAt = state.clock + 0.4;
    state.tracedNoted = false;
    if (storage === 'code') {
      log(`Leak: the repository is cloned outside the company. ${cred} is in it - the one password all 3 services use`, 'danger');
    } else if (storage === 'env') {
      log(`Leak: a copy of the .env file ends up in a shared backup. ${cred} is in it - the one password all 3 services use`, 'danger');
    } else {
      log(`Leak: the Orders API prints its credential ${cred} into a log that others can read. Only Orders uses it`, 'danger');
    }
    rerender();
  };

  const rotate = () => {
    const state = sim.current;
    if (state.rotation && state.rotation.finishedAt === null) return;
    if (storage === 'vault') {
      if (!vaultUp) {
        log('Rotation failed: the vault is unreachable, so nothing can issue a new credential', 'danger');
        return;
      }
      const oldCred = state.services.orders.cred;
      if (oldCred === null) return;
      const rotation: Rotation = {
        startedAt: state.clock,
        oldCred,
        newCred: null,
        pending: new Set(['orders']),
        overlap,
        revokeSent: false,
        oldRevoked: false,
        finishedAt: null,
      };
      state.rotation = rotation;
      if (!overlap) {
        rotation.revokeSent = true;
        spawn(['source', 'db'], 'warning', { kind: 'revoke', cred: oldCred });
      }
      if (dynamic) {
        // A dynamic credential is rotated by asking for a new lease now.
        log(`Rotate: Orders API asks for a new lease now; ${oldCred} is revoked ${overlap ? 'once Orders has the new one' : 'at once'}`, 'info');
        startFetch('orders');
      } else {
        const newCred = newCredId('orders');
        rotation.newCred = newCred;
        spawn(['source', 'db'], 'success', { kind: 'create', cred: newCred, deliverTo: null });
        log(`Rotate: the vault creates ${newCred}; Orders picks it up on its next read (every ${POLL_S} s) and ${oldCred} is revoked ${overlap ? 'after that' : 'at once'}`, 'info');
      }
      rerender();
      return;
    }

    const oldCred = state.latest.shared;
    const newCred = newCredId('shared');
    state.latest.shared = newCred;
    const step = storage === 'code' ? REDEPLOY_S : RESTART_S;
    state.rotation = {
      startedAt: state.clock,
      oldCred,
      newCred,
      pending: new Set(SERVICE_IDS),
      overlap,
      revokeSent: false,
      oldRevoked: false,
      finishedAt: null,
    };
    SERVICE_IDS.forEach((svc, index) => {
      state.services[svc].deployAt = state.clock + (index + 1) * step;
    });
    spawn(['source', 'db'], 'success', { kind: 'create', cred: newCred, deliverTo: null });
    log(
      storage === 'code'
        ? `Rotate: new password ${newCred} set on the database and committed; each service must be rebuilt and redeployed (${REDEPLOY_S} s each, one after another)`
        : `Rotate: new password ${newCred} set on the database; the .env file must be edited and the service restarted on each host (${RESTART_S} s each)`,
      'info',
    );
    if (!overlap) log(`No dual-key window: ${oldCred} stops working the moment the new password is set`, 'warn');
    rerender();
  };

  /** A particle reached the end of its route. */
  const arrive = (particle: Particle) => {
    const state = sim.current;
    const hop = hopOf(particle);

    switch (hop.kind) {
      case 'query': {
        const service = state.services[hop.svc];
        if (isValid(state, hop.cred)) {
          service.ok += 1;
          spawn(['db', hop.svc], 'success', { kind: 'answer', svc: hop.svc });
        } else {
          service.rejected += 1;
          spawn(['db', hop.svc], 'failure', { kind: 'answer', svc: hop.svc });
          // A service that gets its credential from the vault asks again as soon as its login is rejected.
          // Only for the credential it holds now: a query still in flight with an older one is no reason to ask.
          if (storage === 'vault' && vaultUp && !service.fetching && hop.cred === service.cred) {
            log(`${titleOf(hop.svc)}: login rejected - asks the vault for a new credential`, 'warn');
            startFetch(hop.svc);
          }
        }
        return;
      }
      case 'fetch': {
        state.vaultReads += 1;
        const service = state.services[hop.svc];
        if (!vaultUp) {
          state.fetchFailures += 1;
          service.fetching = false;
          // Still holding a working credential: try again later. Without one: try again soon.
          service.nextFetchAt = state.clock + (isValid(state, service.cred) ? (dynamic ? 2 * FETCH_RETRY_S : POLL_S) : FETCH_RETRY_S);
          spawn(['source', hop.svc], 'failure', { kind: 'deliver', svc: hop.svc, cred: null });
          return;
        }
        if (dynamic) {
          const id = newCredId(hop.svc);
          spawn(['source', 'db'], 'success', { kind: 'create', cred: id, deliverTo: hop.svc });
          return;
        }
        const current = state.latest[hop.svc];
        if (current === undefined) {
          const id = newCredId(hop.svc);
          state.latest[hop.svc] = id;
          spawn(['source', 'db'], 'success', { kind: 'create', cred: id, deliverTo: hop.svc });
          return;
        }
        spawn(['source', hop.svc], 'success', { kind: 'deliver', svc: hop.svc, cred: current });
        return;
      }
      case 'create': {
        const owner: ServiceId | 'shared' = hop.cred.startsWith('app_user') ? 'shared' : (hop.cred.split('-')[1] as ServiceId);
        state.creds.set(hop.cred, {
          id: hop.cred,
          owner,
          expiresAt: storage === 'vault' && dynamic ? state.clock + leaseTtl : null,
          revoked: false,
        });
        if (owner !== 'shared' && !dynamic) state.latest[owner] = hop.cred;
        const rotation = state.rotation;
        if (rotation && rotation.newCred === hop.cred && !rotation.overlap && !rotation.revokeSent) {
          // Single-credential rotation: setting the new password ends the old one.
          rotation.revokeSent = true;
          rotation.oldRevoked = true;
          revoke(rotation.oldCred);
        }
        if (hop.deliverTo) spawn(['db', 'source', hop.deliverTo], 'success', { kind: 'deliver', svc: hop.deliverTo, cred: hop.cred });
        finishRotationIfDone();
        return;
      }
      case 'deliver': {
        const service = state.services[hop.svc];
        if (hop.cred === null) return;
        service.fetching = false;
        receive(hop.svc, hop.cred);
        if (storage === 'vault') {
          const cred = state.creds.get(hop.cred);
          service.nextFetchAt =
            dynamic && cred?.expiresAt != null ? cred.expiresAt - leaseTtl / 3 : state.clock + POLL_S;
        }
        return;
      }
      case 'revoke': {
        revoke(hop.cred);
        if (state.rotation && state.rotation.oldCred === hop.cred) state.rotation.oldRevoked = true;
        finishRotationIfDone();
        return;
      }
      case 'attack': {
        if (isValid(state, hop.cred)) {
          state.attackAccepted += 1;
          spawn(['db', 'attacker'], 'success', { kind: 'attack-answer' });
          if (!state.tracedNoted) {
            state.tracedNoted = true;
            log(
              storage === 'vault'
                ? `Database: login as ${hop.cred} from an unknown address. The vault audit log shows it was issued to the Orders API only`
                : `Database: login as app_user from an unknown address. Three services share that user, so the log cannot say which copy leaked`,
              'danger',
            );
          }
        } else {
          state.attackRejected += 1;
          spawn(['db', 'attacker'], 'failure', { kind: 'attack-answer' });
        }
        return;
      }
      default:
        return;
    }
  };

  useTicker(running, (dt) => {
    const state = sim.current;
    state.clock += dt;

    for (const svc of SERVICE_IDS) {
      const service = state.services[svc];

      // Code and .env: the new value lands when the redeploy or restart of this service finishes.
      if (service.deployAt !== null && state.clock >= service.deployAt) {
        service.deployAt = null;
        const newCred = state.rotation?.newCred ?? state.latest.shared;
        spawn(['source', svc], 'success', { kind: 'deliver', svc, cred: newCred });
        log(
          `${titleOf(svc)} ${storage === 'code' ? 'redeployed' : 'restarted'} with ${newCred}`,
          'info',
        );
      }

      // Vault: poll or renew on schedule.
      if (storage === 'vault' && !service.fetching && service.nextFetchAt !== null && state.clock >= service.nextFetchAt) {
        startFetch(svc);
      }

      if (service.started && !isValid(state, service.cred)) service.downtime += dt;

      if (service.cred !== null && state.clock >= service.nextQueryAt) {
        service.nextQueryAt = state.clock + QUERY_S;
        spawn([svc, 'db'], 'success', { kind: 'query', svc, cred: service.cred });
      }

      // A service whose lease expired while the vault is down retries its fetch.
      if (storage === 'vault' && service.started && !service.fetching && service.nextFetchAt === null) {
        service.nextFetchAt = state.clock + FETCH_RETRY_S;
      }
    }

    const leakNow = state.leak;
    if (leakNow) {
      if (leakNow.deadAt === null && !isValid(state, leakNow.cred)) {
        leakNow.deadAt = state.clock;
        const cred = state.creds.get(leakNow.cred);
        const expired = cred !== undefined && !cred.revoked && cred.expiresAt !== null;
        log(
          `The leaked credential stopped working ${formatSeconds(state.clock - leakNow.at)} after the leak (${expired ? 'its lease expired' : 'revoked'})`,
          'ok',
        );
      }
      if (state.clock >= state.attackNextAt && state.clock - (leakNow.deadAt ?? state.clock) < 6) {
        state.attackNextAt = state.clock + ATTACK_S;
        spawn(['attacker', 'db'], 'warning', { kind: 'attack', cred: leakNow.cred });
      }
    }

    const { alive, finished } = advanceParticles(state.particles, dt);
    state.particles = alive.slice(-120);
    finished.forEach(arrive);
    pruneCreds(state);
    rerender();
  });

  const reset = () => {
    sim.current = createState(DEFAULT_SETUP.storage);
    setSetup(DEFAULT_SETUP);
    clear();
    rerender();
  };

  const state = sim.current;
  const inVault = storage === 'vault';
  const brokenNow = SERVICE_IDS.filter((svc) => state.services[svc].started && !isValid(state, state.services[svc].cred));
  const downtimeTotal = SERVICE_IDS.reduce((sum, svc) => sum + state.services[svc].downtime, 0);
  const rotation = state.rotation;
  const rotating = rotation !== null && rotation.finishedAt === null;
  const leakInfo = state.leak;
  const leakValid = leakInfo !== null && leakInfo.deadAt === null;
  const leakAge = leakInfo ? (leakInfo.deadAt ?? state.clock) - leakInfo.at : 0;
  const rotatedSinceLeak = leakInfo !== null && rotation !== null && rotation.startedAt >= leakInfo.at;

  const particleViews: ParticleView[] = state.particles.map((particle) => ({
    id: particle.id,
    from: particle.route[particle.leg],
    to: particle.route[particle.leg + 1],
    t: particle.t,
    outcome: particle.outcome ?? 'success',
  }));

  const sourceEdges: DiagramEdge[] = SERVICE_IDS.map((svc) =>
    inVault
      ? { from: svc, to: 'source', tone: vaultUp ? 'brand' : 'danger', dashed: !vaultUp }
      : { from: 'source', to: svc, tone: 'muted', dashed: true },
  );
  const edges: DiagramEdge[] = [
    ...sourceEdges,
    ...SERVICE_IDS.map((svc): DiagramEdge => ({ from: svc, to: 'db', tone: brokenNow.includes(svc) ? 'danger' : 'ok' })),
    { from: 'source', to: 'db', tone: inVault ? 'violet' : 'muted', dashed: !inVault },
    { from: 'attacker', to: 'db', tone: leakInfo ? 'danger' : 'muted', dashed: !leakInfo, faded: !leakInfo },
  ];

  const sourceTitle = storage === 'code' ? 'Git repository' : storage === 'env' ? '.env files' : 'Secrets vault';
  const sourceSubtitle =
    storage === 'code'
      ? 'password in config.py'
      : storage === 'env'
        ? 'one copy per host'
        : dynamic
          ? `dynamic leases, ${leaseTtl} s`
          : `static, read every ${POLL_S} s`;
  const copies = storage === 'code' ? 'every clone' : storage === 'env' ? '3 hosts + backups' : '1, encrypted';

  const serviceStatus = (svc: ServiceId): NodeStatus => {
    const service = state.services[svc];
    if (!service.started) return 'starting';
    if (!isValid(state, service.cred)) return 'down';
    if (rotation && rotation.finishedAt === null && rotation.pending.has(svc)) return 'degraded';
    return 'healthy';
  };

  const serviceStatusLabel = (svc: ServiceId) => {
    const status = serviceStatus(svc);
    if (status === 'down') return 'Login rejected';
    if (status === 'degraded') return 'Old credential';
    if (status === 'starting') return 'Fetching';
    return undefined;
  };

  const credLabel = (id: string | null) => {
    if (id === null) return '-';
    const cred = state.creds.get(id);
    if (!cred || cred.expiresAt === null) return id;
    const left = cred.expiresAt - state.clock;
    return left > 0 ? `${id} (${Math.ceil(left)} s)` : `${id} expired`;
  };

  const insight = (() => {
    if (!leakInfo) {
      return inVault ? (
        <>
          Each service holds its own credential{dynamic ? `, a database user that the vault created and that expires ${leaseTtl} s later` : ''}.
          Watch the violet wire: the vault creates the users on the database, and the services only ever ask the vault.
          Now press Leak Orders key.
        </>
      ) : (
        <>
          All three services use the same password, <span className="font-mono">{state.latest.shared}</span>, and it sits{' '}
          {storage === 'code' ? 'in the repository - in every clone and every image built from it' : 'in a .env file on every host'}.
          The dashed wires carry nothing at runtime: the value was put there at {storage === 'code' ? 'build' : 'start'} time.
          Press Leak Orders key.
        </>
      );
    }
    if (leakValid && !rotatedSinceLeak) {
      return inVault && dynamic ? (
        <>
          The attacker is reading data with the leaked credential (triangles), but only as the Orders API, and the lease
          ends by itself {Math.max(0, Math.ceil((state.creds.get(leakInfo.cred)?.expiresAt ?? state.clock) - state.clock))} s from now,
          even if nobody rotates. Press Rotate to end it sooner.
        </>
      ) : (
        <>
          The leaked credential never expires, so the attacker keeps reading until someone rotates it - {formatSeconds(leakAge)} so far.
          {inVault ? ' Only the Orders API uses it.' : ' It is the password of all three services.'} Press Rotate
          {overlap ? '' : ', first without a dual-key window'}.
        </>
      );
    }
    if (rotating && rotation) {
      return inVault ? (
        <>Only the Orders API is involved: Billing and Reports have their own credentials and never notice the rotation.</>
      ) : rotation.overlap ? (
        <>
          The database accepts both passwords, so nothing breaks while the services move over one by one - but the
          leaked password also keeps working until the last one has moved.
        </>
      ) : (
        <>
          The old password died the moment the new one was set, and every service still has the old one until it is
          {storage === 'code' ? ' rebuilt and redeployed' : ' edited and restarted'}. {brokenNow.length} of 3 are down right now.
        </>
      );
    }
    return (
      <>
        The leaked key was usable for {formatSeconds(leakAge)}; the services lost {formatSeconds(downtimeTotal)} in total.
        {storage === 'code'
          ? ' The old password is still in git history - harmless now only because it was revoked - and the new one was committed to the same repository.'
          : storage === 'env'
            ? ' The new password is again copied into a file on every host.'
            : ''}{' '}
        {inVault
          ? dynamic
            ? 'Try Vault reachable off: leases cannot be renewed, and services break when theirs expire.'
            : 'Try Dynamic leases on: a leak then ends by itself, without anyone rotating.'
          : overlap
            ? 'Now try Vault, where one service rotates alone and in seconds.'
            : 'Reset, turn on Dual-key window and rotate again: no downtime, but the attacker keeps access longer.'}
      </>
    );
  })();

  return (
    <LabShell
      title="Secrets Lab"
      description="Keep the database password in code, in a .env file or in a vault. Leak the Orders API key, then rotate it, and see which services break, for how long, and how long the attacker keeps access."
      running={running}
      onRunningChange={setRunning}
      onReset={reset}
      legend={
        <div className="flex flex-wrap items-center gap-3">
          <ParticleLegend
            outcomes={[
              { outcome: 'success', label: 'Query, answer or credential' },
              { outcome: 'warning', label: 'Attacker query or revoke' },
              { outcome: 'failure', label: 'Rejected login or fetch' },
            ]}
          />
          <span className="text-[11px] text-faint">Triangles on the database wires: attacker queries and revocations.</span>
        </div>
      }
      events={events}
      actions={
        <>
          <Button variant="danger" onClick={leak} disabled={leakValid || state.services.orders.cred === null}>
            <KeyRound className="h-4 w-4" />
            Leak Orders key
          </Button>
          <Button variant="primary" onClick={rotate} disabled={rotating}>
            <RefreshCw className="h-4 w-4" />
            Rotate
          </Button>
        </>
      }
      insight={<Insight>{insight}</Insight>}
      metrics={
        <>
          <MetricsPanel
            items={[
              {
                key: 'broken',
                label: 'Services down now',
                value: `${brokenNow.length} / 3`,
                tone: brokenNow.length > 0 ? 'danger' : 'ok',
                hint: 'Services whose database login is being rejected.',
              },
              {
                key: 'downtime',
                label: 'Downtime',
                value: formatSeconds(downtimeTotal),
                tone: downtimeTotal > 0 ? 'danger' : 'ok',
                hint: 'Seconds of rejected logins, added up over the three services.',
                simulated: true,
              },
              {
                key: 'leak',
                label: 'Leaked key',
                value: !leakInfo ? 'none' : leakValid ? `valid ${formatSeconds(leakAge)}` : `dead after ${formatSeconds(leakAge)}`,
                tone: !leakInfo ? 'neutral' : leakValid ? 'danger' : 'ok',
                hint: 'How long the leaked credential kept working after the leak.',
                simulated: true,
              },
              {
                key: 'attack',
                label: 'Attacker queries answered',
                value: state.attackAccepted,
                tone: state.attackAccepted > 0 ? 'danger' : 'ok',
                hint: 'Queries the database answered for the attacker with the leaked credential.',
              },
              {
                key: 'rotation',
                label: 'Last rotation took',
                value: rotating && rotation ? `running ${formatSeconds(state.clock - rotation.startedAt)}` : state.lastRotationTook === null ? '-' : formatSeconds(state.lastRotationTook),
                hint: 'From pressing Rotate until every holder has the new credential and the old one is revoked.',
                simulated: true,
              },
              {
                key: 'sharing',
                label: 'Services per credential',
                value: inVault ? 1 : 3,
                tone: inVault ? 'ok' : 'warn',
                hint: 'How many services one leaked credential speaks for, and how many one rotation touches.',
              },
            ]}
          />
          <div className="card p-4">
            <p className="label mb-3">Who holds what</p>
            <ul className="space-y-1.5 font-mono text-[11px] text-muted">
              {SERVICES.map((service) => {
                const held = state.services[service.id].cred;
                const valid = isValid(state, held);
                return (
                  <li key={service.id} className="flex flex-wrap items-center gap-2">
                    <span className="w-28 shrink-0 text-ink">{service.title}</span>
                    <span className={valid ? 'text-ok' : 'text-danger'}>{credLabel(held)}</span>
                    <span className="text-faint">{valid ? 'accepted' : held === null ? 'none yet' : 'rejected'}</span>
                  </li>
                );
              })}
              <li className="flex flex-wrap items-center gap-2">
                <span className="w-28 shrink-0 text-ink">Attacker</span>
                {leakInfo ? (
                  <>
                    <span className={leakValid ? 'text-danger' : 'text-faint'}>{credLabel(leakInfo.cred)}</span>
                    <span className="text-faint">{leakValid ? 'accepted' : 'rejected'}</span>
                  </>
                ) : (
                  <span className="text-faint">nothing leaked</span>
                )}
              </li>
            </ul>
          </div>
          <p className="text-xs text-faint">
            {SIMULATED_HINT} One simulated second stands in for minutes. A rebuild and redeploy takes{' '}
            {REDEPLOY_S} s per service here and an edit and restart {RESTART_S} s, one service after another; a vault read is
            every {POLL_S} s, and a service with a vault credential asks again as soon as its login is rejected. Every query
            here is a new login, so a dead credential fails at once; real pools keep connections that are already open.
            Instead of extending a lease, a service here asks for a new credential. Real lease lengths are minutes to hours.
          </p>
        </>
      }
      controls={
        <>
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted">Where the password lives</p>
            <SegmentedControl size="sm" className="w-full" value={storage} options={STORAGES} onChange={changeStorage} />
            <p className="text-[11px] text-faint">
              {storage === 'code'
                ? 'Written in the source code. Changing it means a commit, a rebuild and a redeploy of every service.'
                : storage === 'env'
                  ? 'In a .env file next to each service. Changing it means editing the file on every host and restarting.'
                  : 'In a vault. Each service proves who it is and fetches its own credential at runtime.'}
            </p>
          </div>
          <Toggle
            label="Dual-key window"
            checked={overlap}
            onChange={change('overlap')}
            disabled={rotating}
            description="During a rotation the database accepts the old and the new credential until every holder has the new one."
          />
          <Toggle
            label="Dynamic leases"
            checked={dynamic}
            onChange={changeDynamic}
            disabled={!inVault}
            description="Vault only. Every fetch creates a new database user that expires by itself."
          />
          <Slider
            label="Lease length"
            value={leaseTtl}
            min={10}
            max={40}
            step={5}
            disabled={!inVault || !dynamic}
            onChange={change('leaseTtl')}
            format={(value) => `${value} s`}
            hint="Simulated seconds. After two thirds of it the service asks for a new credential. Applies to new leases."
          />
          <Toggle
            label="Vault reachable"
            checked={vaultUp}
            onChange={change('vaultUp')}
            disabled={!inVault}
            description="Vault only. Turn off to see what happens to services when their lease runs out."
          />
        </>
      }
    >
      <DiagramCanvas layout={LAYOUT} edges={edges} particles={particleViews} height={460} className="bg-canvas">
        {SERVICES.map((service) => {
          const current = state.services[service.id];
          return (
            <ArchNode
              key={service.id}
              kind="service"
              title={service.title}
              subtitle={service.subtitle}
              placed={LAYOUT[service.id]}
              status={serviceStatus(service.id)}
              statusLabel={serviceStatusLabel(service.id)}
              alert={service.id === 'orders' && leakValid}
              compact
            >
              <NodeStatRow label="Holds" value={current.cred ?? '-'} />
              <NodeStatRow
                label="Down for"
                value={formatSeconds(current.downtime)}
                tone={current.downtime > 0 ? 'text-danger' : 'text-ok'}
              />
            </ArchNode>
          );
        })}
        <ArchNode
          kind="storage"
          title={sourceTitle}
          subtitle={sourceSubtitle}
          placed={LAYOUT.source}
          status={inVault && !vaultUp ? 'down' : 'healthy'}
          statusLabel={inVault ? (vaultUp ? undefined : 'Unreachable') : 'Not used at runtime'}
          compact
        >
          <NodeStatRow label="Copies at rest" value={copies} tone={inVault ? 'text-ok' : 'text-warn'} />
          <NodeStatRow label={inVault ? 'Reads (audited)' : 'Access log'} value={inVault ? state.vaultReads : 'none'} />
        </ArchNode>
        <ArchNode
          kind="sql"
          title="Database"
          subtitle={inVault ? 'one user per service' : 'one user: app_user'}
          placed={LAYOUT.db}
          compact
        >
          <NodeStatRow
            label="Valid logins"
            value={[...state.creds.values()].filter((cred) => isValid(state, cred.id)).length}
          />
          <NodeStatRow
            label="Rejected"
            value={SERVICE_IDS.reduce((sum, svc) => sum + state.services[svc].rejected, 0) + state.attackRejected}
          />
          <NodeStatRow label="Answered attacker" value={state.attackAccepted} tone={state.attackAccepted > 0 ? 'text-danger' : 'text-ink'} />
        </ArchNode>
        <ArchNode
          kind="client"
          title="Attacker"
          subtitle={leakInfo ? `holds ${leakInfo.cred}` : 'has no credential'}
          placed={LAYOUT.attacker}
          status={leakValid ? 'healthy' : 'down'}
          statusLabel={leakValid ? 'Reading data' : leakInfo ? 'Locked out' : 'Idle'}
          alert={leakValid}
          compact
        >
          <NodeStatRow label="Access so far" value={formatSeconds(leakAge)} tone={leakValid ? 'text-danger' : 'text-ink'} />
        </ArchNode>
      </DiagramCanvas>
    </LabShell>
  );
}

export default SecretsLab;
