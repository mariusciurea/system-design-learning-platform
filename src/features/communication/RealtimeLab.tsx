import { useCallback, useMemo, useRef } from 'react';
import { Zap } from 'lucide-react';
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
import { Button, Meter, Slider, Toggle } from '@/components/ui';
import { advanceParticles, nextParticleId, useEventLog, useTicker, type Particle } from '@/simulations/engine';
import { useLabSetup } from '@/hooks/useLabSetup';
import { useRerender } from '@/hooks/useRerender';
import { cn } from '@/utils/cn';
import { formatBytes, formatLatency, formatNumber, formatPercent } from '@/utils/format';
import type { LabFocus, LabProps, RequestOutcome } from '@/types';
import {
  CONNECTION_BUDGET,
  HEADER_BYTES,
  ONE_WAY_MS,
  TECHNIQUE_LABEL,
  realtimeModel,
  type RealtimeResult,
  type Technique,
} from './realtimeModel';
import { useLabRunning } from '@/hooks/useLabRunning';

interface Setup {
  technique: Technique;
  clients: number;
  eventsPerMin: number;
  sendsPerMin: number;
  intervalS: number;
  holdS: number;
  etag: boolean;
}

/** What the lab opens on at /labs/realtime, with no Lab focus: the naive baseline. */
const DEFAULT_SETUP: Setup = {
  technique: 'polling',
  clients: 10000,
  eventsPerMin: 6,
  sendsPerMin: 0,
  intervalS: 5,
  holdS: 30,
  etag: false,
};

/**
 * The Lab focus of each Concept that hosts this lab. All four open on the same
 * clients and the same events, so switching technique compares like with like.
 * WebSockets also opens with clients sending, because two-way traffic on one
 * socket is what sets it apart from Server-Sent Events.
 */
const FOCUS_SETUPS: Record<LabFocus<'realtime'>, Setup> = {
  polling: { ...DEFAULT_SETUP, technique: 'polling' },
  'long-polling': { ...DEFAULT_SETUP, technique: 'long-polling' },
  'server-sent-events': { ...DEFAULT_SETUP, technique: 'sse' },
  websockets: { ...DEFAULT_SETUP, technique: 'websockets', sendsPerMin: 6 },
};

const TECHNIQUES: { value: Technique; label: string; note: string }[] = [
  { value: 'polling', label: 'Polling', note: 'Ask again every few seconds' },
  { value: 'long-polling', label: 'Long polling', note: 'Server holds the request until news' },
  { value: 'sse', label: 'Server-Sent Events', note: 'One HTTP response that never ends' },
  { value: 'websockets', label: 'WebSockets', note: 'One two-way socket' },
];

const SHOWN = 4;
const CLIENT_IDS = Array.from({ length: SHOWN }, (_, index) => `c${index}`);

/** A client card holds a subtitle and two stat rows, 100 to 116px tall (measured; polling adds a row); the canvas fits all four. */
const CANVAS_H = 500;
const LAYOUT: Layout = {
  c0: { x: 30, y: 10, w: 220, h: 116 },
  c1: { x: 30, y: 132, w: 220, h: 116 },
  c2: { x: 30, y: 254, w: 220, h: 116 },
  c3: { x: 30, y: 376, w: 220, h: 116 },
  server: { x: 380, y: 126, w: 260, h: 250 },
  source: { x: 740, y: 206, w: 190, h: 90 },
};

/**
 * One network hop as drawn. The model uses 50 ms; on screen a hop takes 0.45 s
 * so a learner can follow a single request. Delays shown per client take the
 * drawn hop out again and put the model hop back in.
 */
const HOP_S = 0.45;
const HOP_SPEED = 1 / HOP_S;

type Kind = 'event' | 'request' | 'data' | 'empty' | 'push' | 'up' | 'ack' | 'open' | 'opened' | 'rejected';

interface Meta {
  kind: Kind;
  client: number;
  version: number;
  upTo: number;
  retry: boolean;
}

const OUTCOME_OF: Record<Kind, RequestOutcome> = {
  event: 'cache-hit',
  request: 'success',
  open: 'success',
  up: 'success',
  ack: 'success',
  opened: 'success',
  data: 'cache-hit',
  push: 'cache-hit',
  empty: 'warning',
  rejected: 'failure',
};

interface ClientSim {
  /** Newest event version this client has. */
  seen: number;
  /** Polling: next poll. Long polling / SSE / WebSockets: next (re)connect attempt. */
  nextAt: number;
  inFlight: boolean;
  /** Long polling: the server is holding this client's request. */
  held: boolean;
  heldSince: number;
  /** SSE / WebSockets: the server has this client's stream or socket open. */
  open: boolean;
  nextSendAt: number;
  requests: number;
  empties: number;
  lastDelayS: number | null;
}

interface Sim {
  technique: Technique;
  time: number;
  version: number;
  /** Time each event version reached the server, indexed by version. */
  eventTimes: number[];
  nextEventAt: number;
  /** When a rejection was last logged, so an overloaded server does not flood the log. */
  lastRejectLog: number;
  clients: ClientSim[];
  particles: Particle[];
}

const exponential = (ratePerSec: number) => (ratePerSec > 0 ? -Math.log(1 - Math.random()) / ratePerSec : Infinity);

function createSim(setup: Setup): Sim {
  return {
    technique: setup.technique,
    time: 0,
    version: 0,
    eventTimes: [0],
    nextEventAt: 1.5 + exponential(setup.eventsPerMin / 60),
    lastRejectLog: -Infinity,
    clients: CLIENT_IDS.map(() => ({
      seen: 0,
      // Clients start at different moments, as real ones do - polls are spread, not in lockstep.
      nextAt: setup.technique === 'polling' ? Math.random() * Math.min(setup.intervalS, 4) : Math.random() * 0.8,
      inFlight: false,
      held: false,
      heldSince: 0,
      open: false,
      nextSendAt: exponential(setup.sendsPerMin / 60),
      requests: 0,
      empties: 0,
      lastDelayS: null,
    })),
    particles: [],
  };
}

export function RealtimeLab({ focus }: LabProps<'realtime'>) {
  // The page keys this lab by Concept, so the focus never changes under a mounted lab.
  const start = focus ? FOCUS_SETUPS[focus] : DEFAULT_SETUP;
  // Every control lives in one object, so Reset cannot miss one.
  const { setup, setSetup, change } = useLabSetup(start);
  const { technique, clients, eventsPerMin, sendsPerMin, intervalS, holdS, etag } = setup;

  const [running, setRunning] = useLabRunning();
  const sim = useRef<Sim>(createSim(start));
  const rerender = useRerender(30);
  const { events, log, clear } = useEventLog();

  const model = useMemo(() => realtimeModel(setup), [setup]);
  const comparison = useMemo(
    () => TECHNIQUES.map((item) => ({ ...item, result: realtimeModel({ ...setup, technique: item.value }) })),
    [setup],
  );

  /**
   * One message on one wire. `version` is the oldest event it carries (for the delay) and
   * `upTo` the newest; `retry` marks a rejected poll or connection the client must try again.
   */
  const emit = (kind: Kind, client: number, from: string, to: string, extra: Partial<Meta> = {}) => {
    const meta: Meta = { kind, client, version: 0, upTo: 0, retry: false, ...extra };
    sim.current.particles.push({
      id: nextParticleId(),
      route: [from, to],
      leg: 0,
      t: 0,
      speed: HOP_SPEED,
      outcome: OUTCOME_OF[kind],
      meta: { ...meta },
    });
  };

  /** Whether the overloaded server turns this request away. Load above 1 rejects the excess share. */
  const overloaded = (load: number) => load > 1 && Math.random() > 1 / load;

  const publish = useCallback(() => {
    sim.current.particles.push({
      id: nextParticleId(),
      route: ['source', 'server'],
      leg: 0,
      t: 0,
      speed: HOP_SPEED,
      outcome: 'cache-hit',
      meta: { kind: 'event', client: -1, version: 0, upTo: 0, retry: false } satisfies Meta,
    });
  }, []);

  const reset = () => {
    setSetup(start);
    sim.current = createSim(start);
    clear();
  };

  useTicker(running, (dt) => {
    let state = sim.current;
    if (state.technique !== technique) {
      state = sim.current = createSim(setup);
      log(`Switched to ${TECHNIQUE_LABEL[technique]} - every client starts again`, 'info');
    }
    state.time += dt;
    const now = state.time;

    // A raised event rate should show at once, not after a wait drawn at the old rate.
    if (state.nextEventAt - now > (3 * 60) / eventsPerMin) state.nextEventAt = now + exponential(eventsPerMin / 60);
    if (now >= state.nextEventAt) {
      publish();
      state.nextEventAt = now + exponential(eventsPerMin / 60);
    }

    const deliverDelay = (client: ClientSim, version: number) => {
      const eventAt = state.eventTimes[Math.min(version, state.eventTimes.length - 1)] ?? now;
      client.lastDelayS = Math.max(ONE_WAY_MS / 1000, now - eventAt - HOP_S + ONE_WAY_MS / 1000);
    };

    state.clients.forEach((client, index) => {
      const id = CLIENT_IDS[index];
      // Follow the sliders at once: start or stop sending, and never wait out an interval that was just shortened.
      if (sendsPerMin === 0) client.nextSendAt = Infinity;
      else if (client.nextSendAt === Infinity) client.nextSendAt = now + exponential(sendsPerMin / 60);
      if (technique === 'polling' && client.nextAt - now > intervalS * 1.1) client.nextAt = now + Math.random() * intervalS;
      if (technique === 'polling') {
        if (now >= client.nextAt) {
          emit('request', index, id, 'server');
          client.requests += 1;
          // +/-10% jitter so clients do not fall into step.
          client.nextAt = now + intervalS * (0.9 + Math.random() * 0.2);
        }
      } else if (technique === 'long-polling') {
        if (!client.inFlight && !client.held && now >= client.nextAt) {
          emit('request', index, id, 'server');
          client.requests += 1;
          client.inFlight = true;
        }
        if (client.held && now - client.heldSince >= holdS) {
          client.held = false;
          emit('empty', index, 'server', id);
          log(`Client ${index + 1}: held ${holdS} s with nothing new - empty answer, it asks again`, 'warn');
        }
      } else if (!client.open && !client.inFlight && now >= client.nextAt) {
        emit('open', index, id, 'server');
        client.requests += 1;
        client.inFlight = true;
      }

      if (now >= client.nextSendAt) {
        client.nextSendAt = now + exponential(sendsPerMin / 60);
        // A WebSocket frame needs the socket; everything else is a fresh HTTP POST.
        if (technique !== 'websockets' || client.open) {
          emit('up', index, id, 'server');
          if (technique !== 'websockets') client.requests += 1;
        }
      }
    });

    const { alive, finished } = advanceParticles(state.particles, dt);
    state.particles = alive;

    for (const particle of finished) {
      const meta = particle.meta as unknown as Meta;
      const client = state.clients[meta.client];
      const id = CLIENT_IDS[meta.client];

      switch (meta.kind) {
        case 'event': {
          state.version += 1;
          state.eventTimes[state.version] = now;
          state.clients.forEach((other, index) => {
            if ((technique === 'sse' || technique === 'websockets') && other.open) {
              emit('push', index, 'server', CLIENT_IDS[index], { version: state.version, upTo: state.version });
            } else if (technique === 'long-polling' && other.held) {
              other.held = false;
              emit('data', index, 'server', CLIENT_IDS[index], { version: other.seen + 1, upTo: state.version });
            }
          });
          break;
        }
        case 'request': {
          // A held long poll also takes a connection slot, so memory can turn it away too.
          const load = technique === 'long-polling' ? Math.max(model.cpu, model.memory) : model.cpu;
          if (overloaded(load)) {
            emit('rejected', meta.client, 'server', id, { retry: true });
          } else if (state.version > client.seen) {
            // Answer from the cursor: everything since the version the client has.
            emit('data', meta.client, 'server', id, { version: client.seen + 1, upTo: state.version });
          } else if (technique === 'long-polling') {
            client.held = true;
            client.heldSince = now;
          } else {
            emit('empty', meta.client, 'server', id);
          }
          break;
        }
        case 'open': {
          if (overloaded(model.memory)) {
            emit('rejected', meta.client, 'server', id, { retry: true });
          } else {
            client.open = true;
            client.seen = state.version;
            emit('opened', meta.client, 'server', id);
          }
          break;
        }
        case 'up': {
          if (technique !== 'websockets') {
            emit(overloaded(model.cpu) ? 'rejected' : 'ack', meta.client, 'server', id);
          }
          break;
        }
        case 'opened':
          client.inFlight = false;
          log(
            technique === 'websockets'
              ? `Client ${meta.client + 1}: 101 Switching Protocols - socket open both ways`
              : `Client ${meta.client + 1}: 200 text/event-stream - stream open, server to client`,
            'ok',
          );
          break;
        case 'data':
        case 'push':
          deliverDelay(client, meta.version);
          client.seen = Math.max(client.seen, meta.upTo);
          if (technique === 'long-polling') {
            client.inFlight = false;
            client.nextAt = now;
          }
          break;
        case 'empty':
          client.empties += 1;
          if (technique === 'long-polling') {
            client.inFlight = false;
            client.nextAt = now;
          }
          break;
        case 'rejected':
          // Polling simply asks again at its next interval; the others retry after a short random wait.
          if (meta.retry && client.inFlight) {
            client.inFlight = false;
            client.nextAt = now + 1 + Math.random();
          }
          if (now - state.lastRejectLog > 3) {
            state.lastRejectLog = now;
            log(`Client ${meta.client + 1}: 503 - the server is over capacity`, 'danger');
          }
          break;
        case 'ack':
          break;
      }
    }

    rerender();
  });

  const state = sim.current;
  const particleViews: ParticleView[] = state.particles.map((particle) => ({
    id: particle.id,
    from: particle.route[particle.leg],
    to: particle.route[particle.leg + 1],
    t: particle.t,
    outcome: particle.outcome ?? 'success',
  }));

  // Recomputed per render: the wire of each client shows whether something is held open on it.
  const edges: DiagramEdge[] = [
    { from: 'source', to: 'server', tone: 'info' },
    ...state.clients.map((client, index): DiagramEdge => {
      const open = client.open && (technique === 'sse' || technique === 'websockets');
      return {
        from: CLIENT_IDS[index],
        to: 'server',
        tone: open ? (technique === 'websockets' ? 'violet' : 'info') : client.held ? 'brand' : 'default',
        animated: open || client.held,
        width: open || client.held ? 2.25 : 1.75,
      };
    }),
  ];

  const serverSubtitle = {
    polling: 'answers every poll',
    'long-polling': 'parks each request',
    sse: 'writes text/event-stream',
    websockets: 'holds one socket per client',
  }[technique];

  return (
    <LabShell
      title="Realtime Lab"
      description="One server with new events and many clients waiting for them. Pick how the updates reach the clients and watch the delay, the wasted requests, the open connections and the server load."
      running={running}
      onRunningChange={setRunning}
      onReset={reset}
      legend={<RealtimeLegend />}
      events={events}
      actions={
        <Button variant="primary" onClick={publish}>
          <Zap className="h-4 w-4" />
          Publish event now
        </Button>
      }
      insight={<Insight>{insightFor(setup, model)}</Insight>}
      metrics={
        <>
          <MetricsPanel
            items={[
              {
                key: 'delay',
                label: 'Average delay',
                value: formatLatency(model.delayMs),
                tone: model.delayMs > 1000 ? 'warn' : 'ok',
                hint: 'From an event reaching the server to a client having it, on average.',
                simulated: true,
              },
              {
                key: 'http',
                label: 'HTTP requests',
                value: formatNumber(model.httpPerSec),
                unit: '/s',
                tone: model.httpPerSec > 2000 ? 'warn' : 'neutral',
                hint: 'Polls, long polls and POSTs the server answers, for all clients.',
                simulated: true,
              },
              {
                key: 'wasted',
                label: 'Wasted responses',
                value: formatNumber(model.wastedPerSec),
                unit: '/s',
                tone: model.wastedPerSec > 100 ? 'danger' : 'ok',
                hint: 'Answers that carried nothing new: unchanged polls and long polls that timed out.',
                simulated: true,
              },
              {
                key: 'open',
                label: 'Open connections',
                value: formatNumber(model.openConnections),
                tone: model.memory > 1 ? 'danger' : 'neutral',
                hint: 'Requests, streams or sockets the server holds open at any moment.',
                simulated: true,
              },
              {
                key: 'cpu',
                label: 'Server CPU',
                value: formatPercent(model.cpu),
                tone: model.cpu > 1 ? 'danger' : model.cpu > 0.7 ? 'warn' : 'ok',
                hint: 'Work for requests and messages against what one server can do.',
                simulated: true,
              },
              {
                key: 'overhead',
                label: 'Header overhead',
                value: `${formatBytes(model.overheadBytesPerSec)}/s`,
                hint: `Bytes that are not the event: about ${HEADER_BYTES} bytes of headers per HTTP request and response, a few bytes per frame or event.`,
                simulated: true,
              },
            ]}
          />

          <div className="card p-4">
            <p className="label mb-3">Same clients, same events, four techniques</p>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[520px] text-left text-xs">
                <thead className="text-faint">
                  <tr>
                    <th className="py-1.5 pr-3 font-medium">Technique</th>
                    <th className="py-1.5 pr-3 font-medium">Delay</th>
                    <th className="py-1.5 pr-3 font-medium">HTTP req/s</th>
                    <th className="py-1.5 pr-3 font-medium">Wasted/s</th>
                    <th className="py-1.5 pr-3 font-medium">Open conns</th>
                    <th className="py-1.5 font-medium">CPU</th>
                  </tr>
                </thead>
                <tbody className="font-mono">
                  {comparison.map((row) => (
                    <tr
                      key={row.value}
                      className={cn('border-t border-line', row.value === technique ? 'bg-brand/10 text-ink' : 'text-muted')}
                    >
                      <td className="py-1.5 pr-3 font-sans">
                        <button
                          type="button"
                          onClick={() => change('technique')(row.value)}
                          aria-pressed={row.value === technique}
                          className={cn('text-left hover:text-brand', row.value === technique && 'font-semibold text-brand')}
                        >
                          {row.label}
                        </button>
                      </td>
                      <td className="py-1.5 pr-3">{formatLatency(row.result.delayMs)}</td>
                      <td className="py-1.5 pr-3">{formatNumber(row.result.httpPerSec)}</td>
                      <td className="py-1.5 pr-3">{formatNumber(row.result.wastedPerSec)}</td>
                      <td className="py-1.5 pr-3">{formatNumber(row.result.openConnections)}</td>
                      <td className={cn('py-1.5', row.result.cpu > 1 && 'text-danger')}>{formatPercent(row.result.cpu)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-xs text-faint">
              {SIMULATED_HINT} One server node, 50 ms each way, events at random at the chosen
              rate. A full HTTP request costs 1 unit of work, a 304 costs 0.3, a message on an open connection 0.02;
              the server does 5,000 units a second and has room for {formatNumber(CONNECTION_BUDGET)} open
              connections (about 50 KB each). The animation slows one network hop down to {HOP_S} s so you can follow
              it, and draws 4 of the {formatNumber(clients)} clients.
            </p>
          </div>
        </>
      }
      controls={
        <>
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted">How clients get updates</p>
            <div className="space-y-1.5">
              {TECHNIQUES.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  onClick={() => change('technique')(item.value)}
                  aria-pressed={technique === item.value}
                  className={cn(
                    'w-full rounded-lg border px-3 py-2 text-left transition-colors',
                    technique === item.value
                      ? 'border-brand bg-brand/10 text-brand'
                      : 'border-line text-muted hover:border-brand/50 hover:text-ink',
                  )}
                >
                  <span className="block text-xs font-medium">{item.label}</span>
                  <span className="block text-[11px] text-faint">{item.note}</span>
                </button>
              ))}
            </div>
          </div>
          <Slider
            label="Clients"
            value={clients}
            min={100}
            max={50000}
            step={100}
            onChange={change('clients')}
            format={(value) => formatNumber(value)}
            hint="Everyone wants every event, like a live score."
          />
          <Slider
            label="Events"
            value={eventsPerMin}
            min={1}
            max={120}
            onChange={change('eventsPerMin')}
            format={(value) => `${value} per min`}
            hint="How often the server has something new."
          />
          <Slider
            label="Client messages"
            value={sendsPerMin}
            min={0}
            max={60}
            onChange={change('sendsPerMin')}
            format={(value) => `${value} per min each`}
            hint="What each client sends to the server - chat lines, cursor moves."
          />
          <Slider
            label="Poll interval"
            value={intervalS}
            min={1}
            max={60}
            onChange={change('intervalS')}
            format={(value) => `${value} s`}
            disabled={technique !== 'polling'}
            hint="Polling only. Shorter is fresher and costs more requests."
          />
          <Toggle
            label="ETag / 304"
            checked={etag}
            onChange={change('etag')}
            disabled={technique !== 'polling'}
            description="Polling only. An unchanged answer is a cheap 304 - still a request."
          />
          <Slider
            label="Hold timeout"
            value={holdS}
            min={5}
            max={60}
            onChange={change('holdS')}
            format={(value) => `${value} s`}
            disabled={technique !== 'long-polling'}
            hint="Long polling only. Keep it under every proxy idle timeout on the path."
          />
        </>
      }
    >
      <DiagramCanvas layout={LAYOUT} edges={edges} particles={particleViews} height={CANVAS_H} className="bg-canvas">
        {state.clients.map((client, index) => (
          <ArchNode
            key={CLIENT_IDS[index]}
            kind="client"
            title={`Client ${index + 1}`}
            subtitle={clientState(technique, client, state.time)}
            placed={LAYOUT[CLIENT_IDS[index]]}
            compact
          >
            <NodeStatRow
              label={technique === 'polling' ? 'Requests / empty' : 'HTTP requests'}
              value={technique === 'polling' ? `${client.requests} / ${client.empties}` : client.requests}
              tone={client.empties > 0 ? 'text-warn' : 'text-ink'}
            />
            <NodeStatRow
              label="Last delay"
              value={client.lastDelayS === null ? '-' : formatLatency(client.lastDelayS * 1000)}
              tone={client.lastDelayS !== null && client.lastDelayS > 1 ? 'text-warn' : 'text-ok'}
            />
          </ArchNode>
        ))}
        <ArchNode
          kind="server"
          title="Server"
          subtitle={serverSubtitle}
          placed={LAYOUT.server}
          status={model.cpu > 1 || model.memory > 1 ? 'degraded' : 'healthy'}
          alert={model.cpu > 1 || model.memory > 1}
        >
          <NodeStatRow label="HTTP requests" value={`${formatNumber(model.httpPerSec)}/s`} />
          <NodeStatRow
            label="Wasted"
            value={`${formatNumber(model.wastedPerSec)}/s`}
            tone={model.wastedPerSec > 0 ? 'text-warn' : 'text-ok'}
          />
          <NodeStatRow label="Held open" value={formatNumber(model.openConnections)} />
          <Meter label="CPU" value={Math.min(1, model.cpu)} />
          <Meter label="Connection memory" value={Math.min(1, model.memory)} tone="violet" />
        </ArchNode>
        <ArchNode
          kind="queue"
          title="Event source"
          subtitle={`${eventsPerMin} events/min`}
          placed={LAYOUT.source}
          compact
        />
        <div
          className="absolute text-[11px] text-faint"
          style={{ left: LAYOUT.server.x, top: LAYOUT.server.y + LAYOUT.server.h + 40, width: LAYOUT.server.w }}
        >
          4 of {formatNumber(clients)} clients drawn - the numbers count all of them. Simplified model.
        </div>
      </DiagramCanvas>
    </LabShell>
  );
}

function clientState(technique: Technique, client: ClientSim, now: number) {
  if (technique === 'polling') return `next poll in ${Math.max(0, client.nextAt - now).toFixed(1)} s`;
  if (technique === 'long-polling') {
    if (client.held) return `request held ${Math.floor(now - client.heldSince)} s`;
    return client.inFlight ? 'asking again' : 'retrying soon';
  }
  if (client.open) return technique === 'websockets' ? 'socket open, both ways' : 'stream open, one way';
  return client.inFlight ? (technique === 'websockets' ? 'upgrading' : 'opening stream') : 'reconnecting soon';
}

function insightFor(setup: Setup, model: RealtimeResult) {
  const { technique, clients, eventsPerMin, sendsPerMin, intervalS, holdS } = setup;
  const overload =
    model.cpu > 1
      ? ` The server is over capacity (${formatPercent(model.cpu)} CPU): the red crosses are requests it turns away.`
      : model.memory > 1
        ? ` One node has room for about ${formatNumber(CONNECTION_BUDGET)} open connections and ${formatNumber(model.openConnections)} want one: new connections are turned away. Past this point you add nodes, and a pub/sub layer so any node can reach any client.`
        : '';
  const wastedShare = model.httpPerSec > 0 ? model.wastedPerSec / model.httpPerSec : 0;

  if (technique === 'polling') {
    return `Every client asks every ${intervalS} s, so the server answers ${formatNumber(model.httpPerSec)} requests a second no matter how often something changes - and ${formatPercent(wastedShare)} of the answers say "nothing new" (the triangles). An event waits for the next poll: about half an interval, ${formatLatency(model.delayMs)} on average. Halve the interval and the delay halves while the requests double.${overload}`;
  }
  if (technique === 'long-polling') {
    return `Each client keeps one request parked at the server (the lit wires). An event answers it at once, so the delay drops to about ${formatLatency(model.delayMs)}, and an empty answer only comes when the ${holdS} s hold times out: ${formatNumber(model.wastedPerSec)} a second. The price is ${formatNumber(model.openConnections)} held requests, and a full request and response for every event - raise Events and watch the HTTP requests climb with it.${overload}`;
  }
  if (technique === 'sse') {
    return sendsPerMin > 0
      ? `Events stream down ${formatNumber(clients)} open responses with no wasted requests and one hop of delay. But the stream is one-way: each of the ${formatNumber((clients * sendsPerMin) / 60)} messages a second the clients send is a separate HTTP POST with about ${HEADER_BYTES} bytes of headers. Switch to WebSockets and the same messages ride the open socket.${overload}`
      : `Each client opens one ordinary HTTP response that never ends, and the server writes every event into it: one hop of delay, no wasted requests, and plain text a proxy understands. The cost is ${formatNumber(model.openConnections)} open connections. It only goes server to client - raise Client messages to see what sending back costs.${overload}`;
  }
  return `One socket per client carries both directions: the ${eventsPerMin} events a minute go down it and the clients' ${sendsPerMin} messages a minute go up it as frames of a few bytes, with no new HTTP request. Delay is one hop and nothing is wasted. The cost is state: ${formatNumber(model.openConnections)} sockets held on this node (${formatPercent(model.memory)} of its connection memory), and every one drops when the node restarts.${overload}`;
}

/** Shape and text for each particle, so the meaning never rests on colour alone. */
function RealtimeLegend() {
  return (
    <ParticleLegend
      outcomes={[
        { outcome: 'success', label: 'Request, message or reply' },
        { outcome: 'cache-hit', label: 'New event' },
        { outcome: 'warning', label: 'Nothing new (wasted)' },
        { outcome: 'failure', label: 'Rejected, server over capacity' },
      ]}
    >
      <span className="text-[11px] text-faint">A lit, moving wire is a request, stream or socket held open.</span>
    </ParticleLegend>
  );
}

export default RealtimeLab;
