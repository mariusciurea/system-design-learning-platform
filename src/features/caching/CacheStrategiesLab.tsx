import { useCallback, useMemo, useRef } from 'react';
import {
  ArchNode,
  DiagramCanvas,
  NodeStatRow,
  ParticleLegend,
  type DiagramEdge,
  type Layout,
  type ParticleView,
} from '@/components/architecture';
import { Insight, LabShell, TradeOffTable } from '@/components/learning';
import { SegmentedControl, Slider } from '@/components/ui';
import { useTicker } from '@/simulations/engine';
import { useLabSetup } from '@/hooks/useLabSetup';
import { useRerender } from '@/hooks/useRerender';
import type { RequestOutcome } from '@/types';
// Imported directly: this lab is its own lazy chunk, and it needs the full trade-offs, not the index.
import { performanceConcepts } from '@/data/concepts/performance';
import { useLabRunning } from '@/hooks/useLabRunning';

type Strategy = 'cache-aside' | 'read-through' | 'write-through' | 'write-behind' | 'write-around';
type Operation = 'read' | 'write';

interface Step {
  from: string;
  to: string;
  label: string;
  outcome: RequestOutcome;
  /** Rendered under the diagram while this step is active. */
  note: string;
  async?: boolean;
}

const LAYOUT: Layout = {
  app: { x: 90, y: 200, w: 180, h: 106 },
  cache: { x: 390, y: 90, w: 190, h: 110 },
  db: { x: 390, y: 320, w: 190, h: 110 },
  client: { x: 690, y: 200, w: 186, h: 106 },
};

const STRATEGIES: { value: Strategy; label: string }[] = [
  { value: 'cache-aside', label: 'Cache aside' },
  { value: 'read-through', label: 'Read through' },
  { value: 'write-through', label: 'Write through' },
  { value: 'write-behind', label: 'Write behind' },
  { value: 'write-around', label: 'Write around' },
];

/**
 * What each strategy costs, in the simplified numbers the diagram shows (cache
 * about 1 ms, database about 50 ms - the same figures as the Caching Lab).
 */
const PROFILES: Record<Strategy, { writeWaits: string; readAfterWrite: string; cacheDies: string }> = {
  'cache-aside': {
    writeWaits: 'Database, then a DEL: about 51 ms',
    readAfterWrite: 'A miss that reloads the new value',
    cacheDies: 'Reads fall back to the database: slower, still correct',
  },
  'read-through': {
    writeWaits: 'Whatever write strategy it is paired with',
    readAfterWrite: 'A miss the cache loads by itself',
    cacheDies: 'Reads fail unless the client falls back to the database',
  },
  'write-through': {
    writeWaits: 'Cache and database: about 51 ms',
    readAfterWrite: 'A hit with the new value',
    cacheDies: 'Nothing lost: the database has every write',
  },
  'write-behind': {
    writeWaits: 'Cache only: about 1 ms',
    readAfterWrite: 'A hit, while the database is still behind',
    cacheDies: 'Acknowledged writes not yet flushed are lost',
  },
  'write-around': {
    writeWaits: 'Database only: about 50 ms',
    readAfterWrite: 'A miss: the first read loads it',
    cacheDies: 'Reads fall back to the database: slower, still correct',
  },
};

const FLOWS: Record<Strategy, Record<Operation, Step[]>> = {
  'cache-aside': {
    read: [
      { from: 'app', to: 'cache', label: 'GET key', outcome: 'success', note: 'The application asks the cache first.' },
      { from: 'cache', to: 'app', label: 'MISS', outcome: 'warning', note: 'Nothing cached - the application must go to the database itself.' },
      { from: 'app', to: 'db', label: 'SELECT', outcome: 'success', note: 'The application queries the source of truth.' },
      { from: 'db', to: 'app', label: 'row', outcome: 'success', note: 'The row comes back.' },
      { from: 'app', to: 'cache', label: 'SET key', outcome: 'cache-hit', note: 'The application populates the cache for next time. This step is what makes it "aside".' },
      { from: 'app', to: 'client', label: '200 OK', outcome: 'success', note: 'Response returned. The next read for this key is a hit.' },
    ],
    write: [
      { from: 'app', to: 'db', label: 'UPDATE', outcome: 'success', note: 'Writes go directly to the database.' },
      { from: 'app', to: 'cache', label: 'DEL key', outcome: 'warning', note: 'The cached copy is deleted, not updated. Cache-aside usually pairs with this write path (write-around plus invalidation). Forgetting the DEL is the classic stale-data bug.' },
      { from: 'app', to: 'client', label: '200 OK', outcome: 'success', note: 'Next read misses and reloads the fresh value.' },
    ],
  },
  'read-through': {
    read: [
      { from: 'app', to: 'cache', label: 'GET key', outcome: 'success', note: 'The application only ever talks to the cache.' },
      { from: 'cache', to: 'db', label: 'load on miss', outcome: 'warning', note: 'The cache itself loads from the database - the application never sees the miss.' },
      { from: 'db', to: 'cache', label: 'row', outcome: 'success', note: 'The cache stores the value.' },
      { from: 'cache', to: 'app', label: 'value', outcome: 'cache-hit', note: 'One code path for hits and misses - less duplicated logic than cache-aside.' },
      { from: 'app', to: 'client', label: '200 OK', outcome: 'success', note: 'Response returned.' },
    ],
    write: [
      { from: 'app', to: 'db', label: 'UPDATE', outcome: 'success', note: 'Read-through says nothing about writes - pair it with a write strategy.' },
      { from: 'app', to: 'client', label: '200 OK', outcome: 'success', note: 'The cache will reload the value on the next read after expiry or invalidation.' },
    ],
  },
  'write-through': {
    read: [
      { from: 'app', to: 'cache', label: 'GET key', outcome: 'success', note: 'Reads hit the cache.' },
      { from: 'cache', to: 'app', label: 'HIT', outcome: 'cache-hit', note: 'Because every write populated the cache, written keys are always present.' },
      { from: 'app', to: 'client', label: '200 OK', outcome: 'success', note: 'Fast, and never stale for keys that were written through.' },
    ],
    write: [
      { from: 'app', to: 'cache', label: 'SET key', outcome: 'success', note: 'The write goes to the cache first.' },
      { from: 'cache', to: 'db', label: 'UPDATE (sync)', outcome: 'success', note: 'The cache writes through to the database synchronously - the caller waits for both.' },
      { from: 'db', to: 'cache', label: 'ack', outcome: 'success', note: 'Only after the database confirms is the write considered done.' },
      { from: 'app', to: 'client', label: '200 OK', outcome: 'success', note: 'Consistent, but every write now pays cache latency plus database latency.' },
    ],
  },
  'write-behind': {
    read: [
      { from: 'app', to: 'cache', label: 'GET key', outcome: 'success', note: 'Reads hit the cache.' },
      { from: 'cache', to: 'app', label: 'HIT', outcome: 'cache-hit', note: 'The cache may hold values the database has not received yet.' },
      { from: 'app', to: 'client', label: '200 OK', outcome: 'success', note: 'Fast reads, but the database is temporarily behind.' },
    ],
    write: [
      { from: 'app', to: 'cache', label: 'SET key', outcome: 'success', note: 'The write lands in the cache.' },
      { from: 'app', to: 'client', label: '200 OK (fast)', outcome: 'success', note: 'The caller is acknowledged immediately - this is why write-behind is fast.' },
      { from: 'cache', to: 'db', label: 'flush (async)', outcome: 'warning', async: true, note: 'The cache flushes to the database later, often batched. If the cache dies first, that write is gone.' },
    ],
  },
  'write-around': {
    read: [
      { from: 'app', to: 'cache', label: 'GET key', outcome: 'success', note: 'Reads check the cache.' },
      { from: 'cache', to: 'app', label: 'MISS', outcome: 'warning', note: 'Recently written keys are not cached, so the first read always misses.' },
      { from: 'app', to: 'db', label: 'SELECT', outcome: 'success', note: 'The value is loaded from the database.' },
      { from: 'app', to: 'cache', label: 'SET key', outcome: 'cache-hit', note: 'Now it is cached - populated by reads, not by writes.' },
      { from: 'app', to: 'client', label: '200 OK', outcome: 'success', note: 'Response returned.' },
    ],
    write: [
      { from: 'app', to: 'db', label: 'INSERT', outcome: 'success', note: 'The write goes straight to the database, bypassing the cache. A new row has nothing cached yet; an update would also DEL the old cached copy.' },
      { from: 'app', to: 'client', label: '201 Created', outcome: 'success', note: 'The cache is never filled with write-once data that nobody reads. The first read of this row will miss.' },
    ],
  },
};

/** Every control of the Lab. Reset returns to this one object, so it cannot miss a control. */
const DEFAULT_SETUP: { strategy: Strategy; operation: Operation; speed: number } = {
  strategy: 'cache-aside',
  operation: 'read',
  speed: 0.8,
};

export function CacheStrategiesLab() {
  const [running, setRunning] = useLabRunning();
  const { setup, setSetup, change } = useLabSetup(DEFAULT_SETUP);
  const { strategy, operation, speed } = setup;
  const progress = useRef({ step: 0, t: 0 });
  const rerender = useRerender(30);

  const steps = FLOWS[strategy][operation];

  const reset = useCallback(() => {
    progress.current = { step: 0, t: 0 };
    setSetup(DEFAULT_SETUP);
    rerender();
  }, [rerender, setSetup]);

  useTicker(running, (dt) => {
    const current = progress.current;
    current.t += dt * speed;
    if (current.t >= 1.35) {
      current.t = 0;
      current.step = (current.step + 1) % steps.length;
    }
    rerender();
  });

  const active = steps[Math.min(progress.current.step, steps.length - 1)];

  const edges = useMemo<DiagramEdge[]>(() => {
    const unique = new Map<string, DiagramEdge>();
    for (const step of steps) {
      const key = `${step.from}->${step.to}`;
      // Two steps can share an edge (cache-aside: GET key, later SET key).
      // Keep the active one, or step 1 would be drawn muted and unlabelled.
      if (unique.get(key)?.animated) continue;
      unique.set(key, {
        from: step.from,
        to: step.to,
        tone: step === active ? 'brand' : 'muted',
        dashed: step.async,
        animated: step === active,
        label: step === active ? step.label : undefined,
      });
    }
    return [...unique.values()];
  }, [steps, active]);

  const particles: ParticleView[] = [
    {
      id: 1,
      from: active.from,
      to: active.to,
      t: Math.min(1, progress.current.t),
      outcome: active.outcome,
    },
  ];

  const concept = performanceConcepts.find((item) => item.slug === 'cache-strategies');

  return (
    <LabShell
      title="Cache Strategies Lab"
      description="Step through the exact sequence of hops for each strategy, for both reads and writes."
      running={running}
      onRunningChange={setRunning}
      onReset={reset}
      legend={
        <ParticleLegend
          outcomes={[
            { outcome: 'success', label: 'Request or reply' },
            { outcome: 'cache-hit', label: 'Value from or into the cache' },
            { outcome: 'warning', label: 'Miss, delete or async flush' },
          ]}
        />
      }
      insight={
        <Insight title={`Step ${progress.current.step + 1} of ${steps.length}`}>
          <strong className="text-ink">{active.label}:</strong> {active.note}
        </Insight>
      }
      metrics={
        <>
          <div className="card p-4">
            <p className="label mb-3">Sequence</p>
            <ol className="space-y-1.5">
              {steps.map((step, index) => (
                <li
                  key={`${step.from}-${step.to}-${index}`}
                  className={`flex items-start gap-2.5 rounded-lg px-2.5 py-1.5 text-sm transition-colors ${
                    index === progress.current.step ? 'bg-brand/10 text-ink' : 'text-muted'
                  }`}
                >
                  <span className="mt-0.5 font-mono text-[11px] text-faint">{index + 1}</span>
                  <span className="font-mono text-xs text-brand">
                    {step.from} {'->'} {step.to}
                  </span>
                  <span className="flex-1">{step.label}</span>
                  {step.async ? <span className="text-[11px] uppercase text-faint">async</span> : null}
                </li>
              ))}
            </ol>
          </div>
          <div className="card p-4">
            <p className="label mb-3">What {STRATEGIES.find((item) => item.value === strategy)?.label.toLowerCase()} costs</p>
            <dl className="space-y-2 text-sm">
              {[
                ['A write waits for', PROFILES[strategy].writeWaits],
                ['Read right after a write', PROFILES[strategy].readAfterWrite],
                ['If the cache dies', PROFILES[strategy].cacheDies],
              ].map(([term, detail]) => (
                <div key={term} className="flex flex-col gap-0.5">
                  <dt className="text-xs text-faint">{term}</dt>
                  <dd className="text-ink">{detail}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-3 text-[11px] text-faint">Simplified latencies: cache about 1 ms, database about 50 ms.</p>
          </div>
          {concept?.tradeoffs ? (
            <div className="card p-4">
              <p className="label mb-3">Trade-offs</p>
              <TradeOffTable tradeoffs={concept.tradeoffs} />
            </div>
          ) : null}
        </>
      }
      controls={
        <>
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted">Strategy</p>
            <div role="group" aria-label="Strategy" className="space-y-1.5">
              {STRATEGIES.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  aria-pressed={strategy === item.value}
                  onClick={() => {
                    change('strategy')(item.value);
                    progress.current = { step: 0, t: 0 };
                  }}
                  className={`w-full rounded-lg border px-3 py-2 text-left text-xs font-medium transition-colors ${
                    strategy === item.value
                      ? 'border-brand bg-brand/10 text-brand'
                      : 'border-line text-muted hover:border-brand/50 hover:text-ink'
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted">Operation</p>
            <SegmentedControl
              value={operation}
              size="sm"
              options={[
                { value: 'read', label: 'Read' },
                { value: 'write', label: 'Write' },
              ]}
              onChange={(value) => {
                change('operation')(value);
                progress.current = { step: 0, t: 0 };
              }}
              className="w-full"
            />
          </div>
          <Slider
            label="Animation speed"
            value={speed}
            min={0.2}
            max={2}
            step={0.1}
            onChange={change('speed')}
            format={(value) => `${value.toFixed(1)}x`}
          />
          <button
            type="button"
            onClick={() => {
              progress.current = {
                step: (progress.current.step + 1) % steps.length,
                t: 0,
              };
              setRunning(false);
              rerender();
            }}
            className="w-full rounded-xl border border-line px-3 py-2 text-xs font-medium text-ink transition-colors hover:border-brand hover:text-brand"
          >
            Step forward
          </button>
        </>
      }
    >
      <DiagramCanvas layout={LAYOUT} edges={edges} particles={particles} height={470} className="bg-canvas">
        <ArchNode kind="server" title="Application" subtitle="your code" placed={LAYOUT.app}>
          <NodeStatRow label="Strategy" value={STRATEGIES.find((item) => item.value === strategy)?.label ?? ''} />
        </ArchNode>
        <ArchNode kind="cache" title="Cache" subtitle="Redis" placed={LAYOUT.cache}>
          <NodeStatRow label="Latency" value="~1 ms" />
        </ArchNode>
        <ArchNode kind="sql" title="Database" subtitle="source of truth" placed={LAYOUT.db}>
          <NodeStatRow label="Latency" value="~50 ms" />
        </ArchNode>
        <ArchNode kind="client" title="Caller" subtitle="waiting for the response" placed={LAYOUT.client} compact />
      </DiagramCanvas>
    </LabShell>
  );
}

export default CacheStrategiesLab;
