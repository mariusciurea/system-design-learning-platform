/**
 * The Requirements Lab picture as data: which parts a setup forces, how big they are, the routes
 * its traffic takes, the wires those routes draw, the legend for them and the forced decisions.
 * The component only lays it out and animates it.
 *
 * Pure: no React and only relative imports, so `npm test` runs it.
 */
import type { DiagramEdge, EdgeTone } from '../../components/architecture/DiagramCanvas.tsx';
import type { LabFocus, NodeKind, RequestOutcome } from '../../types/index.ts';
import { formatCompact, formatNumber } from '../../utils/format.ts';
import { PRIMARY_WRITE_LIMIT } from './capacityModel.ts';
import {
  AVAILABILITY_COPIES,
  CACHE_HIT,
  DAU,
  READS_PER_COPY,
  scaleImplications,
  sizeRequirements,
  type Product,
  type Sizing,
  type TierSize,
} from './requirementsSizing.ts';

/**
 * The kinds of traffic a requirement creates. Each one needs certain parts, and
 * the diagram is built from the union of them - so a part appears only when some
 * requirement sends traffic through it.
 */
export type FlowKind =
  | 'write' // a user action stored in the database
  | 'read' // a user reads stored data
  | 'push' // the server pushes to a phone over a held-open connection
  | 'fan-out' // workers deliver one message to every member of a group, over their connections
  | 'upload' // a file goes through the app server into object storage
  | 'process' // a queued job turns the stored file into thumbnails or other sizes
  | 'job' // slow work done later by background workers
  | 'index-sync' // workers keep a search index in step with the database
  | 'index-write' // the app writes straight into an in-memory index
  | 'index-read' // the app queries that index
  | 'call' // voice and video relayed by media servers
  | 'media' // images, video or static files served by the CDN
  | 'receipt' // a phone sends a receipt up its connection; it is stored and pushed back to the sender
  | 'expire' // a scheduled job deletes files whose time is up
  | 'batch-match'; // workers match requests collected over a few seconds against the geo index

export type PartId =
  | 'users'
  | 'cdn'
  | 'lb'
  | 'media'
  | 'objects'
  | 'api'
  | 'ws'
  | 'db'
  | 'async'
  | 'index'
  | 'cache'
  | 'region2';

const FLOW_PARTS: Record<FlowKind, PartId[]> = {
  write: ['api', 'db'],
  read: ['api', 'db'],
  push: ['api', 'ws'],
  'fan-out': ['api', 'async', 'ws'],
  upload: ['api', 'objects'],
  process: ['api', 'async', 'objects'],
  job: ['api', 'async', 'db'],
  'index-sync': ['api', 'async', 'index'],
  'index-write': ['api', 'index'],
  'index-read': ['api', 'index'],
  call: ['media'],
  media: ['cdn', 'objects'],
  receipt: ['api', 'ws', 'db'],
  expire: ['async', 'objects'],
  'batch-match': ['api', 'async', 'index'],
};

/** Flows that store something in the database - the only traffic copied to region 2. */
export const WRITE_FLOWS: ReadonlySet<FlowKind> = new Set<FlowKind>(['write', 'job', 'receipt']);

/**
 * What a requirement writes on a part that its flows alone would not show: a status line or a stat
 * row. `with` names another requirement that must be picked too (a fan-out to followers needs a feed).
 */
export interface Mark {
  part: PartId;
  status?: string;
  stat?: { label: string; value: string };
  with?: string;
}

export interface RequirementOption {
  id: string;
  label: string;
  /** How the part subtitles name this requirement. */
  short: string;
  core: boolean;
  /** What ticking this requirement draws: the parts, wires and lines it adds. */
  implication: string;
  flows: FlowKind[];
  marks?: Mark[];
}

export const REQUIREMENTS: Record<Product, RequirementOption[]> = {
  whatsapp: [
    { id: 'send', label: 'Send messages', short: 'send', core: true, implication: 'An App server that stores each message in a Database', flows: ['write', 'read'] },
    { id: 'receive', label: 'Receive messages in real time', short: 'live delivery', core: true, implication: 'A WebSocket server that holds a connection open to every phone and pushes new messages down it', flows: ['push', 'read'] },
    { id: 'groups', label: 'Group conversations', short: 'group fan-out', core: true, implication: 'Queue + workers that copy a group message to every member, through the WebSocket server', flows: ['fan-out'] },
    {
      id: 'receipts',
      label: 'Delivery and read receipts',
      short: 'receipts',
      core: true,
      implication: 'Each receipt comes up the WebSocket, is stored, and is pushed back to the sender: 3 pushes per message',
      flows: ['receipt'],
      marks: [{ part: 'ws', status: '3 pushes per message' }],
    },
    { id: 'images', label: 'Send images', short: 'images', core: false, implication: 'Object storage for the files, workers that resize them and a CDN that serves them', flows: ['upload', 'process', 'media'] },
    { id: 'calls', label: 'Voice and video calls', short: 'calls', core: false, implication: 'Media servers that relay voice and video beside the chat path - a different system', flows: ['call', 'push'] },
    {
      id: 'stories',
      label: 'Stories',
      short: 'stories',
      core: false,
      implication: 'Object storage keeps each story 24 hours, a scheduled job deletes it, and viewers load it from the CDN',
      flows: ['upload', 'media', 'expire'],
      marks: [{ part: 'objects', stat: { label: 'Stories kept', value: '24 h' } }],
    },
  ],
  instagram: [
    { id: 'upload', label: 'Upload a photo', short: 'upload', core: true, implication: 'Object storage for the file, and workers that make the thumbnails', flows: ['upload', 'process', 'write'] },
    { id: 'feed', label: 'View a home feed', short: 'home feed', core: true, implication: 'Workers precompute each home feed into the Database, so a read is one lookup, not a join', flows: ['read', 'job'] },
    {
      id: 'follow',
      label: 'Follow accounts',
      short: 'follows',
      core: true,
      implication: 'A follow graph in the Database; with a home feed, workers copy each post to every follower',
      flows: ['write', 'read'],
      marks: [{ part: 'async', stat: { label: 'Fan-out', value: '1 per follower' }, with: 'feed' }],
    },
    {
      id: 'like',
      label: 'Like and comment',
      short: 'likes',
      core: true,
      implication: 'Likes wait in the queue, and workers add them to the counters in batches',
      flows: ['job'],
      marks: [{ part: 'async', status: 'Counts likes in batches' }],
    },
    { id: 'search', label: 'Search users and tags', short: 'search', core: false, implication: 'A Search index, kept in step with the Database by workers', flows: ['index-sync', 'index-read'] },
    { id: 'dm', label: 'Direct messages', short: 'DMs', core: false, implication: 'A WebSocket server to push messages - a chat system, see the WhatsApp design', flows: ['write', 'push'] },
    { id: 'reels', label: 'Short video', short: 'video', core: false, implication: 'Object storage, transcoding workers and a CDN to stream the video', flows: ['upload', 'process', 'media'] },
  ],
  uber: [
    { id: 'location', label: 'Drivers publish location', short: 'locations', core: true, implication: 'Every online driver sends a location every 4 seconds, into an in-memory Geo index', flows: ['index-write'] },
    { id: 'request', label: 'Request a ride', short: 'ride requests', core: true, implication: 'The trip and its state live in the Database', flows: ['write', 'read'] },
    {
      id: 'match',
      label: 'Match rider to driver',
      short: 'matching',
      core: true,
      implication: 'A proximity search in the Geo index, over the cells near the rider',
      flows: ['index-read'],
      marks: [{ part: 'index', status: 'Searched by nearby cells' }],
    },
    { id: 'track', label: 'Track the trip live', short: 'live tracking', core: true, implication: 'A WebSocket server that streams the driver position to the rider app', flows: ['push'] },
    { id: 'pay', label: 'Automatic payment', short: 'payments', core: true, implication: 'Workers charge the card after the trip - once, even when a retry runs twice', flows: ['job', 'write'] },
    { id: 'pool', label: 'Ride pooling', short: 'pooling', core: false, implication: 'Workers collect pool requests for a few seconds and match them together against the Geo index', flows: ['batch-match'] },
    {
      id: 'schedule',
      label: 'Scheduled rides',
      short: 'scheduling',
      core: false,
      implication: 'The booking is stored, and the queue holds the ride until its pickup time',
      flows: ['job', 'write'],
      marks: [{ part: 'async', status: 'Holds rides until pickup' }],
    },
  ],
};

// ---------------------------------------------------------------------------
// Quality targets
// ---------------------------------------------------------------------------

export type NfrId = 'availability' | 'latency' | 'users' | 'consistency' | 'durability';
export type Nfr = Record<NfrId, number>;

/**
 * Something a forced-decision line talks about. A line is shown only while it is on the diagram,
 * so no line names a part that is not drawn.
 * - `reads`: a picked feature reads from the database;
 * - `copies`: the database has a second copy - a standby or read replicas in region 1, or region 2 -
 *   so the database status line names where reads go;
 * - `one-copy`: it has exactly one, and no region 2 - so every read already sees the latest write;
 * - `sync-standby`: a write waits for the standby (Critical durability, or Strong with copies);
 * - `db-region2`: a database, copied to region 2 (two regions can take conflicting writes);
 * - `sync-region2`: a write waits for region 2 (Strong with region 2).
 */
type Needs =
  | 'db'
  | 'reads'
  | 'cache'
  | 'replicas'
  | 'copies'
  | 'one-copy'
  | 'db-region2'
  | 'async-region2'
  | 'sync-standby'
  | 'sync-region2';

type Implication = string | { text: string; needs: Needs };

export interface NfrSpec {
  id: NfrId;
  label: string;
  values: string[];
  /**
   * Implications per index. Levels 1+ accumulate; level 0 is the relaxed
   * baseline and is dropped as soon as the target is raised.
   */
  implications: Implication[][];
  /** The levels of this target are alternatives, not steps: only the lines of the chosen one show. */
  alternatives?: boolean;
}

/** The one line every consistency level shows while there is nothing to be inconsistent with. */
const ONE_COPY: Implication = { text: 'One database copy: every read already sees the latest write', needs: 'one-copy' };

export const NFRS: NfrSpec[] = [
  {
    id: 'availability',
    label: 'Availability',
    values: ['99%', '99.9%', '99.99%', '99.999%'],
    implications: [
      ['One copy of each server, recovered by hand when it fails'],
      ['Redundant instances behind a load balancer pair', 'The load balancer health-checks each server and skips a dead one'],
      ['Three zones, with a copy of each server tier in every zone', { text: 'A standby database copy, promoted automatically', needs: 'db' }],
      ['Region 2: a full copy of region 1 that takes all traffic if region 1 fails', 'DNS sends each user to the nearest region'],
    ],
  },
  {
    id: 'latency',
    label: 'P95 latency',
    // No 200 ms step: at these loads it is met by the same App server and Database as 500 ms,
    // so it drew nothing.
    values: ['500 ms', '100 ms', '20 ms'],
    // No CDN line: the CDN is drawn by the features that send files, at every latency level, so
    // naming it here would credit this target with a part it does not add.
    implications: [
      [{ text: 'Each read is one query to the database', needs: 'reads' }],
      [{ text: 'Caching layer for hot reads', needs: 'cache' }],
      [{ text: 'Hot data held in memory: the cache answers 99% of reads (model)', needs: 'cache' }],
    ],
  },
  {
    id: 'users',
    label: 'Daily active users',
    values: ['1k', '100k', '10M', '100M'],
    // Read from the sizing instead (`scaleImplications`): what a user count forces depends on the
    // traffic of the product, so fixed lines would name replicas the diagram does not draw.
    implications: [],
  },
  {
    id: 'consistency',
    label: 'Consistency',
    values: ['Eventual', 'Read-your-writes', 'Strong'],
    alternatives: true,
    implications: [
      [
        ONE_COPY,
        { text: 'Reads may come from any database copy, even one a moment behind', needs: 'copies' },
        { text: 'Writes reach region 2 a moment later (the dashed wire)', needs: 'async-region2' },
        { text: 'Conflict resolution between regions must be designed', needs: 'db-region2' },
      ],
      [
        ONE_COPY,
        { text: 'A user reads from the primary right after their own write', needs: 'copies' },
        { text: 'Writes reach region 2 a moment later (the dashed wire)', needs: 'async-region2' },
      ],
      [
        ONE_COPY,
        { text: 'Reads come from the primary only', needs: 'copies' },
        { text: 'Each write waits for the standby copy: slower writes', needs: 'sync-standby' },
        { text: 'Each write waits for region 2: a cross-region round trip (the amber wire)', needs: 'sync-region2' },
      ],
    ],
  },
  {
    id: 'durability',
    label: 'Durability',
    // No "Best effort" step: none of these products may lose a stored message, trip or photo, and
    // the Database drawn is the same either way.
    values: ['Normal', 'Critical'],
    implications: [
      [{ text: 'Replicated disks and daily backups inside the database service', needs: 'db' }],
      [{ text: 'A synchronous standby in a second zone: a write is confirmed once both copies have it', needs: 'db' }],
    ],
  },
];

export const valueOf = (id: NfrId, level: number) => NFRS.find((spec) => spec.id === id)?.values[level] ?? '';

// ---------------------------------------------------------------------------
// Setups and Lab focuses
// ---------------------------------------------------------------------------

/**
 * Which part of the controls is open: the feature checklist, the quality targets, or - on the
 * What is System Design focus only - the find-the-bottleneck loop.
 */
export type Panel = 'features' | 'targets' | 'load';

/**
 * A fix the find-the-bottleneck loop can pick (requirementsBottleneck.ts names and prices them):
 * - `scale-out`: a pool of app servers behind a load balancer, sized for the peak with headroom;
 * - `autoscale`: the same pool, running only the servers the peak needs;
 * - `bigger-app` / `bigger-db`: the largest machine, BIGGER_MACHINE times a standard one;
 * - `cache`: a cache in front of the database for the reads;
 * - `replicas`: read replicas, as many as the reads need;
 * - `partition`: the writes split across partitions, as many as the writes need.
 */
export type FixId = 'scale-out' | 'autoscale' | 'bigger-app' | 'cache' | 'replicas' | 'bigger-db' | 'partition';

/** The find-the-bottleneck loop: the users step reached and the fixes picked, in order. */
export interface Loop {
  /** Index into LOOP_DAU. */
  users: number;
  fixes: FixId[];
}

/**
 * Daily users at each round of the loop on Instagram: the start, then three raises. Chosen with the
 * sizing model so that each raise passes one new limit: one app server (1,000 req/s) near 580k
 * users, one database copy (10,000 reads/s) near 6.1M, one primary (10,000 writes/s) near 115M.
 */
export const LOOP_DAU = [100_000, 1_000_000, 10_000_000, 200_000_000];
export const LOOP_USERS = ['100k', '1M', '10M', '200M'];

/** The largest machine: this many times the capacity of a standard one. Simplified. */
export const BIGGER_MACHINE = 8;
/**
 * What the largest machine costs, in standard ones: more than its capacity, because the top sizes
 * carry a premium per unit of work. Illustrative.
 */
export const BIGGER_MACHINE_PRICE = 12;

export interface Setup {
  product: Product;
  selected: Record<string, boolean>;
  nfr: Nfr;
  panel: Panel;
  /**
   * Draw the parts only unpicked features would need, greyed out as not built, with dashed wires
   * no request travels - so the diagram shows what saying no to a feature left out.
   */
  showNotBuilt?: boolean;
  /**
   * The find-the-bottleneck loop. With it, the users come from LOOP_DAU and only what the picked
   * fixes built is drawn, so a part can be over its limit; without it, every tier is sized for the load.
   */
  loop?: Loop;
}

export const coreOf = (product: Product) =>
  Object.fromEntries(REQUIREMENTS[product].filter((item) => item.core).map((item) => [item.id, true]));

/** The daily users a setup designs for. */
export const dauOf = (setup: Setup) => (setup.loop ? LOOP_DAU[setup.loop.users] : DAU[setup.nfr.users]);

/** The same, as the slider or the loop labels it: "10M". */
export const usersLabelOf = (setup: Setup) => (setup.loop ? LOOP_USERS[setup.loop.users] : valueOf('users', setup.nfr.users));

/** Every target at its lowest. Durability starts at Normal: a message store is durable from the start. */
export const RELAXED: Nfr = { availability: 0, latency: 0, users: 0, consistency: 0, durability: 0 };

/** What the lab opens on at /labs/requirements: the core features at everyday targets. */
export const DEFAULT_SETUP: Setup = {
  product: 'whatsapp',
  selected: coreOf('whatsapp'),
  nfr: { availability: 1, latency: 0, users: 1, consistency: 0, durability: 0 },
  panel: 'features',
};

/**
 * The Lab focus of each Concept that hosts this lab.
 * - What is System Design? opens the find-the-bottleneck loop on Instagram: its core features at
 *   the relaxed targets and 100k daily users, one copy of each part and nothing over its limit.
 *   Raising the users turns one part red at a time, and the fixes picked live in `loop`, so Reset
 *   clears them. Instagram is its Example product: its read-heavy feed passes the limits in turn.
 *   Its controls are only the users and the fixes: the loop is tuned to that product and targets.
 * - Functional Requirements opens on the WhatsApp core features at relaxed targets, so every part
 *   drawn names a picked feature as its reason, and the parts of the unpicked features stand
 *   greyed out as not built. Only this focus shows them: scope - what saying no leaves out - is
 *   its lesson, while on the others they would crowd the loop or the targets.
 * - Non-Functional Requirements opens on the Uber core features, on the quality sliders at their
 *   relaxed baseline, so every raised target adds parts. Uber is its Example product: "99.99% for
 *   ride requests" is a real, hard target, and raising availability to it is its Diagram.
 */
export const FOCUS_SETUPS: Record<LabFocus<'requirements'>, Setup> = {
  'what-is-system-design': {
    ...DEFAULT_SETUP,
    product: 'instagram',
    selected: coreOf('instagram'),
    nfr: RELAXED,
    panel: 'load',
    loop: { users: 0, fixes: [] },
  },
  'functional-requirements': { ...DEFAULT_SETUP, nfr: RELAXED, showNotBuilt: true },
  'non-functional-requirements': { ...DEFAULT_SETUP, product: 'uber', selected: coreOf('uber'), nfr: RELAXED, panel: 'targets' },
};

/**
 * Another product, with its core features. The targets, and whether not-built parts are drawn,
 * stay as they are.
 */
export function switchProduct(setup: Setup, product: Product): Setup {
  return { ...setup, product, selected: coreOf(product) };
}

// ---------------------------------------------------------------------------
// The architecture a setup forces
// ---------------------------------------------------------------------------

/** Share of files the CDN serves from its edge. Illustrative. */
export const CDN_HIT = 0.85;
/**
 * Share of reads the cache answers at a 20 ms target: a database round trip no longer fits the
 * budget of most reads, so the whole hot set is kept in memory. Illustrative.
 */
export const HOT_SET_HIT = 0.99;

export interface PartView {
  id: PartId;
  kind: NodeKind;
  title: string;
  reasons: string[];
  stat?: { label: string; value: string; tone?: string };
  /** Replaces the status line, e.g. the database decision. */
  status?: string;
}

export interface Architecture {
  parts: Partial<Record<PartId, PartView>>;
  /** Traffic classes, one entry per requirement that creates them (a multiset). */
  flows: FlowKind[];
  /**
   * With `showNotBuilt`: the parts only unpicked features need, each naming those features as its
   * reasons. Never billed, never a single point, and no request travels to them.
   */
  notBuilt: Partial<Record<PartId, PartView>>;
  /** The traffic the unpicked features would send - drawn as dashed wires only, never animated. */
  notBuiltFlows: FlowKind[];
  region2: boolean;
  /**
   * Availability zones region 1 runs in: one; two when Critical durability puts a synchronous
   * standby in a second zone; three from 99.99% up.
   */
  zones: 1 | 2 | 3;
  sizing: Sizing;
  /** Share of reads the cache answers (0 without a cache). */
  cacheHit: number;
  /** Database copies per partition: the primary, a standby and read replicas. */
  dbCopies: number;
  /**
   * Parts running on a bigger machine than the standard one, as a multiple of it (the loop fixes
   * `bigger-app` and `bigger-db`). A part not listed runs on the standard machine.
   */
  machineSize: Partial<Record<PartId, number>>;
  /**
   * Copies of each part the load does not size - the cache, queue + workers, the index and the
   * media servers: one, or one per zone from 99.99% up.
   */
  zoneCopies: number;
  /** A write waits for the standby before it is confirmed. */
  syncStandby: boolean;
  syncToRegion2: boolean;
  /**
   * Every drawn part with one copy of its slice (`copiesOf`), in PART_ORDER, named as drawn ("geo
   * index"): when it fails, the traffic through it stops until it is replaced. A partitioned
   * database with one copy per partition is one entry, "each database partition": losing one loses
   * that slice of the data. SINGLE_POINT_EXEMPT parts are not counted.
   */
  singlePoints: string[];
}

/** A part the diagram draws as instances: everything but the users and the region 2 band. */
export type InstancedPart = Exclude<PartId, 'users' | 'region2'>;

/**
 * Parts never counted as a single point, although drawn as one box: object storage and the CDN are
 * managed services billed by use, and the provider already keeps each file in several zones (object
 * storage) or at many edge locations (the CDN). The load balancer is not here: it is always a pair.
 */
export const SINGLE_POINT_EXEMPT: ReadonlySet<PartId> = new Set<PartId>(['objects', 'cdn']);

/** How many instances of a part the diagram draws, zone copies included - what the bill counts. */
export function instancesOf(id: InstancedPart, arch: Architecture): number {
  switch (id) {
    case 'api':
      return arch.sizing.app.count;
    case 'ws':
      return arch.sizing.ws.count;
    case 'db':
      return arch.dbCopies * arch.sizing.database.partitions;
    case 'lb':
      // "Load balancer x2": anything that fronts the whole system runs as a pair.
      return 2;
    case 'cache':
    case 'async':
    case 'index':
    case 'media':
      return arch.zoneCopies;
    case 'objects':
    case 'cdn':
      return 1;
  }
}

/**
 * How many copies hold the same slice of a part, so a failure of one is survived only when this is
 * above 1 - what Single points counts. The same as `instancesOf`, except for a partitioned database:
 * partitions split the data rather than copy it, so each partition has only its own copies.
 */
export function copiesOf(id: InstancedPart, arch: Architecture): number {
  return id === 'db' ? arch.dbCopies : instancesOf(id, arch);
}

/** The hint on the Single points metric: which parts are one copy, or that none is. */
export function singlePointsHint(arch: Architecture): string {
  const list =
    arch.singlePoints.length > 0
      ? `Parts drawn as one copy, so one failure stops the traffic through them: ${arch.singlePoints.join(', ')}.`
      : 'Parts drawn as one copy, so one failure stops the traffic through them. None here: every part drawn has a second copy.';
  return `${list} Not counted: object storage and the CDN, managed services the provider already spreads over several zones.`;
}

const PART_KIND: Record<PartId, NodeKind> = {
  users: 'client',
  cdn: 'cdn',
  lb: 'load-balancer',
  media: 'server',
  objects: 'storage',
  api: 'server',
  ws: 'service',
  db: 'sql',
  async: 'queue',
  index: 'search',
  cache: 'cache',
  region2: 'server',
};

const PART_TITLE: Record<PartId, string> = {
  users: 'Users',
  cdn: 'CDN',
  lb: 'Load balancer',
  media: 'Media servers',
  objects: 'Object storage',
  api: 'App server',
  ws: 'WebSocket server',
  db: 'Database',
  async: 'Queue + workers',
  index: 'Search index',
  cache: 'Cache',
  region2: 'Region 2',
};

/** The parts in the order they are laid out and logged. */
export const PART_ORDER: PartId[] = ['region2', 'users', 'cdn', 'lb', 'media', 'objects', 'api', 'ws', 'db', 'async', 'index', 'cache'];

/** The parts copied into every zone from 99.99% up, rather than sized by the load. */
const ZONE_COPIED: InstancedPart[] = ['media', 'async', 'index', 'cache'];

export const chosenOf = (setup: Setup) => REQUIREMENTS[setup.product].filter((option) => setup.selected[option.id]);

/** A part as first drawn, before sizing: the Uber index is a geo index, the others search. */
function newPart(id: PartId, product: Product): PartView {
  if (id === 'index' && product === 'uber') return { id, kind: 'nosql', title: 'Geo index', reasons: [] };
  return { id, kind: PART_KIND[id], title: PART_TITLE[id], reasons: [] };
}

function addReason(parts: Partial<Record<PartId, PartView>>, id: PartId, reason: string, product: Product) {
  const part = parts[id] ?? (parts[id] = newPart(id, product));
  if (!part.reasons.includes(reason)) part.reasons.push(reason);
}

/** The parts and traffic of the unpicked features that no picked one already builds. */
function notBuiltOf(setup: Setup, built: Partial<Record<PartId, PartView>>) {
  const parts: Partial<Record<PartId, PartView>> = {};
  const flows: FlowKind[] = [];
  for (const option of REQUIREMENTS[setup.product].filter((item) => !setup.selected[item.id])) {
    for (const flow of option.flows) {
      flows.push(flow);
      for (const id of FLOW_PARTS[flow]) if (!built[id]) addReason(parts, id, option.short, setup.product);
    }
  }
  return { notBuilt: parts, notBuiltFlows: flows };
}

/**
 * The loop design as built: only the fixes picked, so the load can outgrow it. The demand (peak
 * requests, reads and writes) stays as sized; the tiers become what the fixes built:
 * - one app server (or the copies the availability target asks for) until a pool is picked; the
 *   pool is sized for the peak with headroom, the autoscaling one for the peak alone;
 * - one database copy until read replicas are picked, then as many as the reads need;
 * - one primary until the writes are partitioned, then as many partitions as the writes need.
 */
function builtFor(demand: Sizing, loop: Loop, availability: number) {
  const has = (fix: FixId) => loop.fixes.includes(fix);
  const machineSize: Partial<Record<PartId, number>> = {};
  if (has('bigger-app')) machineSize.api = BIGGER_MACHINE;
  if (has('bigger-db')) machineSize.db = BIGGER_MACHINE;
  const dbSize = machineSize.db ?? 1;

  const copies = AVAILABILITY_COPIES[availability] ?? 1;
  const tierOf = (forLoad: number): TierSize => ({
    atPeak: demand.app.atPeak,
    forLoad,
    forAvailability: copies,
    count: Math.max(forLoad, copies),
    setBy: copies > forLoad ? 'availability' : 'load',
  });
  const app = has('scale-out') ? demand.app : tierOf(has('autoscale') ? demand.app.atPeak : 1);

  const { peakReadQps, peakWriteQps } = demand.database;
  const partitions = has('partition') ? Math.max(1, Math.ceil(peakWriteQps / (PRIMARY_WRITE_LIMIT * dbSize))) : 1;
  const readsPerPartition = (peakReadQps * (demand.cached ? 1 - CACHE_HIT : 1)) / partitions;
  const readReplicas = has('replicas') ? Math.max(0, Math.ceil(readsPerPartition / (READS_PER_COPY * dbSize)) - 1) : 0;

  const database = { ...demand.database, partitions, partitioned: partitions > 1, readReplicas };
  const sizing: Sizing = { ...demand, app, database };
  return { sizing, machineSize };
}

export function architecture(setup: Setup): Architecture {
  const { product, nfr, loop } = setup;
  const chosen = chosenOf(setup);
  const parts: Partial<Record<PartId, PartView>> = {};
  const flows: FlowKind[] = [];
  const add = (id: PartId, reason: string) => addReason(parts, id, reason, product);

  const sizeFor = (cache: boolean) =>
    sizeRequirements({
      product,
      dau: dauOf(setup),
      availability: nfr.availability,
      locationWrites: chosen.some((option) => option.flows.includes('index-write')),
      cache,
    });
  add('users', `${usersLabelOf(setup)} daily users`);

  if (chosen.length === 0) {
    const zones = nfr.availability >= 2 ? 3 : 1;
    const sizing = sizeFor(false);
    usersStat(parts, sizing);
    // With nothing picked there is nothing to leave out: the diagram says so in words instead.
    return {
      parts,
      flows,
      notBuilt: {},
      notBuiltFlows: [],
      region2: false,
      zones,
      sizing,
      cacheHit: 0,
      dbCopies: 0,
      machineSize: {},
      zoneCopies: 1,
      syncStandby: false,
      syncToRegion2: false,
      singlePoints: [],
    };
  }

  for (const option of chosen) {
    for (const flow of option.flows) {
      flows.push(flow);
      for (const id of FLOW_PARTS[flow]) add(id, option.short);
    }
  }

  const availability = valueOf('availability', nfr.availability);
  const users = `${usersLabelOf(setup)} users`;
  const latency = `p95 ${valueOf('latency', nfr.latency)}`;

  // In the loop there is a cache only once it is picked as a fix.
  const cached = flows.includes('read') && (loop ? loop.fixes.includes('cache') : nfr.latency >= 1 || nfr.users >= 2);
  // Read replicas stay sized for the everyday hit rate even at 20 ms: after a restart the cache is
  // cold, and the database must still carry the reads it misses.
  const { sizing, machineSize } = loop
    ? builtFor(sizeFor(cached), loop, nfr.availability)
    : { sizing: sizeFor(cached), machineSize: {} };
  const cacheHit = cached ? (nfr.latency >= 2 ? HOT_SET_HIT : CACHE_HIT) : 0;
  const { app, ws, database } = sizing;
  usersStat(parts, sizing);

  // Quality targets. Every requirement goes through the app servers, so they exist here.
  // A load balancer fronts more than one server: for the availability target or for the load.
  if (nfr.availability >= 1) add('lb', availability);
  if (app.forLoad > 1) add('lb', users);

  const region2 = nfr.availability >= 3 || nfr.users >= 3;
  if (nfr.availability >= 3) add('region2', availability);
  if (nfr.users >= 3) add('region2', users);

  // The latency target does not name the CDN as a reason: the features that send files draw it at
  // every latency level, so the target neither adds nor changes it.
  if (nfr.users >= 2) {
    // Anything slow (emails, notifications, exports) leaves the request path.
    flows.push('job');
    for (const id of FLOW_PARTS.job) add(id, users);
  }
  if (cached) {
    if (nfr.latency >= 1) add('cache', latency);
    if (nfr.users >= 2 || loop) add('cache', users);
  }

  // App tier size: the Capacity Lab count for the load, or the copies the availability target asks
  // for when that is more. Each region is a full copy, sized to take all traffic if the other fails.
  if (nfr.availability >= 1) add('api', availability);
  if (parts.api) {
    parts.api.title = app.count > 1 ? `App servers x${app.count}` : 'App server';
    parts.api.stat = tierStat(app, availability, { label: 'Peak load', value: `${about(sizing.peakQps)} req/s` });
    if (machineSize.api) parts.api.status = `Largest machine: ${machineSize.api}x`;
    else if (loop?.fixes.includes('autoscale')) parts.api.status = 'Autoscales with the load';
  }
  // The WebSocket tier holds connections open, so it is sized by how many, not by requests.
  if (parts.ws) {
    parts.ws.title = ws.count > 1 ? `WebSocket x${ws.count}` : 'WebSocket server';
    parts.ws.stat = tierStat(ws, availability, { label: 'Open connections', value: about(ws.connections) });
  }

  let dbCopies = 0;
  let syncStandby = false;
  const syncToRegion2 = region2 && Boolean(parts.db) && nfr.consistency >= 2;
  if (parts.db) {
    const db = parts.db;
    // A standby for automated failover (99.99%), or a synchronous one in a second zone (critical durability).
    const standby = nfr.availability >= 2 || nfr.durability >= 1 ? 1 : 0;
    const { readReplicas, partitioned, partitions } = database;
    dbCopies = 1 + standby + readReplicas;
    // A write waits for the standby when losing it is not allowed (critical durability), or when a
    // promoted standby must not miss a confirmed write (strong consistency).
    syncStandby = standby > 0 && (nfr.durability >= 1 || nfr.consistency >= 2);
    if (nfr.availability >= 2) add('db', `${availability} failover`);
    if (nfr.durability >= 1) add('db', `${valueOf('durability', nfr.durability).toLowerCase()} durability`);
    if (readReplicas > 0 || partitioned) add('db', users);
    db.title = partitioned ? `DB: ${partitions} partitions x${dbCopies}` : dbCopies > 1 ? `Database x${dbCopies}` : 'Database';
    db.stat = {
      label: syncStandby || syncToRegion2 ? 'Peak sync writes' : 'Peak writes',
      value: `${about(database.peakWriteQps)}/s`,
      tone: partitioned ? 'text-warn' : 'text-ink',
    };
    // With a second copy - in region 1 or in region 2 - where reads go is the consistency choice, the
    // same test that turns the consistency slider on; with one copy, the Capacity Lab decision.
    db.status =
      dbCopies > 1 || region2
        ? ['Reads: any copy', 'Reads: own writes on primary', 'Reads: primary only'][nfr.consistency]
        : partitioned
          ? 'Partition the writes'
          : machineSize.db
            ? `Largest machine: ${machineSize.db}x`
            : 'One primary is enough';
  }
  if (parts.index) {
    // Drivers publishing locations: the write rate that sets Uber apart.
    if (sizing.index.peakWriteQps > 0) {
      parts.index.stat = { label: 'Peak writes', value: `${about(sizing.index.peakWriteQps)}/s`, tone: 'text-warn' };
    }
  }
  if (parts.cache) parts.cache.stat = { label: 'Hit rate', value: `${Math.round(cacheHit * 100)}% (model)`, tone: 'text-ok' };
  if (parts.cdn) parts.cdn.stat = { label: 'Edge hits', value: `${CDN_HIT * 100}% (model)`, tone: 'text-ok' };
  // Anything that fronts the whole system runs as a pair.
  if (parts.lb) parts.lb.title = 'Load balancer x2';

  // Three zones from 99.99%; below that, a synchronous standby still lives in a second zone.
  const zones = nfr.availability >= 2 ? 3 : syncStandby ? 2 : 1;
  // The parts the load does not size run one copy in each zone from 99.99%: a zone outage must not
  // take the only cache, queue, index or media relay with it. Below that they stay one box each, and
  // Single points says so - the 99.9% step copies only the servers behind the load balancer.
  const zoneCopies = nfr.availability >= 2 ? zones : 1;
  if (zoneCopies > 1) {
    for (const id of ZONE_COPIED) {
      const part = parts[id];
      if (!part) continue;
      add(id, availability);
      part.title = `${part.title} x${zoneCopies}`;
    }
  }

  // What a requirement adds to a part its flows already drew: a status line or a stat row.
  for (const option of chosen) {
    for (const mark of option.marks ?? []) {
      const part = parts[mark.part];
      if (!part || (mark.with && !setup.selected[mark.with])) continue;
      if (mark.status) part.status = mark.status;
      if (mark.stat) part.stat = mark.stat;
    }
  }

  const { notBuilt, notBuiltFlows } = setup.showNotBuilt ? notBuiltOf(setup, parts) : { notBuilt: {}, notBuiltFlows: [] };

  const arch: Architecture = {
    parts,
    flows,
    notBuilt,
    notBuiltFlows,
    region2,
    zones,
    sizing,
    cacheHit,
    dbCopies,
    machineSize,
    zoneCopies,
    syncStandby,
    syncToRegion2,
    singlePoints: [],
  };
  for (const id of PART_ORDER) {
    const part = parts[id];
    if (!part || id === 'users' || id === 'region2' || SINGLE_POINT_EXEMPT.has(id)) continue;
    if (copiesOf(id, arch) > 1) continue;
    if (id === 'db' && database.partitioned) arch.singlePoints.push('each database partition');
    else arch.singlePoints.push(id === 'ws' ? part.title : part.title.toLowerCase());
  }
  return arch;
}

/** A model number on a stat row: "~12", "~11.6K", or "<1" rather than "~0" for a trickle. */
const about = (value: number) => (value < 1 ? '<1' : `~${formatCompact(value)}`);

/**
 * The Users part carries the peak requests the daily users send, so every step of the users target
 * changes a number on the diagram - even while one server still carries the load and the tier stat
 * shows the copies the availability target asked for rather than the load.
 */
function usersStat(parts: Partial<Record<PartId, PartView>>, sizing: Sizing) {
  if (parts.users) parts.users.stat = { label: 'Peak', value: `${about(sizing.peakQps)} req/s` };
}

/**
 * The stat row of a sized tier: its load, or - when the availability target asked for more copies
 * than the load needs - how many are for the load and how many for availability.
 */
function tierStat(tier: TierSize, availability: string, load: { label: string; value: string }) {
  if (tier.setBy === 'load') return load;
  return { label: `${tier.forLoad} for load`, value: `+${tier.count - tier.forLoad} for ${availability}` };
}

/**
 * A part subtitle names the first requirement that forced it and counts the rest ("for send +3
 * more"), so it never runs past its box. Users and Region 2 describe themselves instead.
 */
export function subtitleFor(part: PartView, arch: Architecture): string {
  if (part.id === 'users') return part.reasons[0] ?? '';
  if (part.id === 'region2') {
    return `Full copy of region 1 below, sized to take all traffic, writes copied ${arch.syncToRegion2 ? 'synchronously' : 'asynchronously'} - for ${part.reasons.join(', ')}`;
  }
  const [first, ...rest] = part.reasons;
  return rest.length > 0 ? `for ${first} +${rest.length} more` : `for ${first}`;
}

// ---------------------------------------------------------------------------
// Forced decisions
// ---------------------------------------------------------------------------

function isDrawn(needs: Needs, arch: Architecture) {
  const db = Boolean(arch.parts.db);
  switch (needs) {
    case 'db':
      return db;
    case 'reads':
      return db && arch.flows.includes('read');
    case 'cache':
      return Boolean(arch.parts.cache);
    case 'replicas':
      return db && arch.sizing.database.readReplicas > 0;
    case 'copies':
      return db && (arch.dbCopies > 1 || arch.region2);
    case 'one-copy':
      return db && arch.dbCopies === 1 && !arch.region2;
    case 'db-region2':
      return db && arch.region2;
    case 'async-region2':
      return db && arch.region2 && !arch.syncToRegion2;
    case 'sync-standby':
      return arch.syncStandby;
    case 'sync-region2':
      return arch.syncToRegion2;
  }
}

/**
 * The targets that can have nothing to act on, what they need, and what the Lab says on the
 * slider it turns off - so a slider is never left on with nothing to act on. (A level whose part an
 * earlier choice already built stays on and says so under its slider: `alreadyMet`.) While off, a
 * level set earlier is kept but draws nothing and forces no line (`architecture` and
 * `implicationsFor` ignore it), so ticking the feature back brings it back. Availability and users
 * always apply.
 * - P95 latency speeds up reads: the cache it adds sits in front of the database reads, and a
 *   CDN is already drawn by the features that serve files. No read, nothing to make faster.
 * - Durability decides how the database keeps a write. No database, nothing to keep.
 * - Consistency chooses which copy a read may come from: it needs a second database copy (a
 *   standby, replicas or region 2); with one, every read already sees the latest write.
 */
const TARGET_NEEDS: Partial<Record<NfrId, { applies: (arch: Architecture) => boolean; hint: string }>> = {
  latency: {
    applies: (arch) => arch.flows.includes('read'),
    hint: 'No picked feature reads from the database, so there is no read to make faster.',
  },
  durability: {
    applies: (arch) => Boolean(arch.parts.db),
    hint: 'No picked feature stores anything in a database, so there is no write to keep safe.',
  },
  consistency: {
    applies: (arch) => Boolean(arch.parts.db) && (arch.dbCopies > 1 || arch.region2),
    hint: 'Needs a second database copy. With one copy, every read already sees the latest write.',
  },
};

/** Whether a target has something on this diagram to change; the Lab turns its slider off when not. */
export function targetApplies(id: NfrId, arch: Architecture): boolean {
  return TARGET_NEEDS[id]?.applies(arch) ?? true;
}

/** Why a target is off, for the hint on its slider, or undefined while it applies. */
export function targetOffHint(id: NfrId, arch: Architecture): string | undefined {
  return targetApplies(id, arch) ? undefined : TARGET_NEEDS[id]?.hint;
}

/**
 * What the learner sees of a design: each part with its title, stat row and status line, each wire
 * with its tone, the zones and region 2. Not the subtitles - one more reason named is not a new part.
 */
function drawingOf(arch: Architecture): string {
  const parts = PART_ORDER.flatMap((id) => {
    const part = arch.parts[id];
    return part ? [[id, part.title, part.stat?.label, part.stat?.value, part.status]] : [];
  });
  const wires = edgesFor(arch)
    .map((edge) => [edge.from, edge.to, edge.tone, Boolean(edge.dashed)].join(' '))
    .sort();
  return JSON.stringify({ parts, wires, zones: arch.zones, region2: arch.region2, notBuilt: Object.keys(arch.notBuilt) });
}

/**
 * Why a level draws what an earlier choice already built, read from the design one level below.
 * Undefined when none of these explains it - so a new case shows up as a failing test, not as a
 * vague line in the Lab.
 */
const ALREADY_MET: Partial<Record<NfrId, (below: Architecture, setup: Setup) => string | undefined>> = {
  availability: (below, setup) => {
    const { app, ws } = below.sizing;
    if (setup.nfr.availability === 1 && app.forLoad >= 2) {
      const servers = below.parts.ws
        ? `${formatNumber(app.forLoad)} app servers and ${formatNumber(ws.forLoad)} WebSocket servers`
        : `${formatNumber(app.forLoad)} app servers`;
      return `Already met: the load already needs ${servers} behind a load balancer, more than the 2 copies${below.parts.ws ? ' of each' : ''} 99.9% asks for.`;
    }
    if (setup.nfr.availability === 3 && below.region2) {
      return `Already met: ${usersLabelOf(setup)} daily users already built region 2, a full copy of region 1.`;
    }
    return undefined;
  },
  latency: (below, setup) =>
    setup.nfr.latency === 1 && below.parts.cache
      ? `Already met: ${usersLabelOf(setup)} daily users already put a cache in front of the database reads.`
      : undefined,
  durability: (below, setup) =>
    below.syncStandby
      ? `Already met: ${valueOf('availability', setup.nfr.availability)} already keeps a standby copy, and Strong consistency already makes each write wait for it.`
      : undefined,
};

/**
 * When the current level of a target draws the same as the level below it - an earlier choice
 * already built what it asks for - the line the Lab shows under its slider, which stays on.
 * Undefined at the lowest level, while the target is off, in the loop, or when the level draws something.
 */
export function alreadyMet(id: NfrId, setup: Setup): string | undefined {
  const level = setup.nfr[id];
  if (level === 0 || setup.loop) return undefined;
  const arch = architecture(setup);
  if (!targetApplies(id, arch)) return undefined;
  const below = architecture({ ...setup, nfr: { ...setup.nfr, [id]: level - 1 } });
  if (drawingOf(arch) !== drawingOf(below)) return undefined;
  return ALREADY_MET[id]?.(below, setup);
}

/** The structural decisions the quality targets force, naming only parts that are drawn. */
export function implicationsFor(setup: Setup, arch: Architecture): string[] {
  if (chosenOf(setup).length === 0) return [];
  const lines = new Set<string>();
  for (const spec of NFRS) {
    // A target that is off counts as its lowest level: its slider hint says why, not a line here.
    const level = targetApplies(spec.id, arch) ? (setup.nfr[spec.id] ?? 0) : 0;
    if (spec.id === 'users') {
      // In the loop, the users step and the fixes picked say what the load forced, on their own panel.
      if (setup.loop) continue;
      for (const line of scaleImplications(arch.sizing, level, Boolean(arch.parts.db))) lines.add(line);
      continue;
    }
    // Index 0 is the relaxed baseline ("single instance is acceptable"). It only
    // holds while the target stays at that level; stricter targets replace it.
    // Levels that are alternatives (Eventual, Read-your-writes, Strong) show only their own lines.
    for (let index = level === 0 || spec.alternatives ? level : 1; index <= level; index += 1) {
      for (const item of spec.implications[index] ?? []) {
        if (typeof item === 'string') lines.add(item);
        else if (isDrawn(item.needs, arch)) lines.add(item.text);
      }
    }
  }
  return [...lines];
}

// ---------------------------------------------------------------------------
// Traffic
// ---------------------------------------------------------------------------

export interface RouteVariant {
  route: string[];
  outcome: RequestOutcome;
  weight: number;
}

/** Every path one request of this kind can take, with its share. */
export function routesFor(flow: FlowKind, arch: Architecture): RouteVariant[] {
  const { parts } = arch;
  const entry = parts.lb ? ['users', 'lb'] : ['users'];
  const toPhones = ['ws', ...(parts.lb ? ['lb'] : []), 'users'];
  const viaApp = (tail: string[], outcome: RequestOutcome = 'success', weight = 1): RouteVariant => ({
    route: [...entry, 'api', ...tail],
    outcome,
    weight,
  });
  // Region 2 keeps a copy of every write: a stored write carries on along the dashed wire.
  const stored = (tail: string[]) => (arch.region2 && tail[tail.length - 1] === 'db' ? [...tail, 'r2-db'] : tail);

  let variants: RouteVariant[];
  switch (flow) {
    case 'write':
      variants = [viaApp(stored(['db']))];
      break;
    case 'read':
      variants = parts.cache
        ? [viaApp(['cache'], 'cache-hit', arch.cacheHit), viaApp(['db'], 'success', 1 - arch.cacheHit)]
        : [viaApp(['db'])];
      break;
    case 'receipt':
      // Up the connection of the phone that got the message, stored, then down to the sender.
      variants = [
        { route: [...entry, 'ws', 'api', ...stored(['db'])], outcome: 'success', weight: 1 },
        { route: ['api', ...toPhones], outcome: 'success', weight: 1 },
      ];
      break;
    case 'batch-match':
      variants = [viaApp(['async', 'index'])];
      break;
    case 'upload':
      variants = [viaApp(['objects'])];
      break;
    case 'process':
      // The stored file is processed later; the worker writes the new sizes back to object storage.
      variants = [viaApp(['async', 'objects'])];
      break;
    case 'fan-out':
      // Workers hand one copy of a group message to the connection of every member.
      variants = [viaApp(['async', ...toPhones])];
      break;
    case 'job':
      variants = [viaApp(['async', ...stored(['db'])])];
      break;
    case 'index-sync':
      variants = [viaApp(['async', 'index'])];
      break;
    case 'index-write':
    case 'index-read':
      variants = [viaApp(['index'])];
      break;
    case 'push':
      // Server to phone over the held-open connection (through the load balancer when there is one).
      return [{ route: ['api', ...toPhones], outcome: 'success', weight: 1 }];
    case 'call':
      return [{ route: ['users', 'media'], outcome: 'success', weight: 1 }];
    case 'expire':
      // A scheduled job: it starts at the workers, not with a request.
      return [{ route: ['async', 'objects'], outcome: 'success', weight: 1 }];
    case 'media':
      return [
        { route: ['users', 'cdn'], outcome: 'cache-hit', weight: CDN_HIT },
        { route: ['users', 'cdn', 'objects'], outcome: 'success', weight: 1 - CDN_HIT },
      ];
  }

  if (!arch.region2) return variants;
  // Two regions: DNS sends each user to the nearest one, so region 2 serves about half.
  return [
    { route: ['users', 'r2-users'], outcome: 'success', weight: 0.5 },
    ...variants.map((variant) => ({ ...variant, weight: variant.weight * 0.5 })),
  ];
}

function toneFor(a: string, b: string): EdgeTone {
  const pair = [a, b];
  if (pair.includes('ws')) return 'violet';
  if (pair.includes('async')) return 'info';
  if (pair.includes('cache') || pair.includes('cdn')) return 'ok';
  return 'brand';
}

/** Region 2 is drawn as one band; these are where wires meet it, not parts of region 1. */
const REGION2_PORTS = new Set(['r2-users', 'r2-db']);

/** The tone of a wire to a not-built part: drawn dashed, and fainter than any wire with traffic. */
const NOT_BUILT_TONE: EdgeTone = 'muted';

/**
 * One wire per pair of parts that some request actually travels between, then a dashed grey wire
 * for each hop an unpicked feature would add to a not-built part. No request travels those.
 */
export function edgesFor(arch: Architecture): DiagramEdge[] {
  const edges = new Map<string, DiagramEdge>();
  const addEdge = (edge: DiagramEdge) => {
    const key = [edge.from, edge.to].sort().join('|');
    if (!edges.has(key)) edges.set(key, edge);
  };
  for (const flow of new Set(arch.flows)) {
    for (const { route } of routesFor(flow, arch)) {
      for (let index = 0; index < route.length - 1; index += 1) {
        const [from, to] = [route[index], route[index + 1]];
        if (REGION2_PORTS.has(to)) continue;
        addEdge({ from, to, tone: toneFor(from, to), width: 2 });
      }
    }
  }
  if (arch.region2) {
    addEdge({ from: 'users', to: 'r2-users', tone: 'brand', width: 2, label: 'nearest region' });
    // Strong consistency: the write waits for region 2 (solid amber); otherwise it follows later (dashed).
    if (arch.parts.db) {
      addEdge(
        arch.syncToRegion2
          ? { from: 'db', to: 'r2-db', tone: 'warn', width: 2 }
          : { from: 'db', to: 'r2-db', tone: 'default', width: 2, dashed: true },
      );
    }
  }
  // Routed as if the not-built parts were there; only the hops that reach one are drawn.
  const wouldBe: Architecture = { ...arch, parts: { ...arch.parts, ...arch.notBuilt } };
  for (const flow of new Set(arch.notBuiltFlows)) {
    for (const { route } of routesFor(flow, wouldBe)) {
      for (let index = 0; index < route.length - 1; index += 1) {
        const [from, to] = [route[index], route[index + 1]];
        if (REGION2_PORTS.has(from) || REGION2_PORTS.has(to)) continue;
        if (!(from in arch.notBuilt) && !(to in arch.notBuilt)) continue;
        addEdge({ from, to, tone: NOT_BUILT_TONE, width: 2, dashed: true });
      }
    }
  }
  return [...edges.values()];
}

// ---------------------------------------------------------------------------
// Legend
// ---------------------------------------------------------------------------

/**
 * A wire tone, 'dashed' for the later copy to region 2, or 'not-built' for the dashed grey wires of
 * features that are not picked.
 */
export type WireKey = EdgeTone | 'dashed' | 'not-built';

/** Which legend line a wire belongs to. */
export function wireKeyOf(edge: DiagramEdge): WireKey {
  if (edge.dashed) return edge.tone === NOT_BUILT_TONE ? 'not-built' : 'dashed';
  return edge.tone ?? 'default';
}

export interface Legend {
  wires: { tone: WireKey; label: string }[];
  outcomes: { outcome: RequestOutcome; label: string }[];
}

const WIRE_LABEL: Partial<Record<WireKey, string>> = {
  brand: 'Blue wires: requests and replies',
  violet: 'Violet: pushed to phones over held-open connections',
  info: 'Indigo: queued work for background workers',
  ok: 'Green: answered by a cache or the CDN edge',
  warn: 'Amber: writes wait for region 2 before the reply',
  dashed: 'Dashed: writes copied to region 2 a moment later',
  'not-built': 'Grey dashed: a feature not picked, so its parts are not built and carry nothing',
};
const WIRE_ORDER: WireKey[] = ['brand', 'violet', 'info', 'ok', 'warn', 'dashed', 'not-built'];

/** The legend for what is on screen: only the wire tones drawn and the particle shapes that travel. */
export function legendFor(arch: Architecture): Legend {
  const drawn = new Set<WireKey>(edgesFor(arch).map(wireKeyOf));
  const wires = WIRE_ORDER.filter((tone) => drawn.has(tone)).map((tone) => ({ tone, label: WIRE_LABEL[tone] ?? '' }));

  const travelling = new Set<RequestOutcome>(
    arch.flows.flatMap((flow) => routesFor(flow, arch).map((variant) => variant.outcome)),
  );
  const hitLabel = arch.parts.cache && arch.parts.cdn ? 'Cache or edge hit' : arch.parts.cdn ? 'CDN edge hit' : 'Cache hit';
  const outcomes: Legend['outcomes'] = [];
  if (travelling.has('success')) outcomes.push({ outcome: 'success', label: 'Request or message' });
  if (travelling.has('cache-hit')) outcomes.push({ outcome: 'cache-hit', label: hitLabel });
  return { wires, outcomes };
}

// ---------------------------------------------------------------------------
// Layout: four columns (users | edge | app | data), fixed slots so a part always
// appears in the same place. Every wire runs between neighbouring slots or
// through an empty gap, so none passes under a card.
// ---------------------------------------------------------------------------

export const H = 94;
export const MID = 260;
export const ROW = [104, 208, 312, 416];
const COL = [
  // 160 wide so "Media servers x3" (one relay per zone from 99.99%) fits its title column.
  { x: 16, w: 160 },
  { x: 224, w: 176 },
  { x: 456, w: 196 },
  { x: 708, w: 236 },
];
export const HEIGHT = 520;

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

const slot = (col: number, y: number): Box => ({ x: COL[col].x, y, w: COL[col].w, h: H });

export const SLOTS: Record<Exclude<PartId, 'region2'>, Box> = {
  users: slot(0, MID),
  cdn: slot(1, ROW[0]),
  lb: slot(1, MID),
  media: slot(0, ROW[3]),
  objects: slot(2, ROW[0]),
  api: slot(2, MID),
  ws: slot(2, ROW[3]),
  db: slot(3, ROW[0]),
  async: slot(3, ROW[1]),
  index: slot(3, ROW[2]),
  cache: slot(3, ROW[3]),
};

/** Region 2 is one band across the top: a collapsed copy of everything below it. */
export const REGION2: Box = { x: 16, y: 10, w: 928, h: 74 };
/** Where the wires from Users and from the database meet that band. */
export const REGION2_BOXES: Record<'r2-users' | 'r2-db', Box> = {
  'r2-users': { x: COL[0].x, y: REGION2.y, w: COL[0].w, h: REGION2.h },
  'r2-db': { x: COL[3].x, y: REGION2.y, w: COL[3].w, h: REGION2.h },
};
