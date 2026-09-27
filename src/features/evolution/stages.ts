import type { DiagramEdge, Layout } from '@/components/architecture';
import type { NodeKind } from '@/types';

export interface StageNode {
  id: string;
  kind: NodeKind;
  title: string;
  subtitle?: string;
  placed: { x: number; y: number; w: number; h: number };
  /** Marks the component introduced at this stage. */
  isNew?: boolean;
  /** A hot standby: wired in, but carries no traffic (in or out) until the active node fails. */
  standby?: boolean;
}

export interface StageOption {
  label: string;
  recommended?: boolean;
  feedback: string;
}

export interface Stage {
  id: string;
  title: string;
  /** The symptom that forces the next change. */
  problem: string;
  question: string;
  options: StageOption[];
  /** Why the new component exists, and what it costs. */
  introduced?: { component: string; because: string; cost: string; concept: string };
  nodes: StageNode[];
  edges: DiagramEdge[];
  /** See VisualSpec.asymmetric - why replicas here are wired differently. */
  asymmetric?: string;
  metrics: { label: string; value: string; tone?: 'ok' | 'warn' | 'danger' }[];
}

const box = (x: number, y: number, w = 170, h = 84) => ({ x, y, w, h });

/**
 * Eight stages of one system growing up. Each stage exists because the previous
 * one broke in a specific, observable way.
 */
export const STAGES: Stage[] = [
  {
    id: 'stage-1',
    title: 'Stage 1 - Client, server, database',
    problem: 'One server handles every request and talks to one database. That was fine - until traffic grew and it hit 98% CPU.',
    question: 'Traffic grows 10x over a month and the server sits at 98% CPU. What would you do first?',
    options: [
      {
        label: 'Move to a bigger machine',
        recommended: true,
        feedback:
          'Correct as a first move. It is the cheapest change that buys real time, needs no code change, and keeps the system simple while you learn where the real limits are.',
      },
      {
        label: 'Split into microservices',
        feedback:
          'This solves an organisational problem you do not have, and adds network calls, distributed transactions and deployment machinery to a system that just needs more CPU.',
      },
      {
        label: 'Add a cache immediately',
        feedback:
          'Possibly useful later, but you do not yet know whether the CPU is spent on queries, serialization or business logic. Measure before adding components.',
      },
      {
        label: 'Rewrite in a faster language',
        feedback:
          'Months of work for a constant-factor gain, while the architecture problem stays. Almost never the right first answer.',
      },
    ],
    nodes: [
      { id: 'client', kind: 'client', title: 'Client', placed: box(400, 30, 180, 70) },
      { id: 'server', kind: 'server', title: 'Server', subtitle: '2 vCPU / 4 GB', placed: box(400, 180, 180, 96) },
      { id: 'db', kind: 'sql', title: 'PostgreSQL', placed: box(400, 350, 180, 84) },
    ],
    edges: [
      { from: 'client', to: 'server', tone: 'brand', width: 2 },
      { from: 'server', to: 'db', tone: 'info' },
    ],
    metrics: [
      { label: 'Servers', value: '1' },
      { label: 'CPU', value: '98%', tone: 'danger' },
      { label: 'p95 latency', value: '820 ms', tone: 'danger' },
      { label: 'Errors', value: '8%', tone: 'danger' },
    ],
  },
  {
    id: 'stage-2',
    title: 'Stage 2 - A bigger server',
    problem: 'Latency recovered, but the machine is still one machine - and there is a largest machine you can buy.',
    question: 'A deploy takes the server down for 40 seconds, and users see errors. What now?',
    options: [
      {
        label: 'Run several servers behind a load balancer',
        recommended: true,
        feedback:
          'Right. Multiple instances give you redundancy and rolling deploys, and remove the hardware ceiling. Two preconditions: the app must be stateless, and the balancer needs a standby of its own - otherwise you have moved the single point of failure rather than removed it.',
      },
      {
        label: 'Deploy at night when nobody notices',
        feedback:
          'This hides the symptom and does nothing about the failure mode: the machine can still die at 3pm on its own.',
      },
      {
        label: 'Buy an even bigger machine',
        feedback:
          'Capacity is no longer the problem - availability is. A larger single machine has exactly the same failure mode.',
      },
    ],
    introduced: {
      component: 'A larger instance',
      because: 'One machine was saturated and vertical scaling was the fastest fix available.',
      cost: 'Still a single point of failure, a restart still means downtime, and cost grows faster than capacity.',
      concept: 'vertical-scaling',
    },
    nodes: [
      { id: 'client', kind: 'client', title: 'Clients', placed: box(400, 30, 180, 70) },
      { id: 'server', kind: 'server', title: 'Server', subtitle: '16 vCPU / 64 GB', placed: box(390, 180, 200, 100), isNew: true },
      { id: 'db', kind: 'sql', title: 'PostgreSQL', placed: box(400, 350, 180, 84) },
    ],
    edges: [
      { from: 'client', to: 'server', tone: 'brand', width: 2 },
      { from: 'server', to: 'db', tone: 'info' },
    ],
    metrics: [
      { label: 'Servers', value: '1' },
      { label: 'CPU', value: '38%', tone: 'ok' },
      { label: 'p95 latency', value: '95 ms', tone: 'ok' },
      { label: 'Availability', value: 'SPOF', tone: 'danger' },
    ],
  },
  {
    id: 'stage-3',
    title: 'Stage 3 - Load balancer and multiple servers',
    problem: 'Users are being logged out at random. Sessions live in the memory of whichever server handled the login.',
    question: 'Requests now land on a different server each time. How do you fix the session problem?',
    options: [
      {
        label: 'Move sessions to a shared store, or use signed tokens',
        recommended: true,
        feedback:
          'Right. Statelessness is the precondition for horizontal scaling: shared sessions in Redis, or a JWT the client carries, let any server serve any user.',
      },
      {
        label: 'Turn on sticky sessions',
        feedback:
          'It works today and hurts later: load becomes uneven, losing a server logs out its users, and autoscaling or a rolling deploy disrupts sessions.',
      },
      {
        label: 'Go back to one server',
        feedback: 'That trades an inconvenience for an outage risk and a hard capacity ceiling.',
      },
    ],
    introduced: {
      component: 'Load balancer pair + 3 servers',
      because: 'One machine could not provide redundancy or zero-downtime deploys.',
      cost: 'Local state now breaks, the balancer needs a standby or it is the new single point of failure, and the database sees traffic from every instance.',
      concept: 'load-balancing',
    },
    // The standby is drawn, not implied: a single balancer in front of three
    // servers is still a system with one box that takes everything down.
    nodes: [
      { id: 'client', kind: 'client', title: 'Clients', placed: box(400, 16, 180, 69) },
      { id: 'lb', kind: 'load-balancer', title: 'Load Balancer', subtitle: 'active, holds the VIP', placed: box(245, 120, 191, 84), isNew: true },
      { id: 'lb2', kind: 'load-balancer', title: 'Standby LB', subtitle: 'takes over on failure', placed: box(530, 120, 190, 84), isNew: true, standby: true },
      { id: 'api1', kind: 'server', title: 'API 1', placed: box(170, 285, 160, 88), isNew: true },
      { id: 'api2', kind: 'server', title: 'API 2', placed: box(400, 285, 160, 88), isNew: true },
      { id: 'api3', kind: 'server', title: 'API 3', placed: box(630, 285, 160, 88), isNew: true },
      { id: 'db', kind: 'sql', title: 'PostgreSQL', placed: box(400, 440, 180, 80) },
    ],
    edges: [
      { from: 'client', to: 'lb', tone: 'brand', width: 2 },
      { from: 'client', to: 'lb2', tone: 'muted', dashed: true, label: 'on failover' },
      { from: 'lb', to: 'api1', tone: 'ok' },
      { from: 'lb', to: 'api2', tone: 'ok' },
      { from: 'lb', to: 'api3', tone: 'ok' },
      // What the standby would reach once it takes over: dashed and muted, and
      // no particles (EvolutionPage skips every edge touching a standby node).
      { from: 'lb2', to: 'api1', tone: 'muted', dashed: true },
      { from: 'lb2', to: 'api2', tone: 'muted', dashed: true },
      { from: 'lb2', to: 'api3', tone: 'muted', dashed: true },
      { from: 'api1', to: 'db', tone: 'info' },
      { from: 'api2', to: 'db', tone: 'info' },
      { from: 'api3', to: 'db', tone: 'info' },
    ],
    metrics: [
      { label: 'Servers', value: '3', tone: 'ok' },
      { label: 'CPU each', value: '38%', tone: 'ok' },
      { label: 'p95 latency', value: '120 ms', tone: 'ok' },
      { label: 'Sessions', value: 'broken', tone: 'danger' },
    ],
  },
  {
    id: 'stage-4',
    title: 'Stage 4 - Shared session store and cache',
    problem: 'Sessions work again, but the database is now at 85% CPU. The same product rows are read thousands of times per second.',
    question: 'Reads dominate and the data changes rarely. What do you add?',
    options: [
      {
        label: 'A cache in front of the hot read path',
        recommended: true,
        feedback:
          'Right. At a 90% hit rate the database sees a tenth of the read traffic. The cost is staleness and a new invalidation problem you must design for.',
      },
      {
        label: 'More API servers',
        feedback: 'They are not the bottleneck. More instances would simply send more queries to the same database.',
      },
      {
        label: 'Shard the database now',
        feedback:
          'Far too early. Sharding is a one-way door that complicates every query and transaction. Caching and replicas usually buy years first.',
      },
    ],
    introduced: {
      component: 'Redis (sessions + cache)',
      because: 'Local sessions broke horizontal scaling, and repeated reads were saturating the database.',
      cost: 'Cached data can be stale, invalidation becomes your problem, and Redis is now critical infrastructure needing its own HA.',
      concept: 'caching',
    },
    // Every instance reaches both the cache and the database. Drawing only some
    // of the arrows would describe instances that are not interchangeable, which
    // is the opposite of what stage 3 just established.
    nodes: [
      { id: 'client', kind: 'client', title: 'Clients', placed: box(400, 12, 180, 69) },
      { id: 'lb', kind: 'load-balancer', title: 'Load Balancer', subtitle: '2 nodes, multi-AZ', placed: box(395, 100, 190, 78) },
      { id: 'api1', kind: 'server', title: 'API 1', placed: box(215, 232, 150, 84) },
      { id: 'api2', kind: 'server', title: 'API 2', placed: box(400, 232, 150, 84) },
      { id: 'api3', kind: 'server', title: 'API 3', placed: box(585, 232, 150, 84) },
      { id: 'cache', kind: 'cache', title: 'Redis', subtitle: 'cache + sessions', placed: box(285, 392, 175, 84), isNew: true },
      { id: 'db', kind: 'sql', title: 'PostgreSQL', placed: box(500, 392, 175, 84) },
    ],
    edges: [
      { from: 'client', to: 'lb', tone: 'brand', width: 2 },
      { from: 'lb', to: 'api1', tone: 'ok' },
      { from: 'lb', to: 'api2', tone: 'ok' },
      { from: 'lb', to: 'api3', tone: 'ok' },
      { from: 'api1', to: 'cache', tone: 'danger' },
      { from: 'api2', to: 'cache', tone: 'danger' },
      { from: 'api3', to: 'cache', tone: 'danger' },
      { from: 'api1', to: 'db', tone: 'info' },
      { from: 'api2', to: 'db', tone: 'info' },
      { from: 'api3', to: 'db', tone: 'info' },
    ],
    metrics: [
      { label: 'Cache hit rate', value: '91%', tone: 'ok' },
      { label: 'DB CPU', value: '34%', tone: 'ok' },
      { label: 'p95 latency', value: '42 ms', tone: 'ok' },
      { label: 'Staleness', value: 'up to TTL', tone: 'warn' },
    ],
  },
  {
    id: 'stage-5',
    title: 'Stage 5 - Read replicas',
    problem: 'Reads that miss the cache and analytics queries are competing with writes on the primary.',
    question: 'Read volume keeps growing and some reads tolerate being a second old. What do you add?',
    options: [
      {
        label: 'Read replicas, with reads routed to them',
        recommended: true,
        feedback:
          'Right. Replicas scale reads and give you a failover target. The cost is replication lag, which means read-your-writes needs special handling.',
      },
      {
        label: 'A second independent database',
        feedback: 'Two sources of truth is a data-integrity problem, not a scaling solution.',
      },
      {
        label: 'Increase the cache TTL to infinity',
        feedback:
          'That trades correctness for hit rate. Some data genuinely must be fresh, and unbounded TTLs make invalidation bugs permanent.',
      },
    ],
    introduced: {
      component: 'Read replicas',
      because: 'Cache misses and reporting queries were consuming primary capacity needed for writes.',
      cost: 'Replication lag causes stale reads, and the application must decide per query where it is safe to read.',
      concept: 'read-replicas',
    },
    // The API tier collapses to one box here, as it does from stage 6 onward.
    // Three instances x (cache + primary + two replicas) is twelve arrows that
    // say one thing: every instance writes to the primary and reads from a
    // replica. The lesson of this stage is the data tier, so draw that clearly.
    nodes: [
      { id: 'lb', kind: 'load-balancer', title: 'Load Balancer', subtitle: '2 nodes, multi-AZ', placed: box(385, 16, 190, 78) },
      { id: 'api', kind: 'server', title: 'API x3', subtitle: 'stateless, any instance', placed: box(385, 140, 190, 84) },
      { id: 'cache', kind: 'cache', title: 'Redis', subtitle: 'cache + sessions', placed: box(90, 150, 170, 84) },
      { id: 'db', kind: 'sql', title: 'Primary DB', subtitle: 'all writes', placed: box(385, 290, 190, 84) },
      { id: 'r1', kind: 'sql', title: 'Replica 1', subtitle: 'reads', placed: box(175, 430, 175, 83), isNew: true },
      { id: 'r2', kind: 'sql', title: 'Replica 2', subtitle: 'reads', placed: box(600, 430, 175, 83), isNew: true },
    ],
    edges: [
      { from: 'lb', to: 'api', tone: 'ok', width: 2 },
      { from: 'api', to: 'cache', tone: 'danger' },
      { from: 'api', to: 'db', tone: 'info', label: 'writes' },
      { from: 'api', to: 'r1', tone: 'ok', label: 'reads', labelT: 0.62 },
      { from: 'api', to: 'r2', tone: 'ok' },
      { from: 'db', to: 'r1', tone: 'violet', dashed: true, label: 'replication' },
      { from: 'db', to: 'r2', tone: 'violet', dashed: true },
    ],
    metrics: [
      { label: 'Replicas', value: '2', tone: 'ok' },
      { label: 'Primary CPU', value: '41%', tone: 'ok' },
      { label: 'Replication lag', value: '120 ms', tone: 'warn' },
      { label: 'Read capacity', value: '3x', tone: 'ok' },
    ],
  },
  {
    id: 'stage-6',
    title: 'Stage 6 - CDN at the edge',
    problem: 'Users in Asia report a slow product page. The backend is fast; the network is not.',
    question: 'Images and static assets travel from a single region to users worldwide. What helps most?',
    options: [
      {
        label: 'Serve static content from a CDN',
        recommended: true,
        feedback:
          'Right. Distance is a hard constraint - no backend optimisation removes a 200 ms round trip. Edge caches put the bytes near the user.',
      },
      {
        label: 'Compress images harder',
        feedback: 'Helps a little, but the dominant cost is the round trip, not the payload size.',
      },
      {
        label: 'Deploy the whole stack to every region',
        feedback:
          'Enormously more complex - now you have multi-region data consistency. Try the edge cache before replicating the entire system.',
      },
    ],
    introduced: {
      component: 'CDN',
      because: 'Distant users paid full round-trip latency for every asset, and the origin carried all that bandwidth.',
      cost: 'Content can be stale until TTL or purge, cache keys must exclude user-specific data, and there is a new vendor in the request path.',
      concept: 'cdn',
    },
    nodes: [
      { id: 'client', kind: 'client', title: 'Global users', placed: box(400, 12, 180, 69) },
      { id: 'cdn', kind: 'cdn', title: 'CDN edge', placed: box(395, 108, 190, 76), isNew: true },
      { id: 'lb', kind: 'load-balancer', title: 'Load Balancer', subtitle: '2 nodes, multi-AZ', placed: box(395, 222, 190, 78) },
      { id: 'api', kind: 'server', title: 'API x3', placed: box(400, 336, 180, 76) },
      { id: 'cache', kind: 'cache', title: 'Redis', placed: box(140, 336, 160, 76) },
      { id: 'db', kind: 'sql', title: 'Primary + replicas', placed: box(390, 448, 200, 76) },
    ],
    edges: [
      { from: 'client', to: 'cdn', tone: 'brand', width: 2 },
      { from: 'cdn', to: 'lb', tone: 'violet', dashed: true, label: 'on miss' },
      { from: 'lb', to: 'api', tone: 'ok' },
      { from: 'api', to: 'cache', tone: 'danger' },
      { from: 'api', to: 'db', tone: 'info' },
    ],
    metrics: [
      { label: 'Edge hit rate', value: '93%', tone: 'ok' },
      { label: 'Asia latency', value: '28 ms', tone: 'ok' },
      { label: 'Origin traffic', value: '-80%', tone: 'ok' },
      { label: 'Staleness', value: 'purge window', tone: 'warn' },
    ],
  },
  {
    id: 'stage-7',
    title: 'Stage 7 - Queue and workers',
    problem: 'Checkout takes 3 seconds because it sends an email, generates a PDF invoice and calls an analytics API inline.',
    question: 'The user does not need any of that work to complete before seeing a confirmation. What do you do?',
    options: [
      {
        label: 'Publish the work to a queue and process it in workers',
        recommended: true,
        feedback:
          'Right. The API returns as soon as the job is enqueued, a spike becomes a longer queue instead of timeouts, and workers scale independently.',
      },
      {
        label: 'Make the third-party calls faster',
        feedback: 'You do not control their latency, and one slow dependency should never decide your checkout time.',
      },
      {
        label: 'Run the work in a background thread in the API process',
        feedback:
          'Work is lost when the process restarts, there are no retries, and a burst still consumes the same instance resources.',
      },
    ],
    introduced: {
      component: 'Message queue + workers',
      because: 'Slow, non-essential work was inside the request path and setting user-visible latency.',
      cost: 'The work is now eventually complete, consumers must be idempotent because delivery is at-least-once, and queue depth becomes a metric you must watch.',
      concept: 'message-queues',
    },
    nodes: [
      { id: 'cdn', kind: 'cdn', title: 'CDN', placed: box(400, 12, 170, 69) },
      { id: 'lb', kind: 'load-balancer', title: 'Load Balancer', subtitle: '2 nodes, multi-AZ', placed: box(395, 104, 180, 78) },
      { id: 'api', kind: 'server', title: 'API x3', placed: box(395, 220, 180, 76) },
      { id: 'cache', kind: 'cache', title: 'Redis', placed: box(120, 220, 160, 76) },
      { id: 'queue', kind: 'queue', title: 'Message Queue', placed: box(675, 220, 210, 84), isNew: true },
      { id: 'worker', kind: 'worker', title: 'Workers x4', placed: box(690, 365, 175, 80), isNew: true },
      { id: 'db', kind: 'sql', title: 'Primary + replicas', placed: box(370, 400, 200, 76) },
    ],
    edges: [
      { from: 'cdn', to: 'lb', tone: 'violet', dashed: true },
      { from: 'lb', to: 'api', tone: 'ok' },
      { from: 'api', to: 'cache', tone: 'danger' },
      { from: 'api', to: 'db', tone: 'info' },
      { from: 'api', to: 'queue', tone: 'warn', label: 'async work' },
      { from: 'queue', to: 'worker', tone: 'warn' },
      { from: 'worker', to: 'db', tone: 'info' },
    ],
    metrics: [
      { label: 'Checkout p95', value: '180 ms', tone: 'ok' },
      { label: 'Queue depth', value: '~40', tone: 'ok' },
      { label: 'Workers', value: '4' },
      { label: 'Delivery', value: 'at-least-once', tone: 'warn' },
    ],
  },
  {
    id: 'stage-8',
    title: 'Stage 8 - Services, only where justified',
    problem: 'Eight teams now share one release train. Deploys queue behind each other, and one team can block everyone.',
    question: 'What justifies splitting this system into services?',
    options: [
      {
        label: 'Independent deployability for teams that own separate capabilities',
        recommended: true,
        feedback:
          'Right - and it is an organisational argument, not a performance one. Split along bounded contexts you have already proven stable, and give each service its own data.',
      },
      {
        label: 'Microservices are the modern architecture',
        feedback:
          'Not a reason. Every network hop adds latency, failure modes and operational cost that must be paid for by a real benefit.',
      },
      {
        label: 'To make the system faster',
        feedback:
          'Services are usually slower per request - in-process calls become network calls. They buy autonomy and isolation, not speed.',
      },
    ],
    introduced: {
      component: 'Extracted services (payments, notifications)',
      because: 'Independent teams needed to deploy without coordinating a shared release.',
      cost: 'Distributed transactions become sagas, debugging needs tracing, and the platform investment (CI/CD, discovery, observability) is permanent.',
      concept: 'microservices',
    },
    nodes: [
      { id: 'cdn', kind: 'cdn', title: 'CDN', placed: box(410, 10, 160, 69) },
      { id: 'gw', kind: 'api-gateway', title: 'API Gateway', subtitle: 'redundant pair', placed: box(380, 98, 190, 78) },
      { id: 'monitor', kind: 'monitoring', title: 'Tracing', subtitle: 'every request', placed: box(700, 98, 160, 83), isNew: true },
      { id: 'orders', kind: 'service', title: 'Orders', placed: box(120, 218, 165, 80) },
      { id: 'payments', kind: 'service', title: 'Payments', placed: box(380, 218, 166, 80), isNew: true },
      { id: 'notify', kind: 'service', title: 'Notifications', placed: box(640, 218, 190, 80), isNew: true },
      { id: 'cache', kind: 'cache', title: 'Redis', placed: box(45, 380, 150, 76) },
      { id: 'ordersdb', kind: 'sql', title: 'Orders DB', placed: box(225, 380, 160, 76) },
      { id: 'paydb', kind: 'sql', title: 'Payments DB', placed: box(420, 380, 195, 76), isNew: true },
      { id: 'queue', kind: 'queue', title: 'Event bus', placed: box(650, 380, 160, 76) },
    ],
    edges: [
      { from: 'cdn', to: 'gw', tone: 'violet', dashed: true },
      { from: 'gw', to: 'orders', tone: 'ok' },
      { from: 'gw', to: 'payments', tone: 'ok' },
      // Tracing collects spans from the entry point down, so it hangs off the
      // gateway - not off the event bus, which carries business events.
      { from: 'gw', to: 'monitor', tone: 'muted', dashed: true },
      { from: 'orders', to: 'cache', tone: 'danger' },
      { from: 'orders', to: 'ordersdb', tone: 'info' },
      { from: 'payments', to: 'paydb', tone: 'info' },
      { from: 'orders', to: 'queue', tone: 'warn', label: 'events' },
      { from: 'payments', to: 'queue', tone: 'warn' },
      { from: 'queue', to: 'notify', tone: 'warn' },
    ],
    metrics: [
      { label: 'Deployable units', value: '3', tone: 'ok' },
      { label: 'Cross-service calls', value: '2 per request', tone: 'warn' },
      { label: 'Operational cost', value: 'High', tone: 'warn' },
      { label: 'Team autonomy', value: 'High', tone: 'ok' },
    ],
  },
];

export const stageLayout = (stage: Stage): Layout =>
  Object.fromEntries(stage.nodes.map((node) => [node.id, node.placed]));
