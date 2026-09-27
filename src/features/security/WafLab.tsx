import { useRef, useState } from 'react';
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
import { cn } from '@/utils/cn';
import type { RequestOutcome } from '@/types';
import { useLabRunning } from '@/hooks/useLabRunning';

/**
 * Web application firewall: real users and attackers send requests to the same
 * WAF, which sees only the request - not which box it came from. Each request is
 * matched against rules; a match is written to the WAF log, and in Blocking mode
 * the WAF answers 403 itself so the request never reaches the application.
 *
 * Simplified model, not a measurement. In the real OWASP Core Rule Set every
 * matching rule adds points to an anomaly score (a critical match is 5) and a
 * request is blocked at a score of 5 or more; a higher paranoia level (1-4)
 * switches on more rules. Here each request type simply has a fixed chance to
 * be flagged at each level (DETECT below). The numbers are illustrative; the
 * direction is real: a stricter level catches more attacks and blocks more real
 * users, and no level catches a logic flaw such as IDOR.
 */

type Mode = 'block' | 'detect';
type Kind = 'browse' | 'text' | 'sqli' | 'xss' | 'bot' | 'idor';
type Source = 'users' | 'attackers';

interface Setup {
  mode: Mode;
  /** Rule strictness, as a CRS paranoia level 1-4. */
  level: number;
  /** Share of real-user requests that carry text that looks like code (quotes, SQL words, tags). */
  textShare: number;
  /** Attack requests per simulated second. */
  attackRate: number;
  /** Exclude the SQLi and XSS rules for the message field of /support. */
  exclusion: boolean;
  /** Parameterised queries, output encoding and ownership checks in the app. */
  secureCode: boolean;
  autoTraffic: boolean;
}

/** Opens on a lenient level in Blocking mode: attacks slip through, few real users are blocked. */
const DEFAULT_SETUP: Setup = {
  mode: 'block',
  level: 1,
  textShare: 0.2,
  attackRate: 1.5,
  exclusion: false,
  secureCode: false,
  autoTraffic: true,
};

const MODES: { value: Mode; label: string }[] = [
  { value: 'detect', label: 'Detection only' },
  { value: 'block', label: 'Blocking' },
];

const KIND_INFO: Record<Kind, { label: string; attack: boolean; rule: string }> = {
  browse: { label: 'Normal page', attack: false, rule: '920272 restricted character' },
  text: { label: 'Ticket quoting SQL', attack: false, rule: '942100 SQLi (libinjection)' },
  sqli: { label: 'SQL injection', attack: true, rule: '942100 SQLi (libinjection)' },
  xss: { label: 'XSS', attack: true, rule: '941100 XSS (libinjection)' },
  bot: { label: 'Bad bot', attack: true, rule: '913100 scanner User-Agent' },
  idor: { label: 'IDOR', attack: true, rule: '' },
};

const KINDS: Kind[] = ['browse', 'text', 'sqli', 'xss', 'bot', 'idor'];

/**
 * Chance that a request of each type is flagged at paranoia level 1..4.
 * Illustrative numbers for the lesson, not measured detection rates.
 * Plain attacks are caught at every level; the extra rules of higher levels
 * catch the encoded and split variants - and also real text that looks similar.
 */
const DETECT: Record<Kind, [number, number, number, number]> = {
  browse: [0, 0, 0.02, 0.06],
  text: [0.06, 0.25, 0.55, 0.85],
  sqli: [0.8, 0.92, 0.97, 0.99],
  xss: [0.75, 0.9, 0.96, 0.99],
  bot: [0.45, 0.6, 0.75, 0.85],
  // A request for another user invoice is well-formed. No pattern can see it.
  idor: [0, 0, 0, 0],
};

/** Attack mix of the automatic attack traffic. */
const ATTACK_MIX: [Kind, number][] = [
  ['sqli', 0.3],
  ['xss', 0.25],
  ['bot', 0.3],
  ['idor', 0.15],
];

/** Share of SQLi and XSS attempts an attacker places in the /support message field. */
const IN_SUPPORT_FIELD = 0.25;

/** Real-user requests per simulated second. */
const USER_RATE = 3;
const LEG_SPEED = 1.3;

const LAYOUT: Layout = {
  users: { x: 30, y: 40, w: 210, h: 130 },
  attackers: { x: 30, y: 270, w: 210, h: 130 },
  waf: { x: 370, y: 140, w: 230, h: 170 },
  app: { x: 720, y: 30, w: 210, h: 150 },
  log: { x: 720, y: 270, w: 210, h: 130 },
};

type Stage = 'request' | 'forbidden' | 'logged';

type Hop = {
  stage: Stage;
  kind: Kind;
  source: Source;
  req: number;
  inSupportField: boolean;
  flagged?: boolean;
  manual?: boolean;
};

interface LogRow {
  req: number;
  kind: Kind;
  rule: string;
  action: 'BLOCK' | 'COUNT';
}

interface KindStats {
  sent: number;
  flagged: number;
  reachedApp: number;
}

interface Stats {
  usersSent: number;
  usersServed: number;
  usersBlocked: number;
  attacksSent: number;
  attacksBlocked: number;
  attacksMissed: number;
  harm: number;
  /** Attacks that passed only because the /support exclusion skipped their field. */
  missedByExclusion: number;
  wouldBlockUsers: number;
  wouldBlockAttacks: number;
  matches: number;
}

interface SimState {
  userAcc: number;
  attackAcc: number;
  nextReq: number;
  particles: Particle[];
  log: LogRow[];
  byKind: Record<Kind, KindStats>;
  stats: Stats;
}

const emptyKinds = (): Record<Kind, KindStats> =>
  Object.fromEntries(KINDS.map((kind) => [kind, { sent: 0, flagged: 0, reachedApp: 0 }])) as Record<Kind, KindStats>;

const createState = (): SimState => ({
  userAcc: 0,
  attackAcc: 0,
  nextReq: 1000,
  particles: [],
  log: [],
  byKind: emptyKinds(),
  stats: {
    usersSent: 0,
    usersServed: 0,
    usersBlocked: 0,
    attacksSent: 0,
    attacksBlocked: 0,
    attacksMissed: 0,
    harm: 0,
    missedByExclusion: 0,
    wouldBlockUsers: 0,
    wouldBlockAttacks: 0,
    matches: 0,
  },
});

const hopOf = (particle: Particle) => particle.meta as Hop;

const pickAttack = (): Kind => {
  let roll = Math.random();
  for (const [kind, share] of ATTACK_MIX) {
    if (roll < share) return kind;
    roll -= share;
  }
  return 'sqli';
};

/** Chance the rules flag one request, given where in the request its payload sits. */
const detectChance = (kind: Kind, setup: Setup, inSupportField: boolean) => {
  const excluded = setup.exclusion && inSupportField;
  if (excluded && kind === 'text') return DETECT.browse[setup.level - 1];
  if (excluded && (kind === 'sqli' || kind === 'xss')) return 0;
  return DETECT[kind][setup.level - 1];
};

/** Chance over the whole traffic of one type, for the per-type table. */
const typeChance = (kind: Kind, setup: Setup) => {
  if (kind === 'text') return detectChance(kind, setup, true);
  if (kind === 'sqli' || kind === 'xss')
    return (1 - IN_SUPPORT_FIELD) * detectChance(kind, setup, false) + IN_SUPPORT_FIELD * detectChance(kind, setup, true);
  return detectChance(kind, setup, false);
};

const pct = (value: number) => `${Math.round(value * 100)}%`;

export function WafLab() {
  const [setup, setSetup] = useState(DEFAULT_SETUP);
  const { mode, level, textShare, attackRate, exclusion, secureCode, autoTraffic } = setup;
  const change =
    <K extends keyof Setup>(key: K) =>
    (value: Setup[K]) =>
      setSetup((current) => ({ ...current, [key]: value }));
  const [running, setRunning] = useLabRunning();
  const sim = useRef<SimState>(createState());
  const rerender = useRerender(30);
  const { events, log, clear } = useEventLog();

  const spawn = (route: string[], outcome: RequestOutcome, hop: Hop) => {
    sim.current.particles.push({ id: nextParticleId(), route, leg: 0, t: 0, speed: LEG_SPEED, outcome, meta: hop });
  };

  const send = (kind: Kind, manual = false) => {
    const state = sim.current;
    const attack = KIND_INFO[kind].attack;
    const source: Source = attack ? 'attackers' : 'users';
    state.nextReq += 1;
    state.byKind[kind].sent += 1;
    if (attack) state.stats.attacksSent += 1;
    else state.stats.usersSent += 1;
    const inSupportField = kind === 'text' || ((kind === 'sqli' || kind === 'xss') && Math.random() < IN_SUPPORT_FIELD);
    spawn([source, 'waf'], attack ? 'warning' : 'success', {
      stage: 'request',
      kind,
      source,
      req: state.nextReq,
      inSupportField,
      manual,
    });
  };

  /** The WAF has the whole request: run the rules, then log, block or forward. */
  const inspect = (hop: Hop) => {
    const state = sim.current;
    const attack = KIND_INFO[hop.kind].attack;
    const flagged = Math.random() < detectChance(hop.kind, setup, hop.inSupportField);
    const tag = `r-${hop.req} ${KIND_INFO[hop.kind].label}`;

    if (flagged) {
      state.stats.matches += 1;
      state.byKind[hop.kind].flagged += 1;
      const rule =
        hop.kind === 'text' && Math.random() < 0.4 ? KIND_INFO.xss.rule : KIND_INFO[hop.kind].rule;
      state.log.push({ req: hop.req, kind: hop.kind, rule, action: mode === 'block' ? 'BLOCK' : 'COUNT' });
      if (state.log.length > 40) state.log.shift();
      spawn(['waf', 'log'], 'cache-hit', { ...hop, stage: 'logged', flagged });
    }

    if (flagged && mode === 'block') {
      if (attack) state.stats.attacksBlocked += 1;
      else {
        state.stats.usersBlocked += 1;
        log(`${tag}: a real user got 403 Forbidden - a false positive`, 'warn');
      }
      if (hop.manual && attack) log(`${tag}: rule matched, 403 Forbidden - it never reached the app`, 'ok');
      spawn(['waf', hop.source], 'failure', { ...hop, stage: 'forbidden', flagged });
      return;
    }

    if (flagged) {
      if (attack) state.stats.wouldBlockAttacks += 1;
      else state.stats.wouldBlockUsers += 1;
    }
    if (hop.manual && !flagged && attack) log(`${tag}: no rule matched, forwarded to the app`, 'warn');
    spawn(['waf', 'app'], attack ? 'warning' : 'success', { ...hop, flagged });
  };

  /** The request reached the application. */
  const serve = (hop: Hop) => {
    const state = sim.current;
    state.byKind[hop.kind].reachedApp += 1;
    if (!KIND_INFO[hop.kind].attack) {
      state.stats.usersServed += 1;
      return;
    }
    state.stats.attacksMissed += 1;
    const excludedOnly = exclusion && hop.inSupportField && (hop.kind === 'sqli' || hop.kind === 'xss');
    if (excludedOnly) state.stats.missedByExclusion += 1;
    // A scraping bot sends well-formed requests; fixed code has nothing to refuse.
    const harmful = hop.kind === 'bot' || !secureCode;
    const tag = `r-${hop.req} ${KIND_INFO[hop.kind].label}`;
    if (harmful) {
      state.stats.harm += 1;
      if (hop.kind === 'idor') log(`${tag}: returned the invoice of another customer - no rule could see it`, 'danger');
      else if (hop.kind === 'bot') log(`${tag}: scraped a page - it looks like a browser`, 'danger');
      else log(`${tag}: reached ${hop.kind === 'sqli' ? 'string-built SQL' : 'unencoded output'} - exploited`, 'danger');
    } else if (hop.manual) {
      log(`${tag}: reached the app, but the fixed code made it harmless`, 'ok');
    }
  };

  const arrive = (particle: Particle) => {
    const hop = hopOf(particle);
    if (hop.stage !== 'request') return;
    const at = particle.route[particle.route.length - 1];
    if (at === 'waf') inspect(hop);
    else if (at === 'app') serve(hop);
  };

  useTicker(running, (dt) => {
    const state = sim.current;
    if (autoTraffic) {
      state.userAcc += dt * USER_RATE;
      state.attackAcc += dt * attackRate;
      while (state.userAcc >= 1) {
        state.userAcc -= 1;
        send(Math.random() < textShare ? 'text' : 'browse');
      }
      while (state.attackAcc >= 1) {
        state.attackAcc -= 1;
        send(pickAttack());
      }
    }
    const { alive, finished } = advanceParticles(state.particles, dt);
    state.particles = alive.slice(-120);
    finished.forEach(arrive);
    rerender();
  });

  const reset = () => {
    sim.current = createState();
    setSetup(DEFAULT_SETUP);
    clear();
    rerender();
  };

  const state = sim.current;
  const { stats, byKind } = state;
  const blocking = mode === 'block';
  const userFpRate = stats.usersSent ? stats.usersBlocked / stats.usersSent : 0;
  const logRows = state.log.slice(-6).reverse();

  const particleViews: ParticleView[] = state.particles.map((particle) => ({
    id: particle.id,
    from: particle.route[particle.leg],
    to: particle.route[particle.leg + 1],
    t: particle.t,
    outcome: particle.outcome ?? 'success',
  }));

  const edges: DiagramEdge[] = [
    { from: 'users', to: 'waf', tone: 'brand', width: 2 },
    { from: 'attackers', to: 'waf', tone: 'danger', width: 2 },
    { from: 'waf', to: 'app', tone: 'ok', width: 2 },
    { from: 'waf', to: 'log', tone: 'warn', dashed: true, label: 'rule matches', labelT: 0.45 },
  ];

  const idorNote =
    byKind.idor.reachedApp > 0 ? (
      <>
        {' '}
        Every IDOR passed ({byKind.idor.reachedApp} so far) at every level: asking for invoice 9183 instead of 9182 is a
        well-formed request, so no rule can see it. Only an ownership check in the app stops it
        {secureCode ? ' - and with Secure app code on, it now does.' : ' - turn on Secure app code.'}
      </>
    ) : null;

  return (
    <LabShell
      title="WAF Lab"
      description="Real users and attackers reach the same firewall, which sees only the request. Change the rule strictness and the mode, and watch attacks blocked, attacks missed and real users blocked."
      running={running}
      onRunningChange={setRunning}
      onReset={reset}
      legend={<WafLegend />}
      events={events}
      insight={
        <Insight>
          {!blocking ? (
            <>
              Detection only: nothing is blocked, so every attack reaches the app. The WAF log still records what it would
              have blocked - {stats.wouldBlockUsers} real-user request{stats.wouldBlockUsers === 1 ? '' : 's'} and{' '}
              {stats.wouldBlockAttacks} attack{stats.wouldBlockAttacks === 1 ? '' : 's'} so far. Those real-user matches are
              the false positives to tune away before you switch to Blocking.
            </>
          ) : exclusion && stats.missedByExclusion > 0 ? (
            <>
              The exclusion stopped the false positives on /support, but {stats.missedByExclusion} attack
              {stats.missedByExclusion === 1 ? '' : 's'} placed in that same message field walked through uninspected. An
              exclusion is a hole of an exact size - keep it to one rule, one path and one field.
            </>
          ) : level >= 3 && stats.usersBlocked > 0 ? (
            <>
              At paranoia level {level}, {stats.usersBlocked} real user request{stats.usersBlocked === 1 ? '' : 's'} got a 403
              ({pct(userFpRate)} of users) - mostly support tickets whose text looks like SQL. Lowering the whole level would
              let attacks back in; a rule exclusion for the /support message field removes only this false positive.
            </>
          ) : (
            <>
              At paranoia level {level} the WAF catches the plain attacks but misses encoded variants and disguised bots:{' '}
              {stats.attacksMissed} attack{stats.attacksMissed === 1 ? '' : 's'} reached the app. Raise the level and watch
              Attacks missed fall while Real users blocked rises.
            </>
          )}
          {idorNote}
        </Insight>
      }
      metrics={
        <>
          <MetricsPanel
            items={[
              { key: 'served', label: 'Real users served', value: stats.usersServed, tone: 'ok' },
              {
                key: 'fp',
                label: 'Real users blocked',
                value: stats.usersBlocked,
                tone: stats.usersBlocked > 0 ? 'danger' : 'ok',
                sub: `${pct(userFpRate)} of user requests`,
                hint: 'False positives: legitimate requests that matched a rule and got 403 Forbidden.',
              },
              {
                key: 'tp',
                label: 'Attacks blocked',
                value: stats.attacksBlocked,
                tone: 'ok',
                hint: 'Attack requests that matched a rule and were answered 403 by the WAF.',
              },
              {
                key: 'fn',
                label: 'Attacks missed',
                value: stats.attacksMissed,
                tone: stats.attacksMissed > 0 ? 'warn' : 'neutral',
                hint: 'False negatives: attack requests that reached the application.',
              },
              {
                key: 'harm',
                label: 'Attacks that did harm',
                value: stats.harm,
                tone: stats.harm > 0 ? 'danger' : 'ok',
                hint: 'Missed attacks the app could not refuse: string-built SQL, unencoded output, no ownership check, or a scraping bot.',
              },
              {
                key: 'would',
                label: 'Would block (detection)',
                value: stats.wouldBlockUsers + stats.wouldBlockAttacks,
                sub: `${stats.wouldBlockUsers} users, ${stats.wouldBlockAttacks} attacks`,
                hint: 'Matches logged with the COUNT action while the WAF runs in Detection only mode.',
              },
            ]}
          />
          <div className="grid gap-4 md:grid-cols-2">
            <div className="card p-4">
              <p className="label mb-3">Per request type (at this setup)</p>
              <table className="w-full font-mono text-[11px] text-muted">
                <thead>
                  <tr className="text-faint">
                    <th className="pb-1.5 text-left font-medium">type</th>
                    <th className="pb-1.5 text-right font-medium">flag chance</th>
                    <th className="pb-1.5 text-right font-medium">sent</th>
                    <th className="pb-1.5 text-right font-medium">reached app</th>
                  </tr>
                </thead>
                <tbody>
                  {KINDS.map((kind) => {
                    const attack = KIND_INFO[kind].attack;
                    return (
                      <tr key={kind}>
                        <td className="py-0.5 text-ink">{KIND_INFO[kind].label}</td>
                        <td className="py-0.5 text-right">{pct(typeChance(kind, setup))}</td>
                        <td className="py-0.5 text-right">{byKind[kind].sent}</td>
                        <td className={cn('py-0.5 text-right', attack && byKind[kind].reachedApp > 0 && 'text-warn')}>
                          {byKind[kind].reachedApp}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="card p-4">
              <p className="label mb-3">WAF log (newest first)</p>
              {logRows.length === 0 ? (
                <p className="text-xs text-faint">No rule has matched yet.</p>
              ) : (
                <ul className="space-y-1.5 font-mono text-[11px]">
                  {logRows.map((row, index) => {
                    const real = !KIND_INFO[row.kind].attack;
                    return (
                      <li key={`${row.req}-${index}`} className="flex items-center gap-2">
                        <span className="w-12 shrink-0 text-ink">r-{row.req}</span>
                        <span className="min-w-0 flex-1 truncate text-muted">{row.rule}</span>
                        <span className={cn('shrink-0', row.action === 'BLOCK' ? 'text-danger' : 'text-warn')}>
                          {row.action}
                        </span>
                        <span className={cn('w-16 shrink-0 text-right', real ? 'text-warn' : 'text-faint')}>
                          {real ? 'real user' : 'attack'}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>
          <p className="text-xs text-faint">
            {SIMULATED_HINT} Each request type has a fixed, illustrative chance to be flagged at each
            paranoia level. The real OWASP Core Rule Set adds points per matching rule (a critical match is 5) and blocks a
            request at an anomaly score of 5 or more; higher paranoia levels switch on more rules. The rule ids in the log
            are real CRS rules, picked to match the request type.
          </p>
        </>
      }
      controls={
        <>
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted">WAF mode</p>
            <SegmentedControl size="sm" className="w-full" value={mode} options={MODES} onChange={change('mode')} />
            <p className="text-[11px] text-faint">
              {blocking
                ? 'A match is logged and answered 403 Forbidden. The request never reaches the app.'
                : 'A match is only logged (COUNT). Every request reaches the app. Use it to measure false positives first.'}
            </p>
          </div>
          <Slider
            label="Rule strictness (paranoia level)"
            value={level}
            min={1}
            max={4}
            onChange={change('level')}
            format={(value) => `PL ${value}`}
            scale={['lenient', 'strict']}
            hint="Each level switches on more rules: more attacks caught, more real text that looks like an attack."
          />
          <Slider
            label="Users sending code-like text"
            value={textShare}
            min={0}
            max={0.5}
            step={0.05}
            onChange={change('textShare')}
            format={pct}
            tone="warn"
            hint="Share of real users posting support tickets with quotes, SQL words or HTML tags - legitimate, and easy to mistake for an attack."
          />
          <Slider
            label="Attack traffic"
            value={attackRate}
            min={0}
            max={4}
            step={0.5}
            onChange={change('attackRate')}
            format={(value) => `${value} / s`}
            tone="danger"
            hint="Attack requests per simulated second: SQL injection, XSS, bad bots and IDOR. Real users send 3 / s."
          />
          <Toggle
            label="Exclude rules on /support text"
            checked={exclusion}
            onChange={change('exclusion')}
            description="Skip the SQLi and XSS rules for the message field of /support only."
          />
          <Toggle
            label="Secure app code"
            checked={secureCode}
            onChange={change('secureCode')}
            description="Parameterised queries, output encoding and an ownership check on every object."
          />
          <Toggle
            label="Automatic traffic"
            checked={autoTraffic}
            onChange={change('autoTraffic')}
            description="Turn off to follow one request at a time."
          />
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted">Send one request</p>
            <div className="grid grid-cols-2 gap-2">
              {KINDS.map((kind) => (
                <Button
                  key={kind}
                  size="sm"
                  variant={KIND_INFO[kind].attack ? 'outline' : 'secondary'}
                  onClick={() => {
                    send(kind, true);
                    // A paused Lab would hold the request at the start of its wire, so the click would look lost.
                    setRunning(true);
                  }}
                >
                  {KIND_INFO[kind].label}
                </Button>
              ))}
            </div>
          </div>
        </>
      }
    >
      <DiagramCanvas layout={LAYOUT} edges={edges} particles={particleViews} height={430} className="bg-canvas">
        <ArchNode kind="client" title="Real users" subtitle={`${USER_RATE} / s, ${pct(textShare)} code-like text`} placed={LAYOUT.users} compact>
          <NodeStatRow label="Sent" value={stats.usersSent} />
          <NodeStatRow label="Got 403" value={stats.usersBlocked} tone={stats.usersBlocked > 0 ? 'text-danger' : 'text-ink'} />
        </ArchNode>
        <ArchNode
          kind="client"
          title="Attackers and bots"
          subtitle={`${attackRate} / s: SQLi, XSS, bots, IDOR`}
          placed={LAYOUT.attackers}
          compact
        >
          <NodeStatRow label="Sent" value={stats.attacksSent} />
          <NodeStatRow label="Got 403" value={stats.attacksBlocked} tone={stats.attacksBlocked > 0 ? 'text-ok' : 'text-ink'} />
        </ArchNode>
        <ArchNode
          kind="api-gateway"
          title="WAF"
          subtitle={`PL ${level} - ${blocking ? 'blocking' : 'detection only'}`}
          placed={LAYOUT.waf}
          status={blocking ? 'healthy' : 'degraded'}
          statusLabel={blocking ? 'Blocking' : 'Counting only'}
          compact
        >
          <NodeStatRow label="Inspected" value={stats.usersSent + stats.attacksSent} />
          <NodeStatRow label="Rule matches" value={stats.matches} />
          <NodeStatRow
            label="Answered 403"
            value={stats.usersBlocked + stats.attacksBlocked}
            tone={blocking ? 'text-ink' : 'text-faint'}
          />
        </ArchNode>
        <ArchNode
          kind="server"
          title="Application"
          subtitle={secureCode ? 'secure code' : 'string-built SQL, no checks'}
          placed={LAYOUT.app}
          alert={stats.harm > 0}
          compact
        >
          <NodeStatRow label="Users served" value={stats.usersServed} />
          <NodeStatRow label="Attacks reached" value={stats.attacksMissed} tone={stats.attacksMissed > 0 ? 'text-warn' : 'text-ink'} />
          <NodeStatRow label="Did harm" value={stats.harm} tone={stats.harm > 0 ? 'text-danger' : 'text-ok'} />
        </ArchNode>
        <ArchNode kind="monitoring" title="WAF log" subtitle="rule id + request id" placed={LAYOUT.log} compact>
          <NodeStatRow label="Entries" value={stats.matches} />
          <NodeStatRow
            label="Real users in it"
            value={byKind.browse.flagged + byKind.text.flagged}
            tone={byKind.browse.flagged + byKind.text.flagged > 0 ? 'text-warn' : 'text-ink'}
          />
        </ArchNode>
      </DiagramCanvas>
    </LabShell>
  );
}

/** Shapes, colours and text - status is never colour alone. */
function WafLegend() {
  return (
    <ParticleLegend
      outcomes={[
        { outcome: 'success', label: 'Real user request' },
        { outcome: 'warning', label: 'Attack or bad bot' },
        { outcome: 'failure', label: '403 Forbidden from the WAF' },
        { outcome: 'cache-hit', label: 'Rule match written to the log' },
      ]}
    />
  );
}

export default WafLab;
