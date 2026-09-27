import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { AsciiBlock } from '@/components/learning';
import { FlowVisual } from '@/components/architecture/FlowVisual';
import { getVisual } from '@/data/visuals';
import { Badge } from '@/components/ui';
import { cn } from '@/utils/cn';

type Verdict = 'a' | 'b' | 'equal';

interface ComparisonRow {
  dimension: string;
  a: string;
  b: string;
  /** Which side is stronger on this dimension - or neither. */
  favours: Verdict;
}

interface Comparison {
  id: string;
  title: string;
  a: { name: string; diagram: string; concept: string };
  b: { name: string; diagram: string; concept: string };
  rows: ComparisonRow[];
  verdict: string;
}

const COMPARISONS: Comparison[] = [
  {
    id: 'scaling',
    title: 'Vertical vs Horizontal Scaling',
    a: {
      name: 'Vertical scaling',
      concept: 'vertical-scaling',
      diagram: `      Users
        |
        v
  +--------------+
  |  Big Server  |
  |  16 vCPU     |
  |  64 GB RAM   |
  +--------------+
        |
     Database`,
    },
    b: {
      name: 'Horizontal scaling',
      concept: 'horizontal-scaling',
      diagram: `          Users
            |
      Load Balancer
       /    |    \\
      v     v     v
     S1    S2    S3
       \\    |    /
        Database`,
    },
    rows: [
      { dimension: 'Maximum scale', a: 'Bounded by the largest machine available', b: 'Add instances almost indefinitely', favours: 'b' },
      { dimension: 'Complexity', a: 'No distributed concerns at all', b: 'Load balancing, health checks, stateless app', favours: 'a' },
      { dimension: 'Cost curve', a: 'Grows faster than capacity at the top end', b: 'Roughly linear, and elastic', favours: 'b' },
      { dimension: 'Fault tolerance', a: 'Single point of failure', b: 'Losing one node costs a share of capacity', favours: 'b' },
      { dimension: 'Operational overhead', a: 'One machine to patch and monitor', b: 'A fleet, plus deploys across it', favours: 'a' },
      { dimension: 'Deployment', a: 'Restart means downtime', b: 'Rolling deploys with no downtime', favours: 'b' },
      { dimension: 'Consistency', a: 'Everything is local and strongly consistent', b: 'Shared state must move to a datastore', favours: 'a' },
    ],
    verdict:
      'Scale up first because it is simple and buys real time. Scale out when you need redundancy or pass the hardware ceiling - and note that most systems end up doing both.',
  },
  {
    id: 'architecture',
    title: 'Monolith vs Microservices',
    a: {
      name: 'Monolith',
      concept: 'monolith',
      diagram: `   +--------------------+
   |    Application     |
   |  Users | Orders    |
   |  Payments | Notif  |
   +--------------------+
             |
          Database`,
    },
    b: {
      name: 'Microservices',
      concept: 'microservices',
      diagram: `      API Gateway
       /    |    \\
      v     v     v
  Users  Orders  Payments
    |      |        |
  DB     DB        DB`,
    },
    rows: [
      { dimension: 'Deployment', a: 'One pipeline, everyone ships together', b: 'Independent per service', favours: 'b' },
      { dimension: 'Local development', a: 'Run one process', b: 'Run several, or mock them', favours: 'a' },
      { dimension: 'Transactions', a: 'Real ACID across the whole domain', b: 'Sagas and compensation', favours: 'a' },
      { dimension: 'Scaling granularity', a: 'Scale everything together', b: 'Scale only the hot service', favours: 'b' },
      { dimension: 'Fault isolation', a: 'One crash affects everything', b: 'Contained, if callers degrade', favours: 'b' },
      { dimension: 'Debugging', a: 'One stack trace', b: 'Distributed tracing required', favours: 'a' },
      { dimension: 'Team autonomy', a: 'Shared release train', b: 'Teams own their own service', favours: 'b' },
      { dimension: 'Infrastructure cost', a: 'Low', b: 'Service discovery, tracing, CI/CD per service', favours: 'a' },
    ],
    verdict:
      'Microservices trade simplicity for independence. Below roughly a dozen engineers the trade rarely pays; a modular monolith keeps the boundaries without the network.',
  },
  {
    id: 'consistency',
    title: 'Strong vs Eventual Consistency',
    a: {
      name: 'Strong consistency',
      concept: 'strong-consistency',
      diagram: ` write -> leader
           |
     replicate to quorum
           |
        ack to client

 every read sees the latest write`,
    },
    b: {
      name: 'Eventual consistency',
      concept: 'eventual-consistency',
      diagram: ` write -> any replica -> ack
           |
      propagate async
           |
   replicas converge later

 reads may be stale for a while`,
    },
    rows: [
      { dimension: 'Read correctness', a: 'Always the latest value', b: 'May be stale', favours: 'a' },
      { dimension: 'Write latency', a: 'Quorum round trip on every write', b: 'Local acknowledgement', favours: 'b' },
      { dimension: 'Availability during a partition', a: 'Minority side refuses writes', b: 'Every replica keeps serving', favours: 'b' },
      { dimension: 'Application complexity', a: 'Simple - no conflicts to resolve', b: 'Conflict resolution is your problem', favours: 'a' },
      { dimension: 'Cross-region', a: 'Expensive - physics applies', b: 'Works well', favours: 'b' },
      { dimension: 'Suitable for', a: 'Payments, inventory, unique constraints', b: 'Feeds, likes, presence, analytics', favours: 'equal' },
    ],
    verdict:
      'This is a per-operation decision, not a per-system one. The same product usually wants strong consistency for money and eventual consistency for counters.',
  },
  {
    id: 'communication',
    title: 'Synchronous vs Asynchronous Communication',
    a: {
      name: 'Request / response',
      concept: 'request-response',
      diagram: ` A --request--> B
   <--response--

 A waits. If B is down,
 A has a problem now.`,
    },
    b: {
      name: 'Message queue',
      concept: 'message-queues',
      diagram: ` A --> [ queue ] --> B

 A returns immediately.
 If B is down, work waits.`,
    },
    rows: [
      { dimension: 'Result availability', a: 'Immediate', b: 'Eventually - status must be exposed', favours: 'a' },
      { dimension: 'Coupling', a: 'B must be up right now', b: 'B can be down temporarily', favours: 'b' },
      { dimension: 'Load spikes', a: 'Timeouts and errors', b: 'A longer queue', favours: 'b' },
      { dimension: 'Error handling', a: 'Straightforward - handle the error inline', b: 'Retries, dead letters, idempotency', favours: 'a' },
      { dimension: 'Observability', a: 'One trace', b: 'Context must cross the broker', favours: 'a' },
      { dimension: 'Throughput smoothing', a: 'None', b: 'Built in', favours: 'b' },
    ],
    verdict:
      'Use synchronous calls when the caller genuinely needs the answer to continue. Everything else - email, thumbnails, exports, analytics - belongs behind a queue.',
  },
];

export function ComparePage() {
  const [selected, setSelected] = useState(COMPARISONS[0].id);
  const comparison = COMPARISONS.find((item) => item.id === selected) ?? COMPARISONS[0];

  return (
    <div className="px-5 py-8 lg:px-8">
      <div className="mx-auto max-w-5xl">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">Compare Mode</h1>
          <p className="mt-1.5 max-w-2xl text-sm text-muted">
            Two approaches side by side, dimension by dimension. Neither column wins outright - which is the point.
          </p>
        </header>

        <div className="mt-5 flex flex-wrap gap-2">
          {COMPARISONS.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setSelected(item.id)}
              aria-pressed={selected === item.id}
              className={cn(
                // Touch screens get the app-wide 44px target; a mouse keeps the compact chip.
                'rounded-xl border px-3.5 py-2 text-xs font-medium transition-colors',
                selected === item.id
                  ? 'border-brand bg-brand/10 text-brand'
                  : 'border-line text-muted hover:border-brand/50 hover:text-ink',
              )}
            >
              {item.title}
            </button>
          ))}
        </div>

        <div className="mt-6 grid gap-4 md:grid-cols-2">
          {[comparison.a, comparison.b].map((side) => {
            const visual = getVisual(side.concept);
            return (
              <div key={side.name} className="overflow-hidden rounded-2xl border border-line bg-surface">
                <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
                  <h2 className="text-sm font-semibold text-ink">{side.name}</h2>
                  <Link
                    to={`/concepts/${side.concept}`}
                    className="flex items-center gap-1 text-xs text-brand hover:underline"
                  >
                    Learn <ArrowRight className="h-3 w-3" />
                  </Link>
                </div>
                {visual ? (
                  <FlowVisual spec={visual} className="rounded-none border-0" />
                ) : (
                  <AsciiBlock className="m-4">{side.diagram}</AsciiBlock>
                )}
              </div>
            );
          })}
        </div>

        {/* Phone: one row per dimension, the two values stacked and labelled. */}
        <ul className="mt-4 overflow-hidden rounded-2xl border border-line bg-surface sm:hidden">
          {comparison.rows.map((row) => (
            <li key={row.dimension} className="border-b border-line p-4 last:border-0">
              <p className="text-sm font-semibold text-ink">{row.dimension}</p>
              <dl className="-mx-3 mt-1.5 space-y-0.5">
                {(['a', 'b'] as const).map((side) => {
                  const stronger = row.favours === side;
                  return (
                    <div
                      key={side}
                      className={cn('rounded-lg px-3 py-2', stronger && 'bg-ok/5')}
                    >
                      <dt className="flex items-center justify-between gap-2 text-[11px] font-semibold uppercase tracking-wide text-faint">
                        <span className="min-w-0">{comparison[side].name}</span>
                        {stronger ? <Badge tone="ok" className="shrink-0 normal-case tracking-normal">stronger</Badge> : null}
                      </dt>
                      <dd className={cn('mt-1 text-xs leading-relaxed', stronger ? 'text-ink' : 'text-muted')}>
                        {row[side]}
                      </dd>
                    </div>
                  );
                })}
              </dl>
            </li>
          ))}
        </ul>

        {/* A grid drawn as a table, so a screen reader announces each value with its column. */}
        <div
          role="table"
          aria-label={comparison.title}
          className="mt-4 hidden overflow-hidden rounded-2xl border border-line bg-surface sm:block"
        >
          <div role="row" className="grid grid-cols-[150px_1fr_1fr] gap-px border-b border-line bg-elevated">
            <span role="columnheader" className="px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-faint">
              Dimension
            </span>
            <span role="columnheader" className="px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-faint">
              {comparison.a.name}
            </span>
            <span role="columnheader" className="px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-faint">
              {comparison.b.name}
            </span>
          </div>
          {comparison.rows.map((row) => (
            <div
              key={row.dimension}
              role="row"
              className="grid grid-cols-[150px_1fr_1fr] gap-px border-b border-line last:border-0"
            >
              <span role="rowheader" className="px-4 py-3 text-xs font-medium text-ink">
                {row.dimension}
              </span>
              <span
                role="cell"
                className={cn(
                  'px-4 py-3 text-xs',
                  row.favours === 'a' ? 'bg-ok/5 text-ink' : 'text-muted',
                )}
              >
                {row.a}
                {row.favours === 'a' ? <Badge tone="ok" className="ml-2">stronger</Badge> : null}
              </span>
              <span
                role="cell"
                className={cn(
                  'px-4 py-3 text-xs',
                  row.favours === 'b' ? 'bg-ok/5 text-ink' : 'text-muted',
                )}
              >
                {row.b}
                {row.favours === 'b' ? <Badge tone="ok" className="ml-2">stronger</Badge> : null}
              </span>
            </div>
          ))}
        </div>

        <div className="mt-4 rounded-2xl border border-brand/30 bg-brand/5 p-5">
          <p className="label mb-2 text-brand">How to choose</p>
          <p className="text-sm leading-relaxed text-muted">{comparison.verdict}</p>
        </div>
      </div>
    </div>
  );
}

export default ComparePage;
