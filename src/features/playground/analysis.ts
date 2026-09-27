import type { Edge, Node } from 'reactflow';
import type { NodeKind } from '@/types';
import type { PlaygroundNodeData } from './nodes';

export interface AnalysisResult {
  /** Incoming load per node id, in requests per second. */
  load: Record<string, number>;
  bottlenecks: string[];
  risks: { id: string; severity: 'high' | 'medium' | 'low'; message: string; fix: string }[];
  scores: { scalability: number; availability: number; performance: number };
  complexity: 'Low' | 'Medium' | 'High';
  cost: 'Low' | 'Medium' | 'High';
  /** Requests per second that never reach a working component. */
  dropped: number;
  /** False while nothing is wired: there is no architecture to score yet, only loose boxes. */
  scored: boolean;
}

type PlaygroundNode = Node<PlaygroundNodeData>;
type Risk = AnalysisResult['risks'][number];

/** Stores a cache could sit in front of. */
const STORES: ReadonlySet<NodeKind> = new Set<NodeKind>(['sql', 'nosql', 'storage', 'search']);

/** Origins a CDN could sit in front of: whatever serves the HTTP responses it caches. */
const ORIGINS: ReadonlySet<NodeKind> = new Set<NodeKind>(['load-balancer', 'api-gateway', 'server', 'service', 'storage']);

/**
 * Share of traffic a component passes on to its downstream dependencies.
 * A CDN only answers static assets; the Client traffic here is mostly dynamic
 * API calls, so nearly all of it still reaches the load balancer. The Redis
 * cache, not the CDN, is what shields the database.
 */
const PASS_THROUGH: Partial<Record<NodeKind, number>> = {
  cdn: 0.9,
  cache: 0.2,
  queue: 1,
};

/**
 * What each caching component shields when it sits beside another target of
 * the same caller. A Redis cache answers reads that would otherwise go to a
 * data store; a CDN answers requests that would otherwise go to the origin.
 * Neither absorbs anything else: a job put on a queue or a call to another
 * service is not a read a cache could have answered, so it keeps full traffic.
 */
const SHIELDS: Partial<Record<NodeKind, ReadonlySet<NodeKind>>> = {
  cache: STORES,
  cdn: ORIGINS,
};

/** Hops a request may travel before propagation gives up on it. */
const MAX_DEPTH = 12;

/**
 * Upper bound on propagation steps for one analysis. Fan-out multiplies paths,
 * so a densely wired canvas can have far more paths than components; the depth
 * cap alone would still let it enumerate millions. 20,000 steps covers every
 * preset many times over and keeps a pathological canvas under a frame or two.
 */
const MAX_PROPAGATION_STEPS = 20_000;

/**
 * Propagates traffic from client nodes through the graph and derives an
 * educational health score.
 *
 * This is a heuristic, not a capacity planner: it exists to make the effect of
 * adding a cache, a replica or a load balancer visible and arguable.
 */
export function analyze(nodes: PlaygroundNode[], edges: Edge[], traffic: number): AnalysisResult {
  if (nodes.length === 0) return emptyCanvasResult();

  const { load, dropped } = propagateLoad(nodes, edges, traffic);
  const bottlenecks = nodes
    .filter((node) => node.data.capacity > 0 && node.data.status !== 'down' && load[node.id] > node.data.capacity)
    .map((node) => node.id);

  const inventory = takeInventory(nodes, edges);
  const risks = detectRisks(inventory, bottlenecks.length);
  const scores = scoreArchitecture(inventory, bottlenecks.length, risks);

  const complexity = nodes.length > 12 ? 'High' : nodes.length > 6 ? 'Medium' : 'Low';
  const cost =
    nodes.length + inventory.servers > 16 ? 'High' : nodes.length > 8 || inventory.databases > 2 ? 'Medium' : 'Low';

  return { load, bottlenecks, risks, scores, complexity, cost, dropped, scored: inventory.anyWired };
}

/**
 * Nothing to score. Returning the base heuristic scores here showed
 * "Performance 40 / 100" and gateway advice for a canvas with no components.
 */
function emptyCanvasResult(): AnalysisResult {
  return {
    load: {},
    bottlenecks: [],
    risks: [
      {
        id: 'empty',
        severity: 'low',
        message: 'The canvas is empty, so there is nothing to analyze yet.',
        fix: 'Add a Client and a Server from Components and connect them, or load a preset.',
      },
    ],
    scores: { scalability: 0, availability: 0, performance: 0 },
    complexity: 'Low',
    cost: 'Low',
    dropped: 0,
    scored: false,
  };
}

/**
 * The clients the traffic enters through. A client with no wire out sends nowhere, so it takes no share:
 * otherwise adding a second, unwired Client silently halved the load on the rest of the system.
 */
export function trafficSources(nodes: PlaygroundNode[], edges: Edge[]) {
  const clients = nodes.filter((node) => node.data.kind === 'client');
  const sending = new Set(edges.map((edge) => edge.source));
  const wired = clients.filter((node) => sending.has(node.id));
  return wired.length > 0 ? wired : clients;
}

/**
 * Breadth-first propagation. Each item remembers the path it took, and traffic
 * never re-enters a component already on its path: a request that reaches the
 * database does not come back around to the server as a brand-new request. A
 * depth cap alone let a two node cycle multiply the load six times over.
 */
function propagateLoad(nodes: PlaygroundNode[], edges: Edge[], traffic: number) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge.target]);
  }

  const load: Record<string, number> = Object.fromEntries(nodes.map((node) => [node.id, 0]));
  let dropped = 0;

  const clients = trafficSources(nodes, edges);
  const queue: { id: string; amount: number; depth: number; path: string[] }[] = clients.map((node) => ({
    id: node.id,
    amount: traffic / Math.max(clients.length, 1),
    depth: 0,
    path: [node.id],
  }));

  let budget = MAX_PROPAGATION_STEPS;
  while (queue.length && budget-- > 0) {
    const item = queue.shift();
    if (!item || item.depth > MAX_DEPTH) continue;
    const node = byId.get(item.id);
    if (!node) continue;

    if (node.data.kind !== 'client') {
      if (node.data.status === 'down') {
        dropped += item.amount;
        continue;
      }
      load[node.id] += item.amount;
    }

    const targets = outgoing.get(item.id) ?? [];
    if (targets.length === 0) continue;

    const pass = node.data.kind === 'client' ? 1 : (PASS_THROUGH[node.data.kind] ?? 1);
    const forwarded = item.amount * pass;
    if (forwarded <= 0.01) continue;

    // Load balancers and gateways split traffic; other components fan it out.
    const split =
      node.data.kind === 'load-balancer' || node.data.kind === 'api-gateway' || node.data.kind === 'queue'
        ? forwarded / targets.length
        : forwarded;

    /**
     * Cache-aside: a component wired to both a cache and the store behind it
     * checks the cache on every read, but only the misses continue to the
     * store. Without this the direct edge carried full traffic *and* the cache
     * added its own share on top, so dragging in a cache made the database
     * busier - the exact opposite of what the lab is meant to show. Only the
     * targets the cache shields get the miss share (see SHIELDS).
     */
    const siblingKinds = targets.map((id) => byId.get(id)?.data.kind);
    const missShare = (kind: NodeKind | undefined) =>
      siblingKinds.reduce((lowest, sibling) => {
        if (!kind || !sibling || !SHIELDS[sibling]?.has(kind)) return lowest;
        return Math.min(lowest, PASS_THROUGH[sibling] ?? 1);
      }, 1);

    // The component that sent this traffic here, if any.
    const caller = item.path[item.path.length - 2];

    for (const target of targets) {
      if (item.path.includes(target)) continue;
      const kind = byId.get(target)?.data.kind;
      /**
       * The playground models cache-aside only: the application reads the
       * cache and, on a miss, goes to the store itself. When the caller is also
       * wired to this store, its direct edge already carries the misses, so the
       * Cache -> store edge carries none - otherwise every miss counts twice.
       * Without a direct edge the Cache -> store edge is the only way to draw
       * the miss path, so the misses flow through it.
       */
      if (node.data.kind === 'cache' && kind && STORES.has(kind) && caller && outgoing.get(caller)?.includes(target)) {
        continue;
      }
      queue.push({
        id: target,
        amount: split * missShare(kind),
        depth: item.depth + 1,
        path: [...item.path, target],
      });
    }
  }

  return { load, dropped };
}

/**
 * What is on the canvas, counting only wired components. A component with no
 * edges receives no traffic, so dropping fifteen unconnected boxes on the
 * canvas must not score as a redundant, cached, load balanced system.
 * Monitoring is the exception: it observes everything and is conventionally
 * drawn without request edges.
 */
function takeInventory(nodes: PlaygroundNode[], edges: Edge[]) {
  const wired = new Set(edges.flatMap((edge) => [edge.source, edge.target]));
  const isScored = (node: PlaygroundNode) => node.data.kind === 'monitoring' || wired.has(node.id);
  const countByKind = (kind: NodeKind) => nodes.filter((node) => node.data.kind === kind && isScored(node)).length;
  const has = (kind: NodeKind) => countByKind(kind) > 0;

  return {
    has,
    anyWired: wired.size > 0,
    unwired: nodes.filter((node) => !isScored(node)),
    clients: nodes.filter((node) => node.data.kind === 'client').length,
    servers: countByKind('server') + countByKind('service'),
    databases: countByKind('sql') + countByKind('nosql'),
    // Whatever fronts the whole system is redundant in a real deployment (see CLAUDE.md).
    loneFrontDoors: (['load-balancer', 'api-gateway'] as const).filter((kind) => countByKind(kind) === 1),
  };
}

type Inventory = ReturnType<typeof takeInventory>;

function detectRisks(inventory: Inventory, bottleneckCount: number): Risk[] {
  const { has, servers, databases } = inventory;
  const risks: Risk[] = [];

  if (databases === 1) {
    risks.push({
      id: 'single-db',
      severity: 'high',
      message: 'Single database instance - it is a single point of failure and a write bottleneck.',
      fix: 'Add a replica for reads and failover, or partition the data.',
    });
  }
  if (servers === 1) {
    risks.push({
      id: 'single-server',
      severity: 'high',
      message: 'Only one application instance - losing it is a full outage.',
      fix: 'Run at least two instances behind a load balancer.',
    });
  }
  if (servers > 1 && !has('load-balancer') && !has('api-gateway')) {
    risks.push({
      id: 'no-lb',
      severity: 'medium',
      message: 'Several application instances with nothing distributing traffic between them.',
      fix: 'Put a load balancer in front of the instances.',
    });
  }
  for (const kind of inventory.loneFrontDoors) {
    const name = kind === 'load-balancer' ? 'load balancer' : 'API gateway';
    risks.push({
      id: `single-${kind}`,
      severity: 'medium',
      message: `Only one ${name} - every request passes through it, so it is a single point of failure.`,
      fix: `Run the ${name} as a redundant pair (for example two nodes in different availability zones).`,
    });
  }
  if (!has('cache') && databases > 0) {
    risks.push({
      id: 'no-cache',
      severity: 'medium',
      message: 'No cache - every read reaches the database.',
      fix: 'Add a cache in front of the hottest read path.',
    });
  }
  if (!has('cdn') && has('client')) {
    risks.push({
      id: 'no-cdn',
      severity: 'low',
      message: 'No CDN - distant users pay full round-trip latency for every asset.',
      fix: 'Serve static content from an edge cache.',
    });
  }
  if (!has('api-gateway') && !has('load-balancer')) {
    risks.push({
      id: 'no-rate-limit',
      severity: 'medium',
      message: 'No gateway or load balancer, so no place to apply rate limiting or TLS termination.',
      fix: 'Add an API gateway as the single entry point.',
    });
  }
  if (!has('monitoring')) {
    risks.push({
      id: 'no-monitoring',
      severity: 'low',
      message: 'No monitoring component - you would discover failures from users.',
      fix: 'Add monitoring and define what pages a human.',
    });
  }
  if (bottleneckCount > 0) {
    risks.push({
      id: 'bottleneck',
      severity: 'high',
      message:
        bottleneckCount === 1
          ? 'One component is receiving more traffic than it can serve.'
          : `${bottleneckCount} components are receiving more traffic than they can serve.`,
      fix: 'Add capacity, cache in front of them, or move the work to a queue.',
    });
  }
  if (inventory.unwired.length > 0) {
    const names = inventory.unwired.map((node) => node.data.label).join(', ');
    risks.push({
      id: 'unwired',
      severity: 'medium',
      message: `Not connected to anything: ${names}. Unconnected components receive no traffic and do not count in the scores.`,
      fix: 'Drag from the bottom handle of one component to the top handle of another to connect them.',
    });
  }
  if (inventory.clients === 0) {
    risks.push({
      id: 'no-client',
      severity: 'low',
      message: 'No client node, so no traffic enters the system.',
      fix: 'Add a Client component to generate traffic.',
    });
  }

  return risks;
}

/** Educational heuristics, not measurements. */
function scoreArchitecture(inventory: Inventory, bottleneckCount: number, risks: Risk[]): AnalysisResult['scores'] {
  // Nothing is connected yet, so there is no architecture to score - only loose boxes.
  if (!inventory.anyWired) return { scalability: 0, availability: 0, performance: 0 };

  const { has, servers, databases } = inventory;

  const scalability = clampScore(
    30 +
      (has('load-balancer') ? 20 : 0) +
      (servers > 1 ? 15 : 0) +
      (servers > 2 ? 5 : 0) +
      (has('cache') ? 15 : 0) +
      (has('queue') ? 10 : 0) +
      (databases > 1 ? 10 : 0) -
      bottleneckCount * 12,
  );

  const availability = clampScore(
    25 +
      (servers > 1 ? 25 : 0) +
      (databases > 1 ? 20 : 0) +
      (has('load-balancer') ? 15 : 0) +
      (has('monitoring') ? 10 : 0) +
      (has('queue') ? 5 : 0) -
      inventory.loneFrontDoors.length * 10 -
      risks.filter((risk) => risk.severity === 'high').length * 15,
  );

  const performance = clampScore(
    40 +
      (has('cache') ? 25 : 0) +
      (has('cdn') ? 20 : 0) +
      (has('queue') ? 5 : 0) +
      (has('search') ? 5 : 0) -
      bottleneckCount * 15,
  );

  return { scalability, availability, performance };
}

const clampScore = (value: number) => Math.max(0, Math.min(100, Math.round(value)));
