import { useMemo, useRef, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight, Globe, Lock, LockOpen } from 'lucide-react';
import {
  ArchNode,
  DiagramCanvas,
  NodeStatRow,
  ParticleLegend,
  type DiagramEdge,
  type Layout,
  type ParticleView,
} from '@/components/architecture';
import { Insight, LabShell, MetricsPanel } from '@/components/learning';
import { CONCEPT_BY_SLUG } from '@/data/concepts';
import { Badge, Button, SegmentedControl, Slider, Toggle } from '@/components/ui';
import { useTicker } from '@/simulations/engine';
import { useLabSetup } from '@/hooks/useLabSetup';
import { useRerender } from '@/hooks/useRerender';
import { cn } from '@/utils/cn';
import { clamp } from '@/utils/math';
import { formatLatency } from '@/utils/format';
import type { LabProps } from '@/types';
import {
  APP_MS,
  CDN_HOST,
  EDGE_RTT_MS,
  MACHINE_CACHES,
  RESOLVER_CACHE_AGE_S,
  RESOLVER_RTT_MS,
  TTL_OPTIONS,
  dnsAnswer,
  dnsState,
  formatTtl,
  frontOf,
  frontRttOf,
  inScope,
  journeyTotals,
  planJourney,
  type DnsState,
  type NodeId,
  type ResolverCache,
  type Scope,
  type StageId,
  type StagePlan,
} from './urlJourneyModel';
import { drawnOutcomes, playedStages, shownControls, startSetup, type Setup } from './urlJourneySetup';
import { useLabRunning } from '@/hooks/useLabRunning';

const SCOPES: { value: Scope; label: string; note: string }[] = [
  { value: 'all', label: 'All', note: 'The whole journey, from Enter to painted pixels.' },
  { value: 'dns', label: 'DNS', note: 'Resolver, root, .com TLD and authoritative server.' },
  { value: 'connect', label: 'Connect', note: 'The TCP and TLS handshakes.' },
  { value: 'http', label: 'HTTP', note: 'The request out and the response back.' },
];

const RESOLVER_OPTIONS: { value: ResolverCache; label: string }[] = [
  { value: 'never', label: 'Never' },
  { value: '30s', label: '30 s' },
  { value: '10min', label: '10 min' },
  { value: '3h', label: '3 h' },
];

const LAYOUT: Record<NodeId, Layout[string]> = {
  browser: { x: 30, y: 167, w: 176, h: 106 },
  resolver: { x: 290, y: 89, w: 180, h: 128 },
  root: { x: 580, y: 10, w: 210, h: 83 },
  tld: { x: 580, y: 111, w: 210, h: 83 },
  auth: { x: 580, y: 212, w: 210, h: 83 },
  edge: { x: 30, y: 356, w: 172, h: 122 },
  lb: { x: 270, y: 356, w: 180, h: 122 },
  app: { x: 510, y: 356, w: 150, h: 122 },
  cache: { x: 740, y: 310, w: 150, h: 106 },
  db: { x: 740, y: 432, w: 150, h: 90 },
};
const CANVAS_HEIGHT = 536;

/**
 * On screen a hop takes longer when its simplified latency is longer, so a
 * trip to a far origin visibly drags next to a trip to a nearby edge. Real
 * hops take milliseconds; these are slowed down to be followed by eye.
 */
const hopSeconds = (ms: number) => clamp(0.35 + ms * 0.006, 0.35, 1.3);
const dwellSeconds = (ms: number) => clamp(0.45 + ms * 0.006, 0.45, 1.3);
/** Pause after the last stage before the loop starts again. */
const LOOP_GAP_S = 1;

interface Sim {
  stageId: StageId;
  hop: number;
  /** Progress along the current hop, or through the current dwell, 0..1. */
  t: number;
  /** Seconds left in the pause at the end of the loop. */
  gap: number;
}

const createSim = (setup: Setup): Sim => ({ stageId: setup.startStage, hop: 0, t: 0, gap: 0 });

const NODE_NAME: Record<NodeId, string> = {
  browser: 'the browser',
  resolver: 'the resolver',
  root: 'a root server',
  tld: 'the .com TLD server',
  auth: 'the authoritative server',
  edge: 'the CDN edge',
  lb: 'the origin load balancer',
  app: 'the app server',
  cache: 'the cache',
  db: 'the database',
};

export function UrlJourneyLab({ focus }: LabProps<'url-journey'>) {
  // The page keys this lab by Concept, so the focus never changes under a mounted lab.
  const start = startSetup(focus);
  // Every control lives in one object, so Reset cannot miss one.
  const { setup, setSetup, change } = useLabSetup(start);

  const [running, setRunning] = useLabRunning();
  const sim = useRef<Sim>(createSim(start));
  const rerender = useRerender(30);

  const plans = useMemo(() => planJourney(setup), [setup]);
  const dns = dnsState(setup);
  const answer = dnsAnswer(setup);
  const totals = journeyTotals(plans);
  const coldSetup = journeyTotals(planJourney({ ...setup, warm: false, resolverCache: 'never' })).setup;
  const order = playedStages(plans, setup.scope);
  // The legend lists only the shapes this setup draws, and the focus decides which controls show.
  const outcomes = drawnOutcomes(setup, plans);
  const shows = new Set(shownControls(setup));

  useTicker(running, (dt) => {
    const state = sim.current;
    if (order.length === 0) {
      rerender();
      return;
    }
    if (state.gap > 0) {
      state.gap -= dt;
      if (state.gap <= 0) Object.assign(state, { stageId: order[0].id, hop: 0, t: 0, gap: 0 });
      rerender();
      return;
    }
    let index = order.findIndex((stage) => stage.id === state.stageId);
    // A control just removed this stage (a cache hit, a reused connection): start the loop again.
    if (index < 0) {
      Object.assign(state, { stageId: order[0].id, hop: 0, t: 0 });
      index = 0;
    }
    const stage = order[index];
    const steps = Math.max(stage.hops.length, 1);
    if (state.hop >= steps) Object.assign(state, { hop: 0, t: 0 });
    const duration = stage.hops.length ? hopSeconds(stage.ms / stage.hops.length) : dwellSeconds(stage.ms);
    state.t += dt / duration;
    if (state.t >= 1) {
      state.t = 0;
      state.hop += 1;
      if (state.hop >= steps) {
        state.hop = 0;
        if (index + 1 < order.length) state.stageId = order[index + 1].id;
        else state.gap = LOOP_GAP_S;
      }
    }
    rerender();
  });

  const jumpTo = (stage: StagePlan) => {
    if (!inScope(stage, setup.scope)) change('scope')(stage.group ?? 'all');
    sim.current = { stageId: stage.id, hop: 0, t: 0, gap: 0 };
    rerender();
  };

  const replay = () => {
    sim.current = { stageId: order[0]?.id ?? setup.startStage, hop: 0, t: 0, gap: 0 };
    setRunning(true);
    rerender();
  };

  const reset = () => {
    setSetup(start);
    sim.current = createSim(start);
  };

  // ---- What the diagram shows this frame --------------------------------
  const state = sim.current;
  const current = order.find((stage) => stage.id === state.stageId) ?? order[0];
  const hop = current && state.gap <= 0 && current.hops.length ? current.hops[Math.min(state.hop, current.hops.length - 1)] : null;
  const particles: ParticleView[] = hop
    ? [{ id: 1, from: hop.from, to: hop.to, t: state.t, outcome: hop.outcome, highlighted: true }]
    : [];
  const touched = new Set<NodeId>(current && state.gap <= 0 ? current.nodes : []);
  const front = frontOf(setup);
  const skipped = (id: StageId) => Boolean(plans.find((stage) => stage.id === id)?.skipped);
  const onWire = (a: NodeId, b: NodeId) => Boolean(hop && ((hop.from === a && hop.to === b) || (hop.from === b && hop.to === a)));

  const edge = (from: NodeId, to: NodeId, unused: boolean, extra: Partial<DiagramEdge> = {}): DiagramEdge => ({
    from,
    to,
    tone: onWire(from, to) ? 'brand' : unused ? 'muted' : 'default',
    dashed: unused,
    width: onWire(from, to) ? 2.5 : undefined,
    ...extra,
  });
  const edges: DiagramEdge[] = [
    edge('browser', 'resolver', skipped('dns-ask')),
    edge('resolver', 'root', skipped('dns-root')),
    edge('resolver', 'tld', skipped('dns-tld')),
    edge('resolver', 'auth', skipped('dns-auth')),
    edge('browser', front, false, { label: setup.https ? 'TLS' : 'plaintext', tone: onWire('browser', front) ? 'brand' : setup.https ? 'default' : 'warn' }),
    ...(setup.cdn ? [edge('edge', 'lb', false)] : []),
    edge('lb', 'app', false),
    edge('app', 'cache', false),
    edge('app', 'db', skipped('db')),
  ];

  const asked = (id: StageId) => (skipped(id) ? 'Not asked' : 'Asked');
  const scheme = setup.https ? 'https' : 'http';
  const scopeNote = SCOPES.find((item) => item.value === setup.scope)?.note;

  return (
    <LabShell
      title="What Happens When You Type a URL?"
      description="One request walks every part between pressing Enter and seeing a page. Pick which part of the journey plays, change what is cached, and watch the path and the time change."
      running={running}
      onRunningChange={setRunning}
      onReset={reset}
      actions={
        <Button variant="primary" onClick={replay}>
          <Globe className="h-4 w-4" />
          Replay from the first stage
        </Button>
      }
      legend={
        <div className="space-y-1.5">
          {outcomes.length > 0 ? (
            <ParticleLegend
              outcomes={outcomes.map((outcome) =>
                outcome === 'warning' ? { outcome, label: 'Plain HTTP: readable on the path' } : outcome,
              )}
            />
          ) : null}
          <p className="text-[11px] text-faint">
            One request at a time, slowed down to be followed by eye; a longer hop moves slower. Timings are simplified
            round trips for illustration, not measurements.
          </p>
        </div>
      }
      insight={
        current ? (
          <Insight title={current.title}>
            {detailFor(current, setup, dns)}
            {current.concept ? (
              <span className="mt-2 block text-xs text-faint">
                Related concept:{' '}
                <Link to={`/concepts/${current.concept}`} className="text-brand hover:underline">
                  {CONCEPT_BY_SLUG.get(current.concept)?.title ?? current.concept.replace(/-/g, ' ')}
                </Link>
              </span>
            ) : null}
          </Insight>
        ) : (
          <Insight title="Nothing to walk here">
            The browser reuses an open connection to example.com, so this part of the journey does not happen at all:
            no DNS lookup, no TCP handshake, no TLS handshake. Turn Warm connection off to watch it again.
          </Insight>
        )
      }
      metrics={
        <MetricsPanel
          items={[
            { key: 'total', label: 'Total time', value: formatLatency(totals.total), tone: totals.total > 300 ? 'warn' : 'ok', simulated: true },
            { key: 'stages', label: 'Stages', value: totals.stages, hint: 'Stages that happen in this setup. Skipped ones are greyed out in the list.' },
            {
              key: 'setup',
              label: 'Connection setup',
              value: formatLatency(totals.setup),
              tone: totals.setup > 100 ? 'warn' : 'ok',
              hint: 'DNS + TCP + TLS - paid before the request is even sent.',
              simulated: true,
            },
            {
              key: 'backend',
              label: 'Backend time',
              value: formatLatency(totals.backend),
              hint: 'Load balancer, app server, cache and database - everything your servers control.',
              simulated: true,
            },
            {
              key: 'render',
              label: 'Rendering',
              value: formatLatency(totals.render),
              tone: 'violet',
              hint: 'Parse, layout and paint in the browser. Often larger than the entire backend time.',
              simulated: true,
            },
          ]}
        />
      }
      controls={
        <>
          {shows.has('scope') ? (
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted">Play</p>
              <SegmentedControl
                size="sm"
                className="w-full"
                value={setup.scope}
                options={SCOPES.map(({ value, label }) => ({ value, label }))}
                onChange={(value) => {
                  change('scope')(value);
                  const first = plans.find((stage) => inScope(stage, value) && !stage.skipped);
                  sim.current = { stageId: first?.id ?? sim.current.stageId, hop: 0, t: 0, gap: 0 };
                }}
              />
              <p className="text-[11px] text-faint">{scopeNote} The request walks it in a loop.</p>
            </div>
          ) : null}
          {shows.has('warm') ? (
            <Toggle
              label="Warm connection"
              checked={setup.warm}
              onChange={change('warm')}
              description="Reuse an open, encrypted connection: no DNS, TCP or TLS"
            />
          ) : null}
          {!shows.has('resolver') && dns.answerCached ? (
            <p className={cn('text-[11px] text-faint', setup.warm && 'opacity-50')}>
              The resolver looked example.com up {formatTtl(RESOLVER_CACHE_AGE_S[setup.resolverCache] ?? 0)} ago and the
              TTL is {formatTtl(setup.ttlS)}, so it answers from its cache: root, .com and the authoritative server are not
              asked. The cached answer is the {answer.address}. HTTPS uses TLS 1.3.
            </p>
          ) : null}
          {shows.has('resolver') ? (
            <div className={cn('space-y-2', setup.warm && 'opacity-50')}>
              <p className="text-xs font-medium text-muted">Resolver last looked up example.com</p>
              <SegmentedControl
                size="sm"
                className="w-full"
                value={setup.resolverCache}
                options={RESOLVER_OPTIONS}
                onChange={change('resolverCache')}
              />
              <p className="text-xs font-medium text-muted">Record TTL</p>
              <SegmentedControl
                size="sm"
                className="w-full"
                value={String(setup.ttlS)}
                options={TTL_OPTIONS.map(({ value, label }) => ({ value: String(value), label }))}
                onChange={(value) => change('ttlS')(Number(value))}
              />
              <p className="text-[11px] text-faint">
                {dns.answerCached
                  ? `Cached answer is younger than the TTL: the resolver answers at once, ${formatTtl(dns.ttlLeftS ?? 0)} left.`
                  : RESOLVER_CACHE_AGE_S[setup.resolverCache] === null
                    ? 'Empty cache: the resolver walks root, .com and the authoritative server.'
                    : 'Cached answer is older than the TTL: expired, so the resolver asks again.'}
              </p>
            </div>
          ) : null}
          {shows.has('https') ? (
            <Toggle
              label="HTTPS"
              checked={setup.https}
              onChange={change('https')}
              description="Off: plain HTTP, no TLS handshake, readable on the path"
            />
          ) : null}
          {shows.has('tls') ? (
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted">TLS version</p>
              <SegmentedControl
                size="sm"
                className="w-full"
                value={setup.tls}
                options={[
                  { value: '1.2', label: 'TLS 1.2 (2 round trips)' },
                  { value: '1.3', label: 'TLS 1.3 (1 round trip)' },
                ]}
                onChange={change('tls')}
              />
            </div>
          ) : null}
          {shows.has('cdn') ? (
            <Toggle
              label="CDN in front"
              checked={setup.cdn}
              onChange={change('cdn')}
              description={`DNS points example.com at the CDN, so handshakes end at an edge ${EDGE_RTT_MS} ms away. This page is dynamic, so the edge forwards it`}
            />
          ) : null}
          {shows.has('originRtt') ? (
            <Slider
              label="Round trip to the origin"
              value={setup.originRttMs}
              min={20}
              max={250}
              step={10}
              onChange={change('originRttMs')}
              format={(value) => `${value} ms`}
              hint="About 20 ms in the same country, 100-150 ms across an ocean. Simplified."
            />
          ) : null}
          {shows.has('cacheHit') ? (
            <Toggle
              label="Cache hit"
              checked={setup.cacheHit}
              onChange={change('cacheHit')}
              description="Off: the request reaches the database"
            />
          ) : null}
          <div className="border-t border-line pt-4 text-[11px] text-muted">
            <p className="label mb-2">Notice</p>
            <p>
              On a cold connection with an empty resolver cache, DNS + TCP + TLS cost {formatLatency(coldSetup)} in this
              setup before your server does anything at all. That is why connection reuse, DNS caching and a nearby edge
              matter as much as backend optimisation.
            </p>
          </div>
        </>
      }
    >
      <div className="space-y-4 p-4 sm:p-5">
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-elevated px-4 py-2.5 font-mono text-sm">
          {setup.https ? (
            <Lock className="h-4 w-4 text-ok" aria-hidden />
          ) : (
            <LockOpen className="h-4 w-4 text-warn" aria-hidden />
          )}
          <span className="text-faint">{scheme}://</span>
          <span className="text-ink">example.com</span>
          <span className="text-faint">/products/42</span>
          <span className="ml-auto flex flex-wrap gap-2">
            <Badge tone={setup.https ? 'ok' : 'warn'}>{setup.https ? 'Encrypted' : 'Not encrypted'}</Badge>
            <Badge tone="brand">{formatLatency(totals.total)} total</Badge>
          </span>
        </div>

        <DiagramCanvas height={CANVAS_HEIGHT} layout={LAYOUT} edges={edges} particles={particles}>
          <ArchNode kind="client" title="Browser" subtitle={`${scheme}://example.com`} placed={LAYOUT.browser} selected={touched.has('browser')}>
            <NodeStatRow label="Connection" value={setup.warm ? 'reused' : 'new'} tone={setup.warm ? 'text-ok' : 'text-ink'} />
          </ArchNode>
          <ArchNode
            kind="dns"
            title="Resolver"
            subtitle={`recursive, ${RESOLVER_RTT_MS} ms away`}
            placed={LAYOUT.resolver}
            selected={touched.has('resolver')}
            statusLabel={asked('dns-ask')}
            className={cn(skipped('dns-ask') && 'opacity-60')}
          >
            <NodeStatRow
              label="Cache"
              value={dns.answerCached ? `hit, ${formatTtl(dns.ttlLeftS ?? 0)} left` : 'miss'}
              tone={dns.answerCached ? 'text-ok' : 'text-warn'}
            />
            <NodeStatRow label="Answer" value={answer.address} />
          </ArchNode>
          <ArchNode
            kind="dns"
            title="Root server"
            subtitle="refers you to .com"
            placed={LAYOUT.root}
            selected={touched.has('root')}
            statusLabel={asked('dns-root')}
            className={cn(skipped('dns-root') && 'opacity-60')}
          />
          <ArchNode
            kind="dns"
            title=".com TLD server"
            subtitle="refers you to example.com"
            placed={LAYOUT.tld}
            selected={touched.has('tld')}
            statusLabel={asked('dns-tld')}
            className={cn(skipped('dns-tld') && 'opacity-60')}
          />
          <ArchNode
            kind="dns"
            title="Authoritative"
            subtitle={answer.authSubtitle}
            placed={LAYOUT.auth}
            selected={touched.has('auth')}
            statusLabel={asked('dns-auth')}
            className={cn(skipped('dns-auth') && 'opacity-60')}
          />
          {setup.cdn ? (
            <ArchNode kind="cdn" title="CDN edge" subtitle={`anycast, ${EDGE_RTT_MS} ms away`} placed={LAYOUT.edge} selected={touched.has('edge')}>
              <NodeStatRow label="This page" value="miss, forward" tone="text-warn" />
            </ArchNode>
          ) : null}
          <ArchNode
            kind="load-balancer"
            title="Load balancer"
            subtitle={`origin, ${setup.originRttMs} ms away`}
            placed={LAYOUT.lb}
            selected={touched.has('lb')}
          >
            <NodeStatRow
              label="Browser TLS"
              value={!setup.https ? 'none' : setup.cdn ? 'ends at edge' : 'ends here'}
              tone={setup.https ? 'text-ink' : 'text-warn'}
            />
          </ArchNode>
          <ArchNode kind="server" title="App server" subtitle="your code" placed={LAYOUT.app} selected={touched.has('app')}>
            <NodeStatRow label="Work" value={`${APP_MS} ms`} />
          </ArchNode>
          <ArchNode kind="cache" title="Cache" subtitle="Redis" placed={LAYOUT.cache} selected={touched.has('cache')}>
            <NodeStatRow label="Page data" value={setup.cacheHit ? 'hit' : 'miss'} tone={setup.cacheHit ? 'text-ok' : 'text-warn'} />
          </ArchNode>
          <ArchNode
            kind="sql"
            title="Database"
            subtitle="indexed query"
            placed={LAYOUT.db}
            selected={touched.has('db')}
            status={setup.cacheHit ? 'idle' : 'healthy'}
            statusLabel={setup.cacheHit ? 'Not asked' : 'Queried'}
            className={cn(setup.cacheHit && 'opacity-60')}
          />
        </DiagramCanvas>

        <ol className="space-y-1.5">
          {plans.map((stage, index) => {
            const isActive = current?.id === stage.id;
            const faded = !inScope(stage, setup.scope);
            const share = totals.total > 0 ? (stage.ms / totals.total) * 100 : 0;
            const number = <span className="font-mono text-[11px] text-faint">{String(index + 1).padStart(2, '0')}</span>;
            if (stage.skipped) {
              return (
                <li
                  key={stage.id}
                  className={cn('flex items-center gap-3 rounded-xl border border-dashed border-line px-3.5 py-2 opacity-60', faded && 'opacity-40')}
                >
                  {number}
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-muted line-through decoration-faint">{stage.title}</span>
                    <span className="block text-xs text-faint">{stage.skipped}</span>
                  </span>
                  <span className="w-16 shrink-0 text-right font-mono text-xs text-faint">skipped</span>
                </li>
              );
            }
            return (
              <li key={stage.id}>
                <button
                  type="button"
                  onClick={() => jumpTo(stage)}
                  aria-current={isActive ? 'step' : undefined}
                  className={cn(
                    'flex w-full items-center gap-3 rounded-xl border px-3.5 py-2.5 text-left transition-colors',
                    isActive ? 'border-brand bg-brand/10' : 'border-line hover:border-brand/40',
                    faded && !isActive && 'opacity-50',
                  )}
                >
                  {number}
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-ink">{stage.title}</span>
                    <span className="block text-xs text-faint">{stage.short}</span>
                  </span>
                  <span className="hidden h-2 w-32 overflow-hidden rounded-full bg-line sm:block">
                    <span className="block h-full rounded-full bg-brand" style={{ width: `${Math.max(share, 2)}%` }} />
                  </span>
                  <span className="w-16 shrink-0 text-right font-mono text-xs text-ink">{formatLatency(stage.ms)}</span>
                  <ChevronRight className={cn('h-4 w-4 shrink-0 text-faint', isActive && 'text-brand')} />
                </button>
              </li>
            );
          })}
        </ol>
      </div>
    </LabShell>
  );
}

/** What the selected stage does, in this setup. Numbers are the simplified ones the Lab uses. */
function detailFor(stage: StagePlan, setup: Setup, dns: DnsState): ReactNode {
  const frontName = NODE_NAME[frontOf(setup)];
  const frontRtt = formatLatency(frontRttOf(setup));
  const age = RESOLVER_CACHE_AGE_S[setup.resolverCache];
  const ttl = formatTtl(setup.ttlS);
  const plaintext =
    ' This is plain HTTP: every router, Wi-Fi hotspot and ISP on the path can read it - the path, the cookies, a password in a form - and can change it on the way. The triangles on the wire mark readable traffic.';

  switch (stage.id) {
    case 'browser':
      return (
        `The browser parses the URL and checks its HSTS list. Then it looks for a stored copy of the page, in this order: a ${MACHINE_CACHES[0]}, if the site registered one, sees the request first; then the ${MACHINE_CACHES[1]}. A fresh copy in either ends the journey right here - the fastest request is the one never sent.` +
        (setup.warm
          ? ' Neither has one, and a connection to example.com is already open, so the browser needs no address: the request goes out on that connection.'
          : ` Neither has one, so the browser needs the address of example.com: it checks the ${MACHINE_CACHES[2]}, then the ${MACHINE_CACHES[3]} (and the hosts file). This browser has not visited lately, so all ${MACHINE_CACHES.length} caches on the machine miss. The fifth, the resolver cache, comes next.`) +
        (setup.https
          ? ''
          : ' This Lab pretends example.com is not on the HSTS list: if it were, the browser would rewrite http:// to https:// at this point, before anything leaves the machine.')
      );
    case 'dns-ask':
      return dns.answerCached
        ? `The browser, through the operating system, asks a recursive resolver (usually run by the ISP or a public DNS service) for the address of example.com. The resolver looked it up ${formatTtl(age ?? 0)} ago and the TTL is ${ttl}, so it answers straight from its cache - the diamond coming back. ${
            setup.cdn
              ? 'The address it stored is that of a CDN edge: the owner points example.com at the CDN, so the edge is where the browser connects next.'
              : 'The address it stored is that of the origin load balancer.'
          } It may reuse that answer for ${formatTtl(dns.ttlLeftS ?? 0)} more: a record change made now reaches users of this resolver only after that.`
        : age === null
          ? 'The browser, through the operating system, asks a recursive resolver (usually run by the ISP or a public DNS service) for the address of example.com. Its cache is empty, so the resolver does the whole walk for the browser: root, then .com, then the authoritative server.'
          : `The browser asks the recursive resolver for example.com. The resolver looked it up ${formatTtl(age)} ago, but the TTL is only ${ttl}, so that copy has expired and it must ask again. It still remembers the .com servers, so it skips the root.`;
    case 'dns-root':
      return 'A root server does not know the address of example.com. It only refers the resolver to the servers for .com. That referral carries a TTL of two days, so a busy resolver almost never asks a root server - this one does only because its cache is empty.';
    case 'dns-tld':
      return 'The .com TLD server does not know the address either. It refers the resolver to the authoritative nameservers that the owner of example.com registered.';
    case 'dns-auth':
      return `${
        setup.cdn
          ? `The authoritative nameserver owns the answer, and the owner has pointed example.com at the CDN name ${CDN_HOST}. On a name such as www that is a CNAME; a bare domain cannot hold one, so here it is an ALIAS: the authoritative server looks the CDN name up itself and returns the address of an edge. CDNs usually give every edge the same anycast address, so the network carries the browser to the nearest one. The answer has a TTL of ${ttl}; the resolver caches it for that long and hands the edge address back to the browser.`
          : `The authoritative nameserver owns the answer: the A record of example.com, the address of the origin load balancer, with a TTL of ${ttl}. The resolver caches it for that long and hands the address back to the browser.`
      } A long TTL means fewer lookups; a short one means a change takes effect sooner. Nothing is pushed to caches - they simply wait for the TTL to run out.`;
    case 'tcp':
      return `SYN, then SYN-ACK: one full round trip to ${frontName} (${frontRtt}) before any data can move; the final ACK travels with the next message. ${
        setup.cdn
          ? 'DNS gave the browser the address of an edge nearby, so it connects there, not to the far origin - and this handshake is cheap.'
          : 'With no CDN this round trip goes all the way to the origin. Turn the CDN on and watch it shrink.'
      }`;
    case 'tls':
      return `The server sends a certificate for example.com, signed through a chain that ends at a root the browser already trusts, and both sides agree on fresh session keys. TLS ${setup.tls} needs ${
        setup.tls === '1.3' ? 'one round trip' : 'two round trips'
      } here (${formatLatency(stage.ms)}); TLS 1.3 cut the handshake from two round trips to one. ${
        setup.cdn
          ? 'The CDN edge holds the certificate and ends this TLS connection; it opens its own encrypted connection to the origin.'
          : 'The load balancer holds the certificate and ends this TLS connection.'
      }`;
    case 'request':
      return (
        'GET /products/42 - the method, the path, the headers and the cookies travel to ' +
        frontName +
        '. The method tells every cache and proxy what is safe: a GET may be cached and retried, a POST may not.' +
        (setup.https ? ' Inside TLS, only the two ends can read or change any of it.' : plaintext)
      );
    case 'cdn':
      return `The edge checks its cache. This page is made for each user, so it is a miss and the edge forwards the request to the origin over a connection it keeps open - about half of the ${setup.originRttMs} ms origin round trip each way. Static files such as images and scripts would be answered right here.`;
    case 'lb':
      return (
        'The load balancer picks a healthy application server and forwards the request.' +
        (!setup.cdn && setup.https ? ' With no CDN in front it is also where the browser TLS connection ends.' : '')
      );
    case 'app':
      return 'Routing, authentication, authorization and business logic. Usually a small part of the total, unless something downstream is slow.';
    case 'cache':
      return setup.cacheHit
        ? 'Redis has this data: it answers in a couple of milliseconds and the database is never touched.'
        : 'Redis does not have it, so the server pays for the database query next and then stores the result for the next request.';
    case 'db':
      return 'With an index this is a handful of page reads. Without one it is a full table scan - that difference is the whole point of an index.';
    case 'response':
      return (
        '200 OK, headers and a body travel back the way the request came. Headers such as Cache-Control and ETag decide whether the edge and the browser may reuse this response next time.' +
        (setup.https ? '' : plaintext)
      );
    case 'render':
      return 'The browser parses the HTML into the DOM and the CSS into style rules, then lays out and paints. Render-blocking scripts and styles here often cost more than everything the backend did.';
  }
}

export default UrlJourneyLab;
