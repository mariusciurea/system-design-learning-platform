import { useRef, useState } from 'react';
import { Scissors } from 'lucide-react';
import {
  ArchNode,
  DiagramCanvas,
  NodeStatRow,
  OUTCOME_STYLE,
  ParticleLegend,
  ParticleShape,
  type DiagramEdge, type Layout, type ParticleView } from '@/components/architecture';
import { Insight, LabShell, SIMULATED_HINT } from '@/components/learning';
import { Button, Slider } from '@/components/ui';
import { useTicker, useEventLog } from '@/simulations/engine';
import { useRerender } from '@/hooks/useRerender';
import { formatLatency, formatNumber, formatPercent } from '@/utils/format';
import { cn } from '@/utils/cn';
import type { NodeStatus, RequestOutcome } from '@/types';
import {
  DUP_ACK_THRESHOLD,
  FILE_PACING_MS,
  FILE_PACKETS,
  MIN_RTO_MS,
  PLAYOUT_BUFFER_MS,
  VOICE_FRAME_MS,
  cellState,
  createStream,
  emptyStats,
  stepStream,
  type CellState,
  type NetworkSetup,
  type Payload,
  type Stream,
  type StreamEvent,
  type Transport,
} from './transportModel';
import { useLabRunning } from '@/hooks/useLabRunning';

/** The simulation runs this many times slower than real time, so single packets can be followed. */
const SLOW_MOTION = 15;
/** One seed per payload: TCP and UDP of the same payload see the same random drops and jitter. */
const SEED: Record<Payload, number> = { voice: 20260923, file: 20260924 };
const VOICE_CELLS = 30;
/** Keyed log lines (drops, handshakes) are shown at most this often per stream, in real ms. */
const LOG_GAP_MS = 3000;

/** What the lab opens on. It has one host Concept, so there is no Lab focus. */
const DEFAULT_SETUP: NetworkSetup = { lossRate: 0.05, delayMs: 40, jitterMs: 10 };

/** The four streams, in the order the diagram draws their lanes: the two of each payload side by side. */
const LANES = [
  { id: 'voice-tcp', payload: 'voice', transport: 'tcp' },
  { id: 'voice-udp', payload: 'voice', transport: 'udp' },
  { id: 'file-tcp', payload: 'file', transport: 'tcp' },
  { id: 'file-udp', payload: 'file', transport: 'udp' },
] as const satisfies readonly { id: string; payload: Payload; transport: Transport }[];

type LaneId = (typeof LANES)[number]['id'];
type Sim = { now: number } & Record<LaneId, Stream>;

const createSim = (now = 0): Sim => ({
  now,
  'voice-tcp': createStream('tcp', 'voice', now),
  'voice-udp': createStream('udp', 'voice', now),
  'file-tcp': createStream('tcp', 'file', now),
  'file-udp': createStream('udp', 'file', now),
});

const PAYLOAD_NAME: Record<Payload, string> = { voice: 'Voice call', file: 'File' };
const RECEIVER_NAME: Record<Payload, string> = { voice: 'Voice player', file: 'File saver' };

/* Layout: four lanes, each a client, a wire into the one shared Network, a wire out of it and a
   server. The wires end at small ports on the Network card edges (not at its centre), so each lane
   keeps its own straight wire and a dropped packet stops on its own lane. */
// A lane card renders 128px tall (title, subtitle, two stat rows, status), and a TCP card 145px with the
// controls at max: at 110 each TCP card overlapped the UDP card below it.
const NODE = { w: 220, h: 145 };
const NET = { x: 370, w: 220 };
const LANE_Y: Record<LaneId, number> = { 'voice-tcp': 16, 'voice-udp': 173, 'file-tcp': 352, 'file-udp': 509 };
const HEIGHT = 670;

const LAYOUT: Layout = {
  network: { x: NET.x, y: 16, w: NET.w, h: LANE_Y['file-udp'] + NODE.h - 16 },
  ...Object.fromEntries(
    LANES.flatMap(({ id }) => {
      const y = LANE_Y[id];
      const mid = y + NODE.h / 2;
      return [
        [`${id}-client`, { x: 16, y, ...NODE }],
        [`${id}-in`, { x: NET.x, y: mid - 1, w: 2, h: 2 }],
        [`${id}-out`, { x: NET.x + NET.w - 2, y: mid - 1, w: 2, h: 2 }],
        [`${id}-server`, { x: 724, y, ...NODE }],
      ];
    }),
  ),
};

const EDGES: DiagramEdge[] = LANES.flatMap(({ id, transport }) => {
  const tone = transport === 'tcp' ? 'brand' : 'violet';
  return [
    { from: `${id}-client`, to: `${id}-in`, tone, width: 2 },
    { from: `${id}-out`, to: `${id}-server`, tone, width: 2 },
  ];
});

const OUTCOME: Record<string, RequestOutcome> = {
  syn: 'success',
  data: 'success',
  retransmit: 'warning',
  ack: 'cache-hit',
  'syn-ack': 'cache-hit',
};

/**
 * Every packet of one lane, placed by simulated time: the first half of its trip is on the wire
 * into the Network, the second half on the wire out of it. A dropped packet stops just before the
 * Network and shows as a cross until it would have arrived.
 */
function particlesOf(lane: LaneId, stream: Stream, now: number, into: ParticleView[]) {
  for (const flight of stream.flights) {
    const progress = Math.min(1, Math.max(0, (now - flight.sentAt) / Math.max(1, flight.arriveAt - flight.sentAt)));
    const [first, second] = flight.toServer
      ? [[`${lane}-client`, `${lane}-in`], [`${lane}-out`, `${lane}-server`]]
      : [[`${lane}-server`, `${lane}-out`], [`${lane}-in`, `${lane}-client`]];
    if (flight.dropped && progress >= 0.5) {
      into.push({ id: flight.id, from: first[0], to: first[1], t: 0.9, outcome: 'failure' });
    } else if (progress < 0.5) {
      into.push({ id: flight.id, from: first[0], to: first[1], t: progress * 2, outcome: OUTCOME[flight.kind] });
    } else {
      into.push({ id: flight.id, from: second[0], to: second[1], t: (progress - 0.5) * 2, outcome: OUTCOME[flight.kind] });
    }
  }
}

/** Packets that reached the server but wait for an earlier one before the app gets them. */
function heldBack(stream: Stream) {
  let held = 0;
  for (const record of stream.packets.values()) if (record.arrivedAt !== null && record.deliveredAt === null) held += 1;
  return held;
}

const laneName = (payload: Payload, transport: Transport) => `${PAYLOAD_NAME[payload]} over ${transport.toUpperCase()}`;

export function TransportLab() {
  const [setup, setSetup] = useState(DEFAULT_SETUP);
  const { lossRate, delayMs, jitterMs } = setup;
  const [running, setRunning] = useLabRunning();
  const sim = useRef<Sim>(createSim());
  const rerender = useRerender(30);
  const { events, log, clear } = useEventLog();
  const lastLogged = useRef(new Map<string, number>());

  const reporter = (payload: Payload) => (event: StreamEvent) => {
    if (event.key) {
      const key = `${payload}-${event.key}`;
      const at = performance.now();
      if (at - (lastLogged.current.get(key) ?? -Infinity) < LOG_GAP_MS) return;
      lastLogged.current.set(key, at);
    }
    log(`${event.transport.toUpperCase()} ${payload}: ${event.message}`, event.tone);
  };

  useTicker(running, (dt) => {
    const state = sim.current;
    state.now += (dt * 1000) / SLOW_MOTION;
    for (const { id, payload } of LANES) stepStream(state[id], state.now, setup, SEED[payload], reporter(payload));
    rerender();
  });

  /** Loss, delay and jitter apply to the next packets sent; the counters restart so they describe the new network. */
  const changeNetwork =
    <K extends keyof NetworkSetup>(key: K) =>
    (value: NetworkSetup[K]) => {
      setSetup((current) => ({ ...current, [key]: value }));
      for (const { id } of LANES) sim.current[id].stats = emptyStats();
    };

  const dropNext = () => {
    for (const { id } of LANES) sim.current[id].dropNext = true;
    log('The network will drop the next new packet of all four streams', 'warn');
  };

  const reset = () => {
    setSetup(DEFAULT_SETUP);
    sim.current = createSim();
    lastLogged.current.clear();
    clear();
  };

  const state = sim.current;
  const { now } = state;
  const particles: ParticleView[] = [];
  for (const { id } of LANES) particlesOf(id, state[id], now, particles);
  const rtt = 2 * delayMs;

  return (
    <LabShell
      title="TCP vs UDP Lab"
      description="A client sends a live voice call and a file to a server, each over TCP and over UDP at the same time, across one network that drops and delays packets. The same drops hit TCP and UDP, so you can see late but complete next to on time but lossy."
      running={running}
      onRunningChange={setRunning}
      onReset={reset}
      events={events}
      legend={<WireLegend />}
      actions={
        <Button variant="secondary" onClick={dropNext}>
          <Scissors className="h-4 w-4" />
          Drop the next packet
        </Button>
      }
      insight={<Insight>{insightText(setup, state)}</Insight>}
      metrics={
        <>
          <Comparison sim={state} />
          <ReceiverStrips sim={state} />
        </>
      }
      controls={
        <>
          <div className="border-b border-line pb-4">
            <p className="label mb-2">What the client sends</p>
            <ul className="space-y-1 text-[11px] text-muted">
              <li>
                <span className="font-semibold text-ink">Voice call:</span> a frame of audio every {VOICE_FRAME_MS} ms. Each
                is played {PLAYOUT_BUFFER_MS} ms after it would normally arrive, or it is useless.
              </li>
              <li>
                <span className="font-semibold text-ink">File:</span> {FILE_PACKETS} packets, one every {FILE_PACING_MS} ms.
                Every one must arrive, in order. Each file opens a new connection.
              </li>
              <li>Both run over TCP and over UDP at once, so four streams share the network.</li>
            </ul>
          </div>
          <Slider
            label="Packet loss"
            value={lossRate}
            min={0}
            max={0.2}
            step={0.01}
            onChange={changeNetwork('lossRate')}
            format={(value) => formatPercent(value)}
            hint="Share of data packets the network drops. TCP and UDP lose the same packet numbers."
          />
          <Slider
            label="One-way delay"
            value={delayMs}
            min={10}
            max={150}
            step={5}
            onChange={changeNetwork('delayMs')}
            format={(value) => `${value} ms`}
            hint={`Round trip ${rtt} ms. A TCP resend costs at least one round trip.`}
          />
          <Slider
            label="Jitter"
            value={jitterMs}
            min={0}
            max={100}
            step={5}
            onChange={changeNetwork('jitterMs')}
            format={(value) => `0-${value} ms`}
            hint="Random extra delay per packet, so packets can overtake each other."
          />
          <div className="border-t border-line pt-4">
            <p className="label mb-2">Simplified model</p>
            <ul className="space-y-1 text-[11px] text-muted">
              <li>Shown {SLOW_MOTION}x slower than real time; times in the log are simulated.</li>
              <li>
                A drop is resent after {DUP_ACK_THRESHOLD} duplicate ACKs, or after a timeout of twice the round trip (at
                least {MIN_RTO_MS} ms).
              </li>
              <li>No congestion control: real TCP also slows down after a loss.</li>
              <li>Handshake packets and ACKs are never dropped.</li>
              <li>The four streams do not compete for bandwidth; each only shares the drops and delays.</li>
            </ul>
          </div>
        </>
      }
    >
      <DiagramCanvas layout={LAYOUT} edges={EDGES} particles={particles} height={HEIGHT} className="bg-canvas">
        {LANES.map(({ id, payload, transport }) => (
          <Lane key={id} id={id} payload={payload} transport={transport} stream={state[id]} rtt={rtt} />
        ))}
        {/* The Network kind borrows the CDN icon (a network glyph); it stands for every router on the path. */}
        <ArchNode
          kind="cdn"
          title="Network"
          subtitle={`${delayMs} ms + 0-${jitterMs} ms jitter`}
          placed={LAYOUT.network}
          status={lossRate > 0 ? 'degraded' : 'healthy'}
          statusLabel={lossRate > 0 ? `Drops ${formatPercent(lossRate)}` : 'No loss'}
        >
          <NodeStatRow label="Round trip" value={`${rtt} ms`} />
          <p className="pt-1 text-[11px] font-medium text-muted">Packets dropped</p>
          {LANES.map(({ id, payload, transport }) => (
            <NodeStatRow
              key={id}
              label={`${PAYLOAD_NAME[payload]}, ${transport.toUpperCase()}`}
              value={formatNumber(state[id].stats.dropped)}
              tone={state[id].stats.dropped > 0 ? 'text-danger' : 'text-ink'}
            />
          ))}
          <p className="pt-1 text-[11px] leading-snug text-faint">
            One network for all four streams. TCP counts its lost resends too.
          </p>
        </ArchNode>
      </DiagramCanvas>
    </LabShell>
  );
}

/** One stream: the client that sends it and the app on the server that receives it. */
function Lane({ id, payload, transport, stream, rtt }: { id: LaneId; payload: Payload; transport: Transport; stream: Stream; rtt: number }) {
  const held = heldBack(stream);
  const client: { status: NodeStatus; label: string } =
    stream.phase === 'handshake'
      ? { status: 'starting', label: 'Handshake' }
      : stream.phase === 'waiting'
        ? { status: 'starting', label: 'Opening' }
        : stream.phase === 'draining'
          ? { status: 'healthy', label: 'All packets sent' }
          : { status: 'healthy', label: 'Sending' };
  const tcp = transport === 'tcp';
  return (
    <>
      <ArchNode
        kind="client"
        title={laneName(payload, transport)}
        subtitle={payload === 'voice' ? `Client: a frame every ${VOICE_FRAME_MS} ms` : `Client: ${FILE_PACKETS} packets per file`}
        placed={LAYOUT[`${id}-client`]}
        status={client.status}
        statusLabel={client.label}
      >
        <NodeStatRow
          label="Resent"
          value={tcp ? formatNumber(stream.stats.retransmits) : 'never'}
          tone={tcp && stream.stats.retransmits > 0 ? 'text-warn' : 'text-ink'}
        />
        <NodeStatRow label="Handshake" value={tcp ? `1 round trip, ${rtt} ms` : 'none'} />
      </ArchNode>
      <ArchNode
        kind="server"
        title={`${RECEIVER_NAME[payload]}, ${transport.toUpperCase()}`}
        subtitle={tcp ? 'Server: in order only' : 'Server: as they arrive'}
        placed={LAYOUT[`${id}-server`]}
        status={held > 0 ? 'degraded' : 'healthy'}
        statusLabel={held > 0 ? 'Head-of-line blocked' : 'Receiving'}
        alert={held > 0}
      >
        {tcp ? (
          <>
            <NodeStatRow label="Held back" value={formatNumber(held)} tone={held > 0 ? 'text-warn' : 'text-ink'} />
            <NodeStatRow label="Waiting for" value={held > 0 ? `#${stream.expected}` : 'nothing'} />
          </>
        ) : (
          <>
            <NodeStatRow label="Out of order" value={formatNumber(stream.stats.outOfOrder)} />
            <NodeStatRow
              label="Never arrived"
              value={formatNumber(payload === 'voice' ? stream.stats.lost : stream.stats.missing)}
              tone={(payload === 'voice' ? stream.stats.lost : stream.stats.missing) > 0 ? 'text-danger' : 'text-ink'}
            />
          </>
        )}
      </ArchNode>
    </>
  );
}

function insightText({ lossRate, jitterMs }: NetworkSetup, sim: Sim) {
  const voiceTcp = sim['voice-tcp'].stats;
  const voiceUdp = sim['voice-udp'].stats;
  const fileTcp = sim['file-tcp'].stats;
  const fileUdp = sim['file-udp'].stats;
  const decided = voiceTcp.onTime + voiceTcp.late + voiceTcp.lost;
  const anyDrop = LANES.some(({ id }) => sim[id].stats.dropped > 0);
  if (lossRate === 0 && jitterMs <= PLAYOUT_BUFFER_MS && !anyDrop) {
    return 'Nothing is dropped, so TCP and UDP deliver the same call and the same files. Raise Packet loss, or press Drop the next packet, and compare what each one does with the gap.';
  }
  if (decided < 50 || !fileTcp.files || !fileUdp.files) {
    return 'Collecting frames and files. Watch the TCP receivers when a packet is dropped: the packets behind it are held back until the resend arrives. The UDP receivers never wait.';
  }
  const tcpAvg = fileTcp.fileMsTotal / fileTcp.files;
  const udpAvg = fileUdp.fileMsTotal / fileUdp.files;
  const voice = `Voice call: TCP lost no frame, but ${voiceTcp.late} of ${decided} (${formatPercent(voiceTcp.late / decided, 1)}) came too late to play, because each resend comes at least a round trip later and the frames behind it wait too. UDP lost ${voiceUdp.lost} and had ${voiceUdp.late} late: each loss is one ${VOICE_FRAME_MS} ms gap the codec can hide. Late but complete is worth nothing to a live call.${
    jitterMs > PLAYOUT_BUFFER_MS ? ` Jitter above the ${PLAYOUT_BUFFER_MS} ms playout buffer also makes UDP frames late.` : ''
  }`;
  const file = `File: TCP delivered ${fileTcp.filesComplete} of ${fileTcp.files} files whole, in ${formatLatency(tcpAvg)} on average. UDP finished ${fileUdp.files} in ${formatLatency(udpAvg)}, but ${fileUdp.files - fileUdp.filesComplete} had holes. On time but lossy is worth nothing for a file.`;
  return `${voice} ${file} Same network, opposite answers: what matters is whether late data still has value.`;
}

/* ---------------------------------------------------------------------------------------------- */

const CELL_LABEL: Record<Payload, Record<CellState, string>> = {
  voice: {
    unsent: 'Not sent yet',
    flight: 'On the wire',
    resend: 'Dropped, resend coming',
    held: 'Arrived, held back',
    ok: 'Played on time',
    late: 'Too late to play',
    lost: 'Lost for good',
  },
  file: {
    unsent: 'Not sent yet',
    flight: 'On the wire',
    resend: 'Dropped, resend coming',
    held: 'Arrived, held back',
    ok: 'Delivered',
    late: 'Delivered after a wait',
    lost: 'Lost for good',
  },
};

const LEGEND_STATES: Record<Payload, CellState[]> = {
  voice: ['flight', 'resend', 'held', 'ok', 'late', 'lost'],
  file: ['unsent', 'flight', 'resend', 'held', 'ok', 'late', 'lost'],
};

/** Shape plus colour, so no state depends on colour alone. */
function CellGlyph({ state, size = 14 }: { state: CellState; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="-7 -7 14 14" aria-hidden>
      {state === 'unsent' ? <circle r={4} fill="none" strokeDasharray="2 2" className="stroke-faint" /> : null}
      {state === 'flight' ? <circle r={2.5} className="fill-faint" /> : null}
      {state === 'resend' ? <polygon points="0,-5 4.5,3.5 -4.5,3.5" fill="none" strokeWidth={1.5} className="stroke-warn" /> : null}
      {state === 'held' ? <rect x={-4} y={-4} width={8} height={8} fill="none" strokeWidth={1.5} className="stroke-info" /> : null}
      {state === 'ok' ? <circle r={4.5} className="fill-ok" /> : null}
      {state === 'late' ? <ParticleShape shape="triangle" fill={OUTCOME_STYLE.warning.fill} /> : null}
      {state === 'lost' ? <ParticleShape shape="cross" fill={OUTCOME_STYLE.failure.fill} /> : null}
    </svg>
  );
}

/** One row of cells: what the app on the server got from one stream, one cell per packet. */
function StripRow({ stream, now }: { stream: Stream; now: number }) {
  const { payload } = stream;
  const first = payload === 'voice' ? Math.max(0, stream.nextSeq - VOICE_CELLS) : 0;
  const count = payload === 'voice' ? VOICE_CELLS : FILE_PACKETS;
  return (
    <div className="flex items-start gap-2">
      <span className="w-8 shrink-0 pt-0.5 font-mono text-[11px] font-semibold text-muted">
        {stream.transport.toUpperCase()}
      </span>
      <div className="flex min-w-0 flex-1 flex-wrap gap-0.5">
        {Array.from({ length: count }, (_, index) => {
          const seq = first + index;
          const state = cellState(stream.packets.get(seq), payload, now);
          return (
            <span
              key={seq}
              title={`#${seq}: ${CELL_LABEL[payload][state]}`}
              className={cn(
                'flex h-4 w-4 items-center justify-center rounded-sm border',
                state === 'held' ? 'border-info/50 bg-info/10' : state === 'lost' ? 'border-danger/40' : 'border-line',
              )}
            >
              <CellGlyph state={state} size={12} />
            </span>
          );
        })}
      </div>
    </div>
  );
}

function ReceiverStrips({ sim }: { sim: Sim }) {
  return (
    <div className="card space-y-4 p-4">
      <div>
        <p className="label mb-1">What the app on the server gets</p>
        <p className="text-xs text-faint">
          TCP gives the app nothing past a gap: packets behind a dropped one are held back until its resend arrives. UDP
          gives the app each datagram the moment it arrives, in whatever order, and never fills a gap. Hover a cell for its
          number.
        </p>
      </div>
      {(['voice', 'file'] as const).map((payload) => (
        <div key={payload} className="space-y-1.5">
          <p className="text-xs font-medium text-muted">
            {payload === 'voice'
              ? `Voice call: the last ${VOICE_CELLS} frames, oldest on the left`
              : 'File: every packet of the file each stream is sending now'}
          </p>
          <StripRow stream={sim[`${payload}-tcp`]} now={sim.now} />
          <StripRow stream={sim[`${payload}-udp`]} now={sim.now} />
          <div className="flex flex-wrap gap-x-3 gap-y-1 pl-10 pt-0.5">
            {LEGEND_STATES[payload].map((state) => (
              <span key={state} className="flex items-center gap-1 text-[11px] text-muted">
                <CellGlyph state={state} size={12} />
                {CELL_LABEL[payload][state]}
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

const ratio = (part: number, whole: number) => (whole ? formatPercent(part / whole, 1) : '-');

const ROWS: Record<Payload, { label: string; value: (stream: Stream) => string }[]> = {
  voice: [
    { label: 'Frames played on time', value: (s) => ratio(s.stats.onTime, s.stats.onTime + s.stats.late + s.stats.lost) },
    { label: 'Frames too late to play', value: (s) => formatNumber(s.stats.late) },
    { label: 'Frames lost for good', value: (s) => formatNumber(s.stats.lost) },
    { label: 'Packets resent', value: (s) => formatNumber(s.stats.retransmits) },
    { label: 'Longest wait behind a gap', value: (s) => formatLatency(s.stats.maxHoldMs) },
    { label: 'Arrived out of order', value: (s) => formatNumber(s.stats.outOfOrder) },
  ],
  file: [
    { label: 'Files finished', value: (s) => formatNumber(s.stats.files) },
    { label: 'Files with no missing packet', value: (s) => formatNumber(s.stats.filesComplete) },
    { label: 'Average time per file', value: (s) => (s.stats.files ? formatLatency(s.stats.fileMsTotal / s.stats.files) : '-') },
    { label: 'Packets never delivered', value: (s) => formatNumber(s.stats.missing) },
    { label: 'Packets resent', value: (s) => formatNumber(s.stats.retransmits) },
    { label: 'Longest wait behind a gap', value: (s) => formatLatency(s.stats.maxHoldMs) },
  ],
};

/** What each approach ends up with, in the words of the Lesson. */
const VERDICT: Record<Payload, Record<Transport, string>> = {
  voice: { tcp: 'complete, late', udp: 'on time, gaps' },
  file: { tcp: 'complete, slower', udp: 'faster, holes' },
};

function Comparison({ sim }: { sim: Sim }) {
  return (
    <div className="card p-4">
      <p className="label mb-3">Same network, both transports</p>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-faint">
            <th className="pb-2 font-medium" />
            <th className="pb-2 text-right font-semibold text-brand">TCP</th>
            <th className="pb-2 text-right font-semibold text-violet">UDP</th>
          </tr>
        </thead>
        {(['voice', 'file'] as const).map((payload) => (
          <tbody key={payload}>
            <tr className="border-t border-line">
              <th scope="rowgroup" className="pb-1 pt-3 text-left font-semibold text-ink">
                {PAYLOAD_NAME[payload]}
              </th>
              {(['tcp', 'udp'] as const).map((transport) => (
                <td key={transport} className="pb-1 pt-3 text-right text-[11px] italic text-muted">
                  {VERDICT[payload][transport]}
                </td>
              ))}
            </tr>
            {ROWS[payload].map((row) => (
              <tr key={row.label} className="border-t border-line/60">
                <td className="py-1.5 pr-2 text-muted">{row.label}</td>
                <td className="py-1.5 text-right font-mono tabular-nums text-ink">{row.value(sim[`${payload}-tcp`])}</td>
                <td className="py-1.5 text-right font-mono tabular-nums text-ink">{row.value(sim[`${payload}-udp`])}</td>
              </tr>
            ))}
          </tbody>
        ))}
      </table>
      <p className="mt-3 text-xs text-faint">
        All four streams run at once, and random drops hit the same packet numbers on TCP and on UDP. Counters restart
        when you change the network. {SIMULATED_HINT} See the list under the controls.
      </p>
    </div>
  );
}

/** The particle shapes on the wires, with what each one means in this lab. */
function WireLegend() {
  return (
    <ParticleLegend
      outcomes={[
        { outcome: 'success', label: 'Data packet (and the SYN)' },
        { outcome: 'cache-hit', label: 'ACK going back (and the SYN-ACK)' },
        { outcome: 'warning', label: 'Resent packet' },
        { outcome: 'failure', label: 'Dropped by the network' },
      ]}
    >
      <span className="text-[11px] text-faint">Blue wires: TCP. Violet wires: UDP.</span>
    </ParticleLegend>
  );
}

export default TransportLab;
