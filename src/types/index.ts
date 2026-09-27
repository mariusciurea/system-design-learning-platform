export type Difficulty = 'Beginner' | 'Intermediate' | 'Advanced';

export type CategoryId =
  | 'getting-started'
  | 'scaling'
  | 'networking'
  | 'data'
  | 'performance'
  | 'distributed'
  | 'communication'
  | 'async'
  | 'reliability'
  | 'security'
  | 'architecture'
  | 'observability'
  | 'patterns';

export interface Category {
  id: CategoryId;
  title: string;
  blurb: string;
  icon: string;
}

/** A single trade-off row: what you gain vs what it costs. */
export interface TradeOff {
  approach: string;
  gains: string[];
  costs: string[];
}

/**
 * A memorable everyday comparison. Juniors remember the picture long after they
 * forget the definition, so every concept gets exactly one.
 */
export interface Analogy {
  /** Short label for the picture, e.g. "The supermarket checkout". */
  title: string;
  /** Two to four sentences that map the picture back onto the concept. */
  body: string;
}

/** One teaching section of the long-form explanation. */
export interface DeepDiveSection {
  heading: string;
  paragraphs: string[];
  bullets?: string[];
  /** Optional fixed-width block: code, a config snippet or a small table. */
  code?: { caption?: string; body: string };
}

/** A concrete worked example with real numbers a junior can follow along with. */
export interface WorkedExample {
  title: string;
  /** The situation, in one or two sentences. */
  setup: string;
  /** Ordered steps. Each one should carry a concrete number or value. */
  walkthrough: string[];
  /** What the numbers end up saying - the point of the example. */
  result: string;
}

/** A word seniors use without explaining it, translated into plain language. */
export interface JargonTerm {
  term: string;
  plain: string;
}

export interface QuizQuestion {
  id: string;
  prompt: string;
  options: string[];
  /** index into options */
  answer: number;
  explanation: string;
}

/**
 * Educational payload for one concept page. Every field is optional except the
 * identity fields so that a concept can start as an outline and grow.
 */
export type Concept = ConceptContent & LabHosting;

interface ConceptContent {
  slug: string;
  title: string;
  /** One sentence shown under the title. */
  tagline: string;
  category: CategoryId;
  difficulty: Difficulty;
  keywords?: string[];
  what?: string;
  why?: string;
  how?: string[];
  when?: string[];
  advantages?: string[];
  tradeoffs?: TradeOff[];
  mistakes?: string[];
  realWorld?: string[];
  diagram?: string;
  related?: string[];
  quiz?: QuizQuestion[];
}

/**
 * The Lab a concept hosts, and the Lab focus it opens that Lab with. One member
 * per Lab, so `labFocus` only accepts the focus ids of the Lab named in `lab` -
 * a typo, or a focus of another Lab, fails typecheck.
 */
type LabHosting =
  | { [Id in LabId]: { /** Registered interactive lab id. */ lab: Id; labFocus?: LabFocus<Id> } }[LabId]
  | { lab?: undefined; labFocus?: undefined };

/**
 * The part of a concept that navigation, search, progress and lists need. It is
 * all the main bundle carries - the lesson body (what/why/how, trade-offs,
 * quiz...) is loaded per category when a concept page opens. Built from the
 * full catalogue at build time, see src/data/concepts/summaries.ts.
 */
export type ConceptSummary = Pick<
  Concept,
  'slug' | 'title' | 'tagline' | 'category' | 'difficulty' | 'lab' | 'keywords'
>;

/**
 * The long-form, junior-friendly half of a lesson, shown as the Lesson under
 * the Diagram. It is deliberately not part of `Concept`: it is far larger
 * than the rest of the catalogue and is loaded on demand, per category, from
 * `src/data/concepts/deep`.
 */
export interface ConceptDepth {
  analogy: Analogy;
  deepDive: DeepDiveSection[];
  examples: WorkedExample[];
  jargon: JargonTerm[];
  /** Three to five one-line takeaways worth memorising. */
  remember: string[];
}

export type LabId =
  | 'requirements'
  | 'capacity'
  | 'vertical-scaling'
  | 'horizontal-scaling'
  | 'load-balancer'
  | 'auto-scaling'
  | 'stateless'
  | 'caching'
  | 'cache-strategies'
  | 'cdn'
  | 'indexing'
  | 'replication'
  | 'sharding'
  | 'queue'
  | 'rate-limiting'
  | 'circuit-breaker'
  | 'retry-backoff'
  | 'cap-theorem'
  | 'monolith-microservices'
  | 'api-gateway'
  | 'tracing'
  | 'url-journey'
  | 'proxy'
  | 'data-models'
  | 'schema-design'
  | 'cache-layers'
  | 'consensus'
  | 'api-styles'
  | 'realtime'
  | 'event-log'
  | 'broker-routing'
  | 'redundancy'
  | 'auth'
  | 'monitoring'
  | 'slo'
  | 'transport'
  | 'partitioning'
  | 'connection-pool'
  | 'distributed-lock'
  | 'idempotency'
  | 'disaster-recovery'
  | 'oauth'
  | 'secrets'
  | 'waf'
  | 'serverless'
  | 'fan-out'
  | 'bulkhead'
  | 'saga'
  | 'outbox';

/**
 * The Lab focus ids a shared Lab accepts: the starting setups it can open with,
 * one per Concept that hosts it. A Lab missing here takes no focus. The Lab
 * itself maps every id to its setup, so an id added here without one fails
 * typecheck in the Lab.
 */
export interface LabFocusIds {
  'requirements': 'what-is-system-design' | 'functional-requirements' | 'non-functional-requirements';
  'capacity': 'capacity-estimation' | 'back-of-the-envelope';
  'url-journey': 'what-happens-when-you-type-a-url' | 'dns' | 'http-https' | 'tls-https';
  'stateless': 'stateless-applications' | 'stateful-applications' | 'jwt';
  'load-balancer': 'load-balancing' | 'health-checks';
  'cdn': 'cdn' | 'cdn-caching';
  'caching': 'caching' | 'redis';
  'replication': 'replication' | 'read-replicas' | 'strong-consistency' | 'eventual-consistency' | 'leader-follower';
  'cap-theorem': 'cap-theorem' | 'consistency' | 'partition-tolerance';
  'queue': 'message-queues' | 'background-workers' | 'task-queues' | 'backpressure' | 'producer-consumer' | 'request-response';
  'monolith-microservices': 'monolith' | 'modular-monolith' | 'microservices' | 'service-oriented-architecture';
  'retry-backoff': 'no-backoff' | 'backoff-jitter';
  'proxy': 'reverse-proxy' | 'forward-proxy';
  'data-models': 'sql-databases' | 'nosql-databases' | 'relational-vs-non-relational';
  'schema-design': 'database-normalization' | 'denormalization';
  'cache-layers': 'database-caching' | 'application-caching';
  'consensus': 'leader-election' | 'consensus';
  'api-styles': 'rest-apis' | 'graphql' | 'grpc';
  'realtime': 'websockets' | 'server-sent-events' | 'polling' | 'long-polling';
  'event-log': 'kafka' | 'cqrs' | 'event-sourcing';
  'broker-routing': 'rabbitmq-concepts' | 'event-driven-architecture' | 'pub-sub';
  'redundancy': 'availability' | 'redundancy' | 'fault-tolerance' | 'high-availability' | 'single-point-of-failure' | 'failover';
  'auth': 'authentication' | 'authorization' | 'api-keys';
  'monitoring': 'logging' | 'metrics' | 'monitoring' | 'alerting';
  'slo': 'sli' | 'slo' | 'sla';
}

/** The focus ids of one Lab, or of every Lab when no id is given. */
export type LabFocus<Id extends LabId = LabId> = Id extends keyof LabFocusIds ? LabFocusIds[Id] : never;

/** Props every Lab component takes. No focus means the Lab's own default setup. */
export interface LabProps<Id extends LabId = LabId> {
  focus?: LabFocus<Id>;
}

/** `overloaded`: the part runs but takes more load than its limit, so it turns requests away. */
/** `idle`: a part with no health to report (not asked this time, or a person). */
export type NodeStatus = 'healthy' | 'degraded' | 'down' | 'starting' | 'overloaded' | 'idle';

/** Conceptual model of an infrastructure component inside a simulation. */
export interface SystemNode {
  id: string;
  type: NodeKind;
  label: string;
  /** Requests per second this node can absorb before saturating. */
  capacity: number;
  currentLoad: number;
  status: NodeStatus;
}

export type NodeKind =
  | 'client'
  | 'dns'
  | 'cdn'
  | 'load-balancer'
  | 'api-gateway'
  | 'server'
  | 'service'
  | 'cache'
  | 'sql'
  | 'nosql'
  | 'queue'
  | 'worker'
  | 'storage'
  | 'search'
  | 'monitoring';

export type RequestOutcome = 'success' | 'cache-hit' | 'warning' | 'failure';

/** A single simulated request travelling through the architecture. */
export interface SimulatedRequest {
  id: number;
  createdAt: number;
  currentNode: string;
  status: 'active' | 'completed' | 'failed';
  outcome: RequestOutcome;
  latency: number;
  path: string[];
  method?: string;
  endpoint?: string;
  notes?: string[];
}
