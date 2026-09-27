import { useCallback, useRef } from 'react';
import { Hourglass, Power, RotateCw, Send } from 'lucide-react';
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
import { Badge, Button, SegmentedControl, Slider, Toggle } from '@/components/ui';
import { useEventLog, useTicker } from '@/simulations/engine';
import { useLabSetup } from '@/hooks/useLabSetup';
import { useRerender } from '@/hooks/useRerender';
import { cn } from '@/utils/cn';
import type { LabFocus, LabProps, NodeStatus, RequestOutcome } from '@/types';
import {
  CLIENT,
  HEARTBEAT_S,
  PAUSE_S,
  active,
  clientWrite,
  createCluster,
  killNode,
  largestGroup,
  linkUp,
  majority,
  pauseLeader,
  reviveNode,
  setPartition,
  staleLeaders,
  stepCluster,
  workingLeader,
  type ClusterState,
  type Entry,
  type Message,
  type PartitionMode,
  type RaftNode,
} from './consensusModel';
import { useLabRunning } from '@/hooks/useLabRunning';

interface Setup {
  size: 3 | 5;
  /** Client writes per simulated second. */
  writeRate: number;
  /** Base election timeout in simulated seconds. */
  timeoutS: number;
  randomTimeouts: boolean;
}

/** What the lab opens on at /labs/consensus, with no Lab focus. */
const DEFAULT_SETUP: Setup = { size: 5, writeRate: 0.5, timeoutS: 2.5, randomTimeouts: true };

/**
 * The Lab focus of each Concept that hosts this lab. Leader Election opens with
 * no client writes, so the only traffic is heartbeats and - once the learner
 * kills the leader - votes. Consensus opens with a steady stream of writes, so
 * the first thing on screen is an entry going dashed, then solid at a majority.
 */
const FOCUS_SETUPS: Record<LabFocus<'consensus'>, Setup> = {
  'leader-election': { ...DEFAULT_SETUP, writeRate: 0 },
  consensus: { ...DEFAULT_SETUP, writeRate: 1 },
};

const PARTITIONS: { value: PartitionMode; label: string; hint: string }[] = [
  { value: 'none', label: 'No partition', hint: 'Every node reaches every other node.' },
  { value: 'leader-cut', label: 'Cut off the leader', hint: 'The leader lands on the minority side.' },
  { value: 'followers-cut', label: 'Cut off followers', hint: 'The leader keeps the majority side.' },
];

/** Wide enough for the longest subtitle, "candidate, 2 of 3 votes"; tall enough for a follower with its timer bar. */
const NODE_W = 180;
const NODE_H = 146;
const CANVAS_H = 580;

/**
 * Node positions, checked so that no wire of the full mesh, and no wire from the
 * client to any node, runs behind a node card it does not connect to - also when
 * a "cut off" badge makes a card about 10px taller.
 */
const POSITIONS: Record<Setup['size'], [number, number][]> = {
  3: [
    [115, 166],
    [390, 416],
    [665, 166],
  ],
  5: [
    [85, 146],
    [15, 316],
    [390, 416],
    [765, 316],
    [695, 146],
  ],
};

const buildLayout = (size: Setup['size']): Layout => {
  const layout: Layout = { [CLIENT]: { x: 395, y: 14, w: 170, h: 74 } };
  POSITIONS[size].forEach(([x, y], index) => {
    layout[`n${index + 1}`] = { x, y, w: NODE_W, h: NODE_H };
  });
  return layout;
};

const LAYOUTS: Record<Setup['size'], Layout> = { 3: buildLayout(3), 5: buildLayout(5) };

/** How each message is drawn - shape and colour both carry the meaning. */
function outcomeOf(message: Message): RequestOutcome {
  if (message.lost) return 'failure';
  const payload = message.payload;
  switch (payload.type) {
    case 'append':
    case 'write':
      return 'success';
    case 'vote':
      return 'warning';
    case 'append-reply':
      return payload.ok ? 'cache-hit' : 'failure';
    case 'vote-reply':
      return payload.granted ? 'cache-hit' : 'failure';
    case 'write-reply':
      return payload.ok ? 'cache-hit' : 'failure';
  }
}

const LEGEND: { outcome: RequestOutcome; label: string }[] = [
  { outcome: 'success', label: 'Log entries or heartbeat (and client writes)' },
  { outcome: 'cache-hit', label: 'Stored, vote granted, write acknowledged' },
  { outcome: 'warning', label: 'Vote request' },
  { outcome: 'failure', label: 'Rejected, or lost on a dead link' },
];

function ConsensusLegend() {
  return (
    <ParticleLegend outcomes={LEGEND}>
      <span className="flex items-center gap-1.5 text-[11px] text-muted">
        <span className="inline-block h-3 w-3 rounded-sm border border-brand/60 bg-brand/20" />
        committed entry
      </span>
      <span className="flex items-center gap-1.5 text-[11px] text-muted">
        <span className="inline-block h-3 w-3 rounded-sm border border-dashed border-warn/80" />
        stored, not committed
      </span>
    </ParticleLegend>
  );
}

/** One log cell: the term number, solid once committed on this node, dashed before. */
function LogCell({ entry, committed }: { entry: Entry | undefined; committed: boolean }) {
  if (!entry) return <span className="h-4 w-4 shrink-0 rounded-sm border border-line/40" />;
  return (
    <span
      title={entry.noop ? `term ${entry.term}: empty entry that starts the term` : `term ${entry.term}: write #${entry.writeId}`}
      className={cn(
        'flex h-4 w-4 shrink-0 items-center justify-center rounded-sm font-mono text-[11px] font-semibold leading-none',
        committed ? 'border border-brand/60 bg-brand/20 text-brand' : 'border border-dashed border-warn/80 text-warn',
      )}
    >
      {entry.term}
    </span>
  );
}

const shortName = (id: string | null) => (id ? `N${id.slice(1)}` : '-');

function roleText(state: ClusterState, node: RaftNode) {
  if (!node.up) return { subtitle: 'crashed', status: 'down' as NodeStatus, label: 'Crashed' };
  if (!active(state, node)) return { subtitle: `paused, term ${node.term}`, status: 'degraded' as NodeStatus, label: 'Paused' };
  if (node.role === 'leader') return { subtitle: `leader, term ${node.term}`, status: 'healthy' as NodeStatus, label: 'Leader' };
  if (node.role === 'candidate') {
    return {
      subtitle: `candidate, ${node.votes.length} of ${majority(state.nodes.length)} votes`,
      status: 'starting' as NodeStatus,
      label: 'Candidate',
    };
  }
  return { subtitle: `follower, term ${node.term}`, status: 'healthy' as NodeStatus, label: 'Follower' };
}

export function ConsensusLab({ focus }: LabProps<'consensus'>) {
  // The page keys this lab by Concept, so the focus never changes under a mounted lab.
  const start = focus ? FOCUS_SETUPS[focus] : DEFAULT_SETUP;
  // Every control lives in one object, so Reset cannot miss one.
  const { setup, setSetup, change } = useLabSetup(start);
  const { size, writeRate, timeoutS, randomTimeouts } = setup;
  const timing = { timeoutS, randomTimeouts };

  const [running, setRunning] = useLabRunning();
  const state = useRef<ClusterState>(createCluster(start.size, start));
  const rerender = useRerender(30);
  const { events, log, clear } = useEventLog(60);

  const reset = useCallback(() => {
    // Back to this Concept's starting setup, not the lab's global default.
    setSetup(start);
    state.current = createCluster(start.size, start);
    clear();
  }, [start, clear, setSetup]);

  const resize = (next: Setup['size']) => {
    setSetup((current) => ({ ...current, size: next }));
    state.current = createCluster(next, timing);
    clear();
    log(`New ${next}-node cluster: ${majority(next)} nodes are a majority, so it survives ${next - majority(next)} failure(s)`, 'info');
  };

  // The engine is plain functions over the ref; every button mutates it and redraws.
  const act = (action: (cluster: ClusterState) => void) => {
    action(state.current);
    rerender();
  };

  useTicker(running, (dt) => {
    stepCluster(state.current, dt, writeRate, timing, log);
    rerender();
  });

  const cluster = state.current;
  const layout = LAYOUTS[size];
  const need = majority(size);
  const leader = workingLeader(cluster);
  const stale = staleLeaders(cluster);
  const group = largestGroup(cluster);
  const quorumPossible = group >= need;
  const anyLeader = leader ?? stale[0];
  const committed = Math.max(...cluster.nodes.map((node) => node.commit));
  const target = cluster.nodes.find((node) => node.id === cluster.clientTarget);

  // Every node can talk to every other one, so the whole mesh is drawn. The wires
  // in use are coloured: leader to follower, candidate to voter, cut or dead.
  const edges: DiagramEdge[] = [];
  cluster.nodes.forEach((a, i) => {
    cluster.nodes.slice(i + 1).forEach((b) => {
      const down = !a.up || !b.up;
      const cut = !linkUp(cluster, a.id, b.id);
      const leads = (a.role === 'leader' && active(cluster, a)) || (b.role === 'leader' && active(cluster, b));
      const campaigns = (a.role === 'candidate' && active(cluster, a)) || (b.role === 'candidate' && active(cluster, b));
      edges.push({
        from: a.id,
        to: b.id,
        tone: down ? 'muted' : cut ? 'danger' : leads ? 'brand' : campaigns ? 'warn' : 'muted',
        dashed: down || cut,
      });
    });
  });
  // The client can reach every node (see the model header), and it does use more
  // than one: a write still in flight to the old target, a "not the leader" reply,
  // an acknowledgement from a node that has since lost its leadership. So every
  // client wire is drawn, and each message moves only along a wire on screen. The
  // wire to the node the client currently sends to is the highlighted one.
  cluster.nodes.forEach((node) => {
    const current = node === target;
    edges.push({
      from: CLIENT,
      to: node.id,
      tone: !current ? 'muted' : !active(cluster, node) ? 'danger' : node === leader ? 'ok' : 'warn',
      dashed: !node.up || (current && !active(cluster, node)),
      width: current ? 2 : undefined,
    });
  });

  const particles: ParticleView[] = cluster.messages
    .filter((message) => layout[message.from] && layout[message.to])
    .map((message) => ({
      id: message.id,
      from: message.from,
      to: message.to,
      t: Math.min(message.t, 1),
      outcome: outcomeOf(message),
    }));

  const now = cluster.now;
  const gapNow = cluster.leaderlessSince !== null ? now - cluster.leaderlessSince : null;
  const cutNames = cluster.cutOff.map((id) => cluster.nodes.find((node) => node.id === id)?.name).join(', ');

  // The window of log indices shown side by side under the diagram.
  const longest = Math.max(...cluster.nodes.map((node) => node.log.length));
  const WINDOW = 16;
  const from = Math.max(0, longest - WINDOW);
  const indices = Array.from({ length: Math.min(WINDOW, longest) }, (_, offset) => from + offset);

  const insight = !quorumPossible ? (
    <>
      Only {group} of {size} nodes can reach each other, and a majority is {need}. No candidate can collect {need} votes
      and no entry can reach {need} copies, so the cluster stops accepting writes instead of letting two histories grow.
      That refusal is the point: it is what keeps every committed entry safe. Revive a node or heal the partition.
    </>
  ) : stale.length > 0 && leader ? (
    <>
      {stale[0].name} still believes it leads term {stale[0].term}, but it cannot reach a majority. Its new entries stay
      dashed - they never reach {need} copies - and writes sent to it time out. The majority side elected {leader.name}{' '}
      for term {leader.term}. Heal the partition: {stale[0].name} sees the higher term, steps down, and its uncommitted
      entries are replaced by the leader log.
    </>
  ) : !leader ? (
    <>
      No working leader right now, so no write can commit. Each follower waits for its election timeout (the bar on each
      node); the first to run out becomes a candidate, raises the term and asks for votes. It needs {need} of {size},
      its own included.
      {randomTimeouts
        ? ' Timeouts are randomised, so usually one node stands alone and wins in one round.'
        : ' All timeouts are equal, so several nodes stand at once, split the vote and try again - turn randomised timeouts back on.'}
    </>
  ) : writeRate === 0 && focus !== 'consensus' ? (
    <>
      {leader.name} leads term {leader.term} and sends a heartbeat every {HEARTBEAT_S} s; each one resets the election
      timer of every follower (the bar on each node). Kill the leader, or pause it for {PAUSE_S} s: the timers run out,
      one follower stands for term {leader.term + 1}, and it needs {need} of {size} votes. A paused leader that wakes up
      sees the higher term and steps down.
      {size === 5 ? ' Five nodes survive two failures - kill the new leader too, then a third node.' : ''}
    </>
  ) : (
    <>
      Each write goes to {leader.name}, which appends it (dashed) and copies it to the followers. Once {need} of {size}{' '}
      nodes store it, it is committed (solid) and the client gets its answer. Kill followers one at a time: with{' '}
      {size - need} down, writes still commit; one more and they stop, because no {need} nodes can agree any more.
    </>
  );

  return (
    <LabShell
      title="Consensus Lab"
      description="A Raft-style cluster, simplified: nodes elect a leader, and the leader commits each write once a majority stores it. Crash, pause or cut off nodes and watch elections, the quorum and when writes stop."
      running={running}
      onRunningChange={setRunning}
      onReset={reset}
      legend={<ConsensusLegend />}
      events={events}
      actions={
        <>
          <Button variant="danger" disabled={!anyLeader || !active(cluster, anyLeader)} onClick={() => anyLeader && act((c) => killNode(c, anyLeader.id, log))}>
            <Power className="h-4 w-4" />
            Kill the leader
          </Button>
          <Button disabled={!anyLeader || !active(cluster, anyLeader)} onClick={() => act((c) => pauseLeader(c, log))}>
            <Hourglass className="h-4 w-4" />
            Pause the leader {PAUSE_S} s
          </Button>
          <Button variant="primary" onClick={() => act(clientWrite)}>
            <Send className="h-4 w-4" />
            Send one write
          </Button>
        </>
      }
      insight={<Insight>{insight}</Insight>}
      metrics={
        <>
          <MetricsPanel
            items={[
              {
                key: 'leader',
                label: 'Leader',
                value: leader ? leader.name : 'None',
                unit: leader ? `term ${leader.term}` : undefined,
                tone: leader ? 'ok' : 'danger',
                hint: 'A leader that is running and can reach a majority - the only kind that can commit a write.',
              },
              {
                key: 'quorum',
                label: 'Nodes that can agree',
                value: `${group} of ${size}`,
                unit: `need ${need}`,
                tone: quorumPossible ? 'ok' : 'danger',
                hint: 'The largest group of running nodes that can all reach each other. Below a majority, nothing commits.',
              },
              {
                key: 'committed',
                label: 'Committed entries',
                value: committed,
                hint: 'Log entries a majority stores. Includes the one empty entry each new leader appends to start its term.',
              },
              { key: 'acked', label: 'Writes acknowledged', value: cluster.acked, tone: 'ok' },
              {
                key: 'failed',
                label: 'Writes timed out',
                value: cluster.failed,
                tone: cluster.failed > 0 ? 'danger' : 'neutral',
                hint: 'The client gave up waiting. A timed-out write may still commit later, which is why clients retry with a request id.',
              },
              {
                key: 'elections',
                label: 'Elections',
                value: cluster.elections,
                unit: cluster.failedElections ? `${cluster.failedElections} failed` : undefined,
                tone: cluster.failedElections > 0 ? 'warn' : 'neutral',
                hint: 'Every candidacy counts. A failed one ran out of time without a majority of votes - a split vote, or too few nodes reachable.',
              },
              {
                key: 'gap',
                label: 'Time without a leader',
                value: gapNow !== null ? `${gapNow.toFixed(1)} s` : cluster.lastGap !== null ? `${cluster.lastGap.toFixed(1)} s` : '-',
                unit: gapNow !== null ? 'and counting' : cluster.lastGap !== null ? 'last gap' : undefined,
                tone: gapNow !== null ? 'danger' : 'neutral',
                hint: 'Detection (the election timeout) plus the election itself. Lab time is slowed down so messages are visible.',
                simulated: true,
              },
            ]}
          />

          <div className="card p-4">
            <p className="label mb-3">Logs side by side (one column per log index)</p>
            <div className="overflow-x-auto">
              <table className="font-mono text-[11px]">
                <thead className="text-faint">
                  <tr>
                    <th className="pr-3 text-left font-medium">node</th>
                    {indices.map((index) => (
                      <th key={index} className="w-5 text-center font-medium">
                        {index + 1}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {cluster.nodes.map((node) => (
                    <tr key={node.id}>
                      <td className={cn('py-0.5 pr-3', node.up ? 'text-ink' : 'text-danger')}>{node.name}</td>
                      {indices.map((index) => (
                        <td key={index} className="py-0.5">
                          <span className="flex justify-center">
                            <LogCell entry={node.log[index]} committed={index < node.commit} />
                          </span>
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-xs text-faint">
              The number in a cell is the term the entry was written in. Solid means this node knows a majority stores it.
              Where two nodes disagree at an index, the entry is not committed - Raft never lets two committed entries
              differ.
            </p>
          </div>
        </>
      }
      controls={
        <>
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted">Cluster size (starts a new cluster)</p>
            <SegmentedControl
              size="sm"
              className="w-full"
              value={String(size) as '3' | '5'}
              options={[
                { value: '3', label: '3 nodes' },
                { value: '5', label: '5 nodes' },
              ]}
              onChange={(value) => resize(value === '3' ? 3 : 5)}
            />
          </div>
          <Slider
            label="Client writes"
            value={writeRate}
            min={0}
            max={3}
            step={0.5}
            onChange={change('writeRate')}
            format={(value) => `${value} per second`}
            hint="Each write is appended by the leader and acknowledged once a majority stores it."
          />
          <Slider
            label="Election timeout"
            value={timeoutS}
            min={1.5}
            max={5}
            step={0.5}
            onChange={change('timeoutS')}
            format={(value) => `${value} s`}
            hint={`How long a follower waits without a heartbeat before it stands. The leader sends one every ${HEARTBEAT_S} s. Lab time is slowed down; etcd defaults to a 100 ms heartbeat and a 1000 ms timeout.`}
          />
          <Toggle
            label="Randomised timeouts"
            checked={randomTimeouts}
            onChange={change('randomTimeouts')}
            description={
              randomTimeouts
                ? `Each wait is drawn between ${timeoutS} and ${timeoutS * 2} s, so one node usually stands first.`
                : 'Every node waits the same time - watch the votes split.'
            }
          />

          <div className="space-y-2">
            <p className="text-xs font-medium text-muted">Network partition</p>
            <div className="space-y-1.5">
              {PARTITIONS.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  onClick={() => act((c) => setPartition(c, item.value, log))}
                  aria-pressed={cluster.partitionMode === item.value}
                  className={cn(
                    'w-full rounded-lg border px-3 py-2 text-left text-xs font-medium transition-colors',
                    cluster.partitionMode === item.value
                      ? 'border-brand bg-brand/10 text-brand'
                      : 'border-line text-muted hover:border-brand/50 hover:text-ink',
                  )}
                >
                  {item.label}
                  <span className="block text-[11px] font-normal text-faint">{item.hint}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <p className="text-xs font-medium text-muted">Crash or restart a node</p>
            <div className="grid grid-cols-2 gap-1.5">
              {cluster.nodes.map((node) => (
                <Button
                  key={node.id}
                  size="sm"
                  variant={node.up ? 'secondary' : 'success'}
                  className="justify-center"
                  onClick={() =>
                    act((c) => (node.up ? killNode(c, node.id, log) : reviveNode(c, node.id, timing, log)))
                  }
                >
                  {node.up ? <Power className="h-3 w-3" /> : <RotateCw className="h-3 w-3" />}
                  {node.up ? `Kill ${node.name}` : `Restart ${node.name}`}
                </Button>
              ))}
            </div>
          </div>

          <p className="text-[11px] text-muted">
            Simplified Raft: times are slowed down so each message is visible, an append carries the whole leader log,
            and the client learns the new leader as soon as a write fails. No pre-vote, which real systems such as etcd
            add so a rejoining node does not force a needless election.
          </p>
        </>
      }
    >
      <DiagramCanvas layout={layout} edges={edges} particles={particles} height={CANVAS_H} className="bg-canvas">
        <ArchNode
          kind="client"
          title="Client"
          subtitle={target ? `writes go to ${target.name}` : 'no target'}
          placed={layout[CLIENT]}
          compact
        />
        {cluster.nodes.map((node) => {
          const role = roleText(cluster, node);
          const awake = active(cluster, node);
          const left = Math.max(0, node.electionAt - now);
          const share = node.timeoutS > 0 ? Math.min(1, left / node.timeoutS) : 0;
          const recent = node.log.slice(-7);
          const offset = node.log.length - recent.length;
          return (
            <ArchNode
              key={node.id}
              kind="server"
              title={node.name}
              subtitle={role.subtitle}
              status={role.status}
              statusLabel={role.label}
              placed={layout[node.id]}
              selected={node === leader}
              alert={stale.includes(node)}
              badge={cluster.cutOff.includes(node.id) ? <Badge tone="danger">cut off</Badge> : undefined}
              compact
            >
              <div className="flex items-center gap-0.5" aria-label={`${node.name} log, ${node.log.length} entries, ${node.commit} committed`}>
                {recent.map((entry, index) => (
                  <LogCell key={entry.id} entry={entry} committed={offset + index < node.commit} />
                ))}
              </div>
              <NodeStatRow label="Term / voted for" value={`${node.term} / ${shortName(node.votedFor)}`} />
              {node.role === 'leader' || !awake ? (
                <NodeStatRow
                  label={node.role === 'leader' && awake ? 'Heartbeat' : 'Election timer'}
                  value={node.role === 'leader' && awake ? `every ${HEARTBEAT_S} s` : 'stopped'}
                  tone="text-faint"
                />
              ) : (
                <div className="space-y-0.5">
                  <NodeStatRow label="Election timer" value={`${left.toFixed(1)} s`} tone={share < 0.3 ? 'text-warn' : 'text-ink'} />
                  <div className="h-1 overflow-hidden rounded-full bg-line" aria-hidden>
                    <div className={cn('h-full rounded-full', share < 0.3 ? 'bg-warn' : 'bg-brand')} style={{ width: `${share * 100}%` }} />
                  </div>
                </div>
              )}
            </ArchNode>
          );
        })}
        {cluster.cutOff.length > 0 ? (
          <div className="absolute left-4 top-[540px] rounded-lg border border-danger bg-surface px-3 py-1.5 font-mono text-[11px] font-semibold text-danger">
            X partition: {cutNames} cut off X
          </div>
        ) : null}
      </DiagramCanvas>
    </LabShell>
  );
}

export default ConsensusLab;
