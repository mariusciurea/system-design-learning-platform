import { useCallback, useRef } from 'react';
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
import { SegmentedControl, Slider, Toggle } from '@/components/ui';
import {
  advanceParticles,
  MetricWindow,
  nextParticleId,
  RateCounter,
  useEventLog,
  useTicker,
  visualShare,
  type Particle,
} from '@/simulations/engine';
import { useLabSetup } from '@/hooks/useLabSetup';
import { useRerender } from '@/hooks/useRerender';
import { sampleArrivals } from '@/utils/math';
import { formatLatency, formatNumber, formatPercent } from '@/utils/format';
import type { LabFocus, LabProps } from '@/types';
import { useLabRunning } from '@/hooks/useLabRunning';

/** Where the one proxy sits: nowhere, with the clients, or with the servers. */
type Placement = 'none' | 'client' | 'server';

interface Setup {
  placement: Placement;
  /** The proxy reads HTTP: TLS interception on the client side, TLS termination on the server side. */
  decrypt: boolean;
  cache: boolean;
  /** The proxy adds X-Forwarded-For with the laptop address. */
  forwardIp: boolean;
  /** Forward proxy only: deny hostnames that are not on the allow-list. */
  allowList: boolean;
  traffic: number;
  /** Share of requests that ask for something already asked for, so a warm cache can answer it. */
  repeatShare: number;
}

/** What the lab opens on at /labs/proxy: no proxy yet, so the learner places it. */
const DEFAULT_SETUP: Setup = {
  placement: 'none',
  decrypt: true,
  cache: true,
  forwardIp: false,
  allowList: false,
  traffic: 200,
  repeatShare: 0.6,
};

/**
 * The Lab focus of each Concept that hosts this lab. Reverse Proxy opens with the
 * proxy in front of the app servers, terminating TLS and passing the client IP on.
 * Forward Proxy opens with the proxy in front of the laptops, tunnelling HTTPS and
 * enforcing an allow-list - so the site sees one caller for every laptop.
 */
const FOCUS_SETUPS: Record<LabFocus<'proxy'>, Setup> = {
  'reverse-proxy': { ...DEFAULT_SETUP, placement: 'server', decrypt: true, cache: true, forwardIp: true },
  'forward-proxy': { ...DEFAULT_SETUP, placement: 'client', decrypt: false, cache: true, allowList: true },
};

const PLACEMENTS: { value: Placement; label: string }[] = [
  { value: 'none', label: 'No proxy' },
  { value: 'client', label: 'Client side' },
  { value: 'server', label: 'Server side' },
];

/**
 * Addresses from the documentation ranges (RFC 5737), plus private ones inside the
 * server network. Simplified: each laptop has its own public address (no NAT).
 * Without a reverse proxy nothing sits in front of the two app servers, so each has
 * its own public address and DNS for shop.example returns both (round robin). The
 * proxy pair shares one floating address that only one of them holds at a time.
 */
const IP = {
  laptops: ['198.51.100.21', '198.51.100.22'],
  forwardProxy: '198.51.100.1',
  reverseProxyPublic: '192.0.2.10',
  reverseProxyInside: '10.0.0.2',
  appPublic: '192.0.2.50-51',
  appPrivate: '10.0.1.5-6',
} as const;

const LAPTOPS = ['laptop-1', 'laptop-2'] as const;

/**
 * Round-trip costs in ms. A simplified model, not a measurement - real numbers
 * depend on distance, routing and load. The UI says so next to every latency.
 */
const COST = {
  lan: 2, // laptop <-> forward proxy, same office
  internet: 40, // across the internet to the data center
  dataCenter: 1, // reverse proxy <-> app server, same rack or zone
  proxy: 1, // proxy work per request
  app: 20, // the app building the response
};

/** Share of laptop traffic heading to a site that is not on the allow-list. */
const BLOCKED_SHARE = 0.2;

const ANIMATED_PER_SECOND = 28;
const PARTICLE_BUDGET = 90;
const LOG_EVERY_MS = 700;

/** Two proxy slots, one per side; the one proxy node moves between them. */
const PROXY_SLOT: Record<Exclude<Placement, 'none'>, { x: number; y: number; w: number; h: number }> = {
  client: { x: 186, y: 120, w: 184, h: 120 },
  server: { x: 554, y: 120, w: 184, h: 120 },
};

const BASE_LAYOUT: Layout = {
  'laptop-1': { x: 16, y: 50, w: 140, h: 80 },
  'laptop-2': { x: 16, y: 230, w: 140, h: 80 },
  internet: { x: 399, y: 140, w: 132, h: 80 },
  app: { x: 780, y: 120, w: 170, h: 120 },
};

const HEIGHT = 350;

interface LogLine {
  id: number;
  peer: string;
  xff: string;
  path: string;
}

interface State {
  particles: Particle[];
  requests: RateCounter;
  proxied: RateCounter;
  hits: RateCounter;
  denied: RateCounter;
  origin: RateCounter;
  latency: MetricWindow;
  log: LogLine[];
  lastLogAt: number;
}

const createState = (): State => ({
  particles: [],
  requests: new RateCounter(3000),
  proxied: new RateCounter(3000),
  hits: new RateCounter(3000),
  denied: new RateCounter(3000),
  origin: new RateCounter(3000),
  latency: new MetricWindow(400),
  log: [],
  lastLogAt: 0,
});

/** Everything the diagram, the "who sees what" card and the insight read from one setup. */
function describe(setup: Setup) {
  const { placement, decrypt } = setup;
  const readsHttp = placement !== 'none' && decrypt;
  const cacheWorks = readsHttp && setup.cache;
  const forwardsIp = readsHttp && setup.forwardIp;
  const allowListOn = placement === 'client' && setup.allowList;

  const peerFor = (laptop: number) =>
    placement === 'none' ? IP.laptops[laptop] : placement === 'client' ? IP.forwardProxy : IP.reverseProxyInside;

  const actsFor = placement === 'none' ? 'Nobody - there is no proxy' : placement === 'client' ? 'The laptops (clients)' : 'The app servers';
  const hides =
    placement === 'none'
      ? 'Nothing'
      : placement === 'client'
        ? forwardsIp
          ? 'Nothing any more - X-Forwarded-For names each laptop'
          : 'The laptop addresses, from the site'
        : 'The app server addresses, from the laptops';
  const laptopsConnectTo =
    placement === 'none'
      ? `shop.example = ${IP.appPublic}, DNS round robin across the two app servers`
      : placement === 'client'
        ? `The proxy at ${IP.forwardProxy}, asking for shop.example`
        : `shop.example = ${IP.reverseProxyPublic}, the proxy`;
  const tlsEndsAt =
    placement === 'none'
      ? 'App servers'
      : placement === 'client'
        ? decrypt
          ? 'Forward proxy, which opens a new TLS session to the site'
          : 'App servers - the proxy tunnels bytes and sees only the hostname'
        : decrypt
          ? 'Reverse proxy - plain HTTP inside the server network'
          : 'App servers - the proxy passes encrypted bytes through';
  const originSees =
    placement === 'none'
      ? `${IP.laptops[0]} and ${IP.laptops[1]}, each laptop`
      : placement === 'client'
        ? forwardsIp
          ? `${IP.forwardProxy}, plus X-Forwarded-For with the laptop`
          : `${IP.forwardProxy}, the proxy, for every laptop`
        : forwardsIp
          ? `${IP.reverseProxyInside}, plus X-Forwarded-For with the laptop`
          : `${IP.reverseProxyInside}, the proxy, for every request`;

  const miss =
    placement === 'none'
      ? COST.internet + COST.app
      : placement === 'client'
        ? COST.lan + COST.proxy + COST.internet + COST.app
        : COST.internet + COST.proxy + COST.dataCenter + COST.app;
  const hit = placement === 'client' ? COST.lan + COST.proxy : COST.internet + COST.proxy;
  const latencies = cacheWorks ? `Hit ${hit} ms, miss ${miss} ms (model)` : `${miss} ms, nothing cached (model)`;

  return {
    readsHttp,
    cacheWorks,
    forwardsIp,
    allowListOn,
    peerFor,
    actsFor,
    hides,
    laptopsConnectTo,
    tlsEndsAt,
    originSees,
    latencies,
  };
}

export function ProxyLab({ focus }: LabProps<'proxy'>) {
  // The page keys this lab by Concept, so the focus never changes under a mounted lab.
  const start = focus ? FOCUS_SETUPS[focus] : DEFAULT_SETUP;
  // Every control lives in one object, so Reset cannot miss one.
  const { setup, setSetup, change } = useLabSetup(start);
  const [running, setRunning] = useLabRunning();
  const state = useRef<State>(createState());
  const rerender = useRerender(30);
  const { events, log, clear } = useEventLog();

  const { placement, decrypt, cache, forwardIp, allowList, traffic, repeatShare } = setup;
  const view = describe(setup);

  const reset = useCallback(() => {
    // Back to this Concept's starting setup, not the lab's global default.
    setSetup(start);
    state.current = createState();
    clear();
  }, [start, clear, setSetup]);

  const place = (value: Placement) => {
    change('placement')(value);
    state.current = createState();
    log(
      value === 'none'
        ? 'Proxy removed - each laptop talks to shop.example directly'
        : value === 'client'
          ? 'Proxy moved to the client side - it now acts for the laptops'
          : 'Proxy moved to the server side - it now acts for the app servers',
      'info',
    );
  };

  const toggle = (key: 'decrypt' | 'cache' | 'forwardIp' | 'allowList', on: string, off: string) => (value: boolean) => {
    change(key)(value);
    log(value ? on : off, value ? 'ok' : 'warn');
  };

  useTicker(running, (dt) => {
    const current = state.current;
    const now = performance.now();
    const arrivals = sampleArrivals(traffic, dt);
    const share = visualShare(traffic, ANIMATED_PER_SECOND);

    for (let index = 0; index < arrivals; index += 1) {
      const laptopIndex = Math.random() < 0.5 ? 0 : 1;
      const laptop = LAPTOPS[laptopIndex];
      current.requests.add(1, now);

      let route: string[];
      let outcome: Particle['outcome'];
      let latency: number | null;
      let reachesOrigin = false;

      if (placement === 'none') {
        route = [laptop, 'internet', 'app'];
        outcome = 'success';
        latency = COST.internet + COST.app;
        reachesOrigin = true;
      } else if (placement === 'client') {
        current.proxied.add(1, now);
        if (view.allowListOn && Math.random() < BLOCKED_SHARE) {
          // Denied by hostname: works even through a CONNECT tunnel, which names the host.
          route = [laptop, 'proxy'];
          outcome = 'failure';
          latency = null;
          current.denied.add(1, now);
        } else if (view.cacheWorks && Math.random() < repeatShare) {
          route = [laptop, 'proxy'];
          outcome = 'cache-hit';
          latency = COST.lan + COST.proxy;
          current.hits.add(1, now);
        } else {
          route = [laptop, 'proxy', 'internet', 'app'];
          outcome = 'success';
          latency = COST.lan + COST.proxy + COST.internet + COST.app;
          reachesOrigin = true;
        }
      } else {
        current.proxied.add(1, now);
        if (view.cacheWorks && Math.random() < repeatShare) {
          route = [laptop, 'internet', 'proxy'];
          outcome = 'cache-hit';
          latency = COST.internet + COST.proxy;
          current.hits.add(1, now);
        } else {
          route = [laptop, 'internet', 'proxy', 'app'];
          outcome = 'success';
          latency = COST.internet + COST.proxy + COST.dataCenter + COST.app;
          reachesOrigin = true;
        }
      }

      if (latency !== null) current.latency.push(latency, now);
      if (reachesOrigin) current.origin.add(1, now);

      if (Math.random() >= share) continue;
      current.particles.push({
        id: nextParticleId(),
        route,
        leg: 0,
        t: 0,
        speed: 1.1 + Math.random() * 0.3,
        outcome,
        meta: { laptopIndex },
      });
    }

    const { alive, finished } = advanceParticles(current.particles, dt);
    for (const particle of finished) {
      const last = particle.route[particle.route.length - 1];
      if (last !== 'app' || now - current.lastLogAt < LOG_EVERY_MS) continue;
      const laptopIndex = (particle.meta?.laptopIndex as number | undefined) ?? 0;
      current.lastLogAt = now;
      current.log = [
        {
          id: particle.id,
          peer: view.peerFor(laptopIndex),
          xff: view.forwardsIp ? IP.laptops[laptopIndex] : '-',
          path: `/product/${10 + (particle.id % 37)}`,
        },
        ...current.log,
      ].slice(0, 5);
    }
    current.particles = alive.length > PARTICLE_BUDGET ? alive.slice(-PARTICLE_BUDGET) : alive;
    rerender();
  });

  const current = state.current;
  const now = performance.now();
  const snapshot = current.latency.snapshot(now);
  const totalQps = current.requests.rate(now);
  const proxiedQps = current.proxied.rate(now);
  const hitQps = current.hits.rate(now);
  const deniedQps = current.denied.rate(now);
  const originQps = current.origin.rate(now);
  // The two rolling windows can drift by a bucket, so the ratio is clamped.
  const hitRate = proxiedQps > 0 ? Math.min(1, hitQps / proxiedQps) : 0;

  const layout: Layout =
    placement === 'none' ? BASE_LAYOUT : { ...BASE_LAYOUT, proxy: PROXY_SLOT[placement] };

  // Blue wires carry TLS; the amber wire with an HTTP label is plain text.
  const edges: DiagramEdge[] =
    placement === 'none'
      ? [
          ...LAPTOPS.map<DiagramEdge>((id) => ({ from: id, to: 'internet', tone: 'brand', width: 2 })),
          { from: 'internet', to: 'app', tone: 'brand', width: 2, label: 'HTTPS' },
        ]
      : placement === 'client'
        ? [
            ...LAPTOPS.map<DiagramEdge>((id) => ({ from: id, to: 'proxy', tone: 'brand', width: 2 })),
            { from: 'proxy', to: 'internet', tone: 'brand', width: 2 },
            { from: 'internet', to: 'app', tone: 'brand', width: 2, label: decrypt ? 'HTTPS' : 'HTTPS in tunnel' },
          ]
        : [
            ...LAPTOPS.map<DiagramEdge>((id) => ({ from: id, to: 'internet', tone: 'brand', width: 2 })),
            { from: 'internet', to: 'proxy', tone: 'brand', width: 2 },
            decrypt
              ? { from: 'proxy', to: 'app', tone: 'warn', width: 2, label: 'HTTP' }
              : { from: 'proxy', to: 'app', tone: 'brand', width: 2, label: 'TLS' },
          ];

  const particleViews: ParticleView[] = current.particles.map((particle) => ({
    id: particle.id,
    from: particle.route[particle.leg],
    to: particle.route[particle.leg + 1],
    t: particle.t,
    outcome: particle.outcome ?? 'success',
  }));

  const decryptLabel = placement === 'server' ? 'TLS termination' : 'TLS interception';
  const decryptDescription =
    placement === 'server'
      ? 'The certificate lives on the proxy; it decrypts and speaks plain HTTP to the apps'
      : 'Decrypt HTTPS with a company root certificate installed on every laptop';
  const httpOnlyHint =
    placement === 'none'
      ? 'Place the proxy first.'
      : !decrypt
        ? placement === 'server'
          ? 'Passthrough carries encrypted bytes, so the proxy cannot read or add headers. (An L4 proxy can pass the address with the PROXY protocol instead.)'
          : 'A CONNECT tunnel carries encrypted bytes, so the proxy cannot read or add headers.'
        : undefined;

  const proxyTitle = placement === 'client' ? 'Forward proxy x2' : 'Reverse proxy x2';
  const proxySubtitle =
    placement === 'client'
      ? decrypt
        ? `${IP.forwardProxy}, decrypts`
        : `${IP.forwardProxy}, tunnels`
      : decrypt
        ? `${IP.reverseProxyPublic}, TLS ends`
        : `${IP.reverseProxyPublic}, passthrough`;

  return (
    <LabShell
      title="Proxy Lab"
      description="One proxy, placed with the clients or with the servers. Watch who it hides, what it can cache, where TLS ends, and which caller address the app server sees."
      running={running}
      onRunningChange={setRunning}
      onReset={reset}
      legend={
        <div className="flex flex-wrap items-center justify-between gap-2">
          <ParticleLegend outcomes={['success', 'cache-hit', 'failure']} />
          <span className="text-[11px] text-muted">Wire labelled HTTP: plain text. HTTPS, TLS: encrypted.</span>
        </div>
      }
      events={events}
      insight={<Insight>{insightFor(setup, view, hitRate)}</Insight>}
      metrics={
        <>
          <MetricsPanel
            items={[
              {
                key: 'latency',
                label: 'Avg latency',
                value: formatLatency(snapshot.avg),
                hint: 'Round trip for requests that got an answer. Built from fixed hop costs: office 2 ms, internet 40 ms, data center 1 ms, app 20 ms.',
                simulated: true,
              },
              {
                key: 'hitRate',
                label: 'Proxy cache hits',
                value: view.cacheWorks ? formatPercent(hitRate) : '0%',
                tone: view.cacheWorks ? 'ok' : 'neutral',
                hint: 'Share of requests through the proxy answered from its cache. A proxy can only cache what it can read.',
              },
              {
                key: 'origin',
                label: 'Reaching the app',
                value: formatNumber(originQps),
                unit: 'req/s',
                hint: 'Requests that arrive at the app servers.',
              },
              {
                key: 'denied',
                label: 'Denied at proxy',
                value: formatNumber(deniedQps),
                unit: 'req/s',
                tone: deniedQps > 0 ? 'danger' : 'neutral',
                hint: `With the allow-list on, ${formatPercent(BLOCKED_SHARE)} of laptop traffic heads to a site not on the list and gets 403 at the proxy.`,
              },
              {
                key: 'callers',
                label: 'Caller IPs at app',
                value: placement === 'none' ? 2 : 1,
                hint: 'Distinct TCP peer addresses the app servers see.',
              },
              {
                key: 'rps',
                label: 'Total traffic',
                value: formatNumber(totalQps),
                unit: 'req/s',
              },
            ]}
          />

          <div className="grid gap-4 md:grid-cols-2">
            <div className="card p-4">
              <p className="label mb-3">Who sees what</p>
              <dl className="space-y-2 text-xs">
                {[
                  ['Proxy acts for', view.actsFor],
                  ['Proxy hides', view.hides],
                  ['Laptops connect to', view.laptopsConnectTo],
                  ['TLS ends at', view.tlsEndsAt],
                  ['App sees the caller as', view.originSees],
                  ['Round trip', view.latencies],
                ].map(([term, value]) => (
                  <div key={term} className="grid grid-cols-[8.5rem_minmax(0,1fr)] gap-2">
                    <dt className="text-faint">{term}</dt>
                    <dd className="text-ink">{value}</dd>
                  </div>
                ))}
              </dl>
            </div>

            <div className="card p-4">
              <p className="label mb-3">App server access log</p>
              {current.log.length === 0 ? (
                <p className="text-xs text-faint">Waiting for requests to reach the app...</p>
              ) : (
                <ul className="space-y-1 font-mono text-[11px] text-muted">
                  {current.log.map((line) => (
                    <li key={line.id} className="truncate">
                      <span className="text-ink">peer={line.peer}</span>{' '}
                      <span className={line.xff === '-' ? 'text-faint' : 'text-ok'}>xff={line.xff}</span> GET {line.path}
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-3 text-[11px] text-faint">
                peer is the address of the TCP connection that reached the app; xff is the X-Forwarded-For header, when
                a proxy adds one. Addresses are documentation examples, and each laptop is given its own public address
                (no NAT) to keep the picture simple. The two proxies share one floating address; without a reverse proxy
                each app server has its own public address.
              </p>
            </div>
          </div>
        </>
      }
      controls={
        <>
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted">Proxy placement</p>
            <SegmentedControl size="sm" className="w-full" value={placement} options={PLACEMENTS} onChange={place} />
            <p className="text-[11px] text-faint">
              The same part in two places. With the clients it is a forward proxy; with the servers, a reverse proxy.
            </p>
          </div>
          <Toggle
            label={decryptLabel}
            checked={decrypt}
            onChange={toggle('decrypt', 'The proxy now decrypts HTTPS and can read each request', 'The proxy now passes encrypted bytes it cannot read')}
            disabled={placement === 'none'}
            description={decryptDescription}
          />
          <Toggle
            label="Proxy cache"
            checked={cache}
            onChange={toggle('cache', 'Proxy cache on', 'Proxy cache off')}
            disabled={!view.readsHttp}
            description="Answer repeat requests from the proxy, without the app"
            hint={httpOnlyHint}
          />
          <Toggle
            label="Add X-Forwarded-For"
            checked={forwardIp}
            onChange={toggle('forwardIp', 'The proxy now adds X-Forwarded-For with the laptop address', 'The proxy no longer adds X-Forwarded-For')}
            disabled={!view.readsHttp}
            description="Pass the laptop address on in a header"
            hint={httpOnlyHint}
          />
          <Toggle
            label="Egress allow-list"
            checked={allowList}
            onChange={toggle('allowList', 'Allow-list on - hostnames not on it are denied', 'Allow-list off - any hostname is allowed')}
            disabled={placement !== 'client'}
            description="Deny hostnames not on the list (forward proxy only)"
          />
          <Slider
            label="Traffic"
            value={traffic}
            min={20}
            max={1000}
            step={20}
            onChange={change('traffic')}
            format={(value) => `${formatNumber(value)} req/sec`}
          />
          <Slider
            label="Repeat requests"
            value={repeatShare}
            min={0}
            max={0.95}
            step={0.05}
            onChange={change('repeatShare')}
            format={(value) => formatPercent(value)}
            hint="Share of requests for something already fetched. Simplified: a warm cache answers every repeat."
          />
        </>
      }
    >
      <DiagramCanvas layout={layout} edges={edges} particles={particleViews} height={HEIGHT} className="bg-canvas" underlay={<Zones />}>
        {LAPTOPS.map((id, index) => (
          <ArchNode key={id} kind="client" title={`Laptop ${index + 1}`} subtitle={IP.laptops[index]} placed={layout[id]} compact />
        ))}

        <ArchNode kind="cdn" title="Internet" subtitle="public network" placed={layout.internet} compact />

        {placement !== 'none' ? (
          <ArchNode key="proxy" kind="api-gateway" title={proxyTitle} subtitle={proxySubtitle} placed={layout.proxy} compact>
            <NodeStatRow label="Cache hits" value={view.cacheWorks ? formatPercent(hitRate) : 'cannot cache'} tone={view.cacheWorks ? 'text-ok' : 'text-faint'} />
            {placement === 'client' ? (
              <NodeStatRow label="Denied" value={view.allowListOn ? `${formatNumber(deniedQps)}/s` : 'allow all'} tone={deniedQps > 0 ? 'text-danger' : 'text-faint'} />
            ) : (
              <NodeStatRow label="X-Fwd-For" value={view.forwardsIp ? 'added' : 'not added'} tone={view.forwardsIp ? 'text-ok' : 'text-warn'} />
            )}
          </ArchNode>
        ) : null}

        <ArchNode
          kind="server"
          title="App servers x2"
          subtitle={placement === 'server' ? `${IP.appPrivate}, private` : `${IP.appPublic}, public`}
          placed={layout.app}
          compact
        >
          <NodeStatRow label="Peer IP" value={placement === 'none' ? 'each laptop' : view.peerFor(0)} />
          <NodeStatRow label="Incoming" value={`${formatNumber(originQps)}/s`} />
        </ArchNode>
      </DiagramCanvas>
    </LabShell>
  );
}

/** The two sides the proxy can sit on, drawn under the wiring. */
function Zones() {
  return (
    <g>
      <rect x={6} y={10} width={368} height={HEIGHT - 20} rx={14} className="fill-info/5 stroke-line" strokeDasharray="4 4" />
      <text x={20} y={30} className="fill-faint font-mono" style={{ fontSize: 11 }}>
        CLIENT SIDE
      </text>
      <rect x={540} y={10} width={414} height={HEIGHT - 20} rx={14} className="fill-violet/5 stroke-line" strokeDasharray="4 4" />
      <text x={554} y={30} className="fill-faint font-mono" style={{ fontSize: 11 }}>
        SERVER SIDE
      </text>
    </g>
  );
}

function insightFor(setup: Setup, view: ReturnType<typeof describe>, hitRate: number) {
  const hits = formatPercent(hitRate);
  if (setup.placement === 'none') {
    return (
      <>
        No proxy: DNS gives shop.example both app server addresses, {IP.appPublic}, so each app server is exposed
        on the internet. Each laptop opens its own TLS connection to one of them, and the app servers log two caller
        addresses, {IP.laptops[0]} and {IP.laptops[1]}. Move the proxy to the client side to hide the laptops, or to
        the server side to hide the app servers.
      </>
    );
  }
  if (setup.placement === 'client') {
    if (view.forwardsIp) {
      return (
        <>
          The proxy now adds X-Forwarded-For, so the site learns each laptop address again - the access log shows it
          in xff. A forward proxy that should hide its clients must not add this header (Squid adds it by default).
        </>
      );
    }
    if (!setup.decrypt) {
      return (
        <>
          Forward proxy: the site now sees one caller, {IP.forwardProxy}, for both laptops - the proxy hides the
          clients. HTTPS passes through it as a CONNECT tunnel, so it knows the hostname but cannot read or cache the
          content
          {view.allowListOn ? ', and it can still deny a hostname that is not on the allow-list (the crosses)' : ''}.
          Turn on TLS interception to let it cache - at the price of a company root certificate on every laptop.
        </>
      );
    }
    return (
      <>
        With interception the forward proxy reads every request, so {view.cacheWorks ? `${hits} of them are` : 'repeats could be'}{' '}
        answered from its shared cache in about {COST.lan + COST.proxy} ms, without crossing the internet
        {view.cacheWorks ? '' : ' - turn the cache on'}. The site still sees only {IP.forwardProxy}. The cost: every
        laptop must trust the company root certificate, and the proxy can read everything.
      </>
    );
  }
  if (!setup.decrypt) {
    return (
      <>
        TLS passthrough: the reverse proxy forwards encrypted bytes it cannot read, so it cannot cache, route by path
        or add X-Forwarded-For. TLS ends on the app servers, and each of them needs the certificate. Turn TLS
        termination back on.
      </>
    );
  }
  return (
    <>
      Reverse proxy: the laptops connect to shop.example at {IP.reverseProxyPublic}, the proxy. The app servers sit on
      private {IP.appPrivate} addresses that nobody outside can reach - the proxy hides the servers. TLS ends at the
      proxy, so it can read requests
      {view.cacheWorks ? `, and ${hits} of them never reach the app because the proxy cache answers them` : ''}.{' '}
      {view.forwardsIp
        ? 'X-Forwarded-For carries each laptop address, so the app still logs the real client.'
        : `Without X-Forwarded-For every line in the app log shows ${IP.reverseProxyInside}, the proxy - turn it on.`}
    </>
  );
}

export default ProxyLab;
