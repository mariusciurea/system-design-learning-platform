import { useCallback, useMemo, useRef, useState } from 'react';
import { Database, Search, Trash2, Zap } from 'lucide-react';
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
import { Button, Meter, Select, Slider } from '@/components/ui';
import { nextParticleId, useEventLog, useTicker, visualShare, type Particle } from '@/simulations/engine';
import { computeLoad } from '@/simulations/models/load';
import { useRerender } from '@/hooks/useRerender';
import { clamp, mulberry32, sampleArrivals } from '@/utils/math';
import { formatLatency, formatNumber } from '@/utils/format';
import { cn } from '@/utils/cn';
import { useLabRunning } from '@/hooks/useLabRunning';

interface Row {
  id: number;
  name: string;
  email: string;
  country: string;
  createdAt: string;
}

const FIRST = ['ada', 'grace', 'linus', 'barbara', 'alan', 'edsger', 'katherine', 'john', 'radia', 'leslie'];
const LAST = ['lovelace', 'hopper', 'torvalds', 'liskov', 'turing', 'dijkstra', 'johnson', 'backus', 'perlman', 'lamport'];
const COUNTRIES = ['DE', 'US', 'RO', 'JP', 'BR', 'IN', 'FR', 'NG'];

/** Deterministic table so the row numbers quoted in the UI stay stable. */
function buildTable(size: number): Row[] {
  const random = mulberry32(20260915);
  return Array.from({ length: size }, (_, index) => {
    const first = FIRST[Math.floor(random() * FIRST.length)];
    const last = LAST[Math.floor(random() * LAST.length)];
    return {
      id: index + 1,
      name: `${first} ${last}`,
      email: `${first}.${last}${index + 1}@example.com`,
      country: COUNTRIES[Math.floor(random() * COUNTRIES.length)],
      createdAt: `2026-${String(1 + Math.floor(random() * 9)).padStart(2, '0')}-${String(
        1 + Math.floor(random() * 28),
      ).padStart(2, '0')}`,
    };
  });
}

/*
 * Cost model - simplified numbers, not measurements. A database reads pages,
 * not rows: PostgreSQL stores a table in 8 KB pages, and a B-tree index is a
 * tree of pages too.
 * - ROWS_PER_PAGE: about 100 rows of this users table fit in one 8 KB page.
 * - INDEX_FANOUT: one index page holds about 200 email keys. Real fan-out is
 *   "hundreds", which is why a B-tree stays 2-4 levels deep for huge tables.
 * - Times per page are chosen so 5 million rows scan in about 1.2 s and an
 *   index lookup takes about 0.3 ms, the numbers the Lesson quotes.
 */
const ROWS_PER_PAGE = 100;
const INDEX_FANOUT = 200;
const SEQ_PAGE_MS = 0.025;
const INDEX_PAGE_MS = 0.05;
const QUERY_OVERHEAD_MS = 0.1;

/** Pages per level of the B-tree, root first: [1, 2, 250] for 50,000 rows. */
function indexShape(rows: number): number[] {
  const levels = [Math.max(1, Math.ceil(rows / INDEX_FANOUT))];
  while (levels[0] > 1) levels.unshift(Math.ceil(levels[0] / INDEX_FANOUT));
  return levels;
}

const LEVEL_NAME = (level: number, count: number) =>
  level === count - 1 ? (count === 1 ? 'Root (also leaf)' : 'Leaf level') : level === 0 ? 'Root' : 'Branch level';

type Mode = 'scan' | 'index';

type Result = {
  mode: Mode;
  rowsInspected: number;
  pagesRead: number;
  timeMs: number;
  found: Row | null;
};

/** Structure updates per second one machine sustains before writes queue. */
const WRITE_CAPACITY = 3000;
/** Read particles emitted per second: a sample of the same SELECT, repeated. */
const READS_PER_SECOND = 2.5;
/** Write particles emitted per second at most, however high the write rate. */
const WRITES_ANIMATED_PER_SECOND = 5;
const PARTICLE_BUDGET = 60;

interface Moving extends Particle {
  /** The leg that crawls: the scan reading every page of the table. */
  slowLeg?: number;
  slowSpeed?: number;
  /** A write that must also update the index once it reaches the planner. */
  forkToIndex?: boolean;
}

interface State {
  particles: Moving[];
  scan: { position: number; total: number } | null;
}

const createState = (): State => ({ particles: [], scan: null });

const LAYOUT: Layout = {
  app: { x: 12, y: 156, w: 200, h: 128 },
  db: { x: 280, y: 145, w: 210, h: 151 },
  index: { x: 570, y: 30, w: 360, h: 173 },
  table: { x: 570, y: 250, w: 360, h: 160 },
};

/** Cells in the page strip drawn inside the table node. */
const STRIP_CELLS = 40;

export function IndexingLab() {
  const [running, setRunning] = useLabRunning();
  const [tableSize, setTableSize] = useState(8000);
  const [hasIndex, setHasIndex] = useState(false);
  const [target, setTarget] = useState('');
  // One result per mode, so the scan and the index lookup stay side by side
  // until the table size or the target changes. lastMode picks which one the
  // metrics strip and the insight describe.
  const [results, setResults] = useState<{ scan: Result | null; index: Result | null }>({ scan: null, index: null });
  const [lastMode, setLastMode] = useState<Mode | null>(null);
  const result = lastMode ? results[lastMode] : null;
  const clearResults = () => {
    setResults({ scan: null, index: null });
    setLastMode(null);
  };
  const [writeRate, setWriteRate] = useState(200);

  const state = useRef<State>(createState());
  const rerender = useRerender(30);
  const { events, log, clear } = useEventLog();

  const rows = useMemo(() => buildTable(tableSize), [tableSize]);
  const sample = rows[Math.floor(tableSize * 0.78)];
  const email = target || sample.email;
  const targetIndex = useMemo(() => rows.findIndex((row) => row.email === email), [rows, email]);
  // The index keeps its keys sorted, so the leaf page holding a key follows from its
  // rank in sorted order. A missing key still walks down to the leaf where it would be.
  const sortedEmails = useMemo(() => rows.map((row) => row.email).sort(), [rows]);
  const rank = useMemo(() => lowerBound(sortedEmails, email), [sortedEmails, email]);

  const tablePages = Math.ceil(tableSize / ROWS_PER_PAGE);
  const shape = indexShape(tableSize);
  const indexLevels = shape.length;
  // An index lookup reads one page per level, then one table page for the row.
  const indexPages = indexLevels + (targetIndex >= 0 ? 1 : 0);
  // The query has LIMIT 1, so a scan can stop at the row. A missing row has
  // nothing to stop at, and reads every page.
  const scanRows = targetIndex >= 0 ? targetIndex + 1 : tableSize;
  const scanPages = Math.ceil(scanRows / ROWS_PER_PAGE);

  const runQuery = useCallback(
    (mode: Mode) => {
      const found = targetIndex >= 0 ? rows[targetIndex] : null;
      const rowsInspected = mode === 'scan' ? scanRows : found ? 1 : 0;
      const pagesRead = mode === 'scan' ? scanPages : indexPages;
      const timeMs = QUERY_OVERHEAD_MS + pagesRead * (mode === 'scan' ? SEQ_PAGE_MS : INDEX_PAGE_MS);

      state.current.scan = mode === 'scan' ? { position: 0, total: scanRows } : null;

      setResults((previous) => ({
        ...previous,
        [mode]: { mode, rowsInspected, pagesRead, timeMs, found },
      }));
      setLastMode(mode);
      log(
        mode === 'scan'
          ? `Seq Scan read ${formatNumber(pagesRead)} pages (${formatNumber(rowsInspected)} rows)`
          : `Index Scan read ${pagesRead} pages: ${indexLevels} index + ${found ? 1 : 0} table`,
        mode === 'scan' ? 'warn' : 'ok',
      );
      rerender();
    },
    [targetIndex, rows, scanRows, scanPages, indexPages, indexLevels, log, rerender],
  );

  const scanState = state.current.scan;
  const scanning = scanState !== null && scanState.position < scanState.total;
  const scanPosition = scanState?.position ?? 0;

  // Animate the scanned-row counter so the cost of a full scan is felt, not just read.
  useTicker(scanning, (dt) => {
    const current = state.current.scan;
    if (!current) return;
    const step = Math.max(1, Math.round(current.total * dt * 0.9));
    current.position = Math.min(current.total, current.position + step);
    rerender();
  });

  // Every write touches the table plus one structure per index, so the index
  // doubles the structures updated and halves the write headroom.
  const structuresPerWrite = hasIndex ? 2 : 1;
  const writeOverhead = structuresPerWrite - 1;
  // About 40 bytes per entry: the email key plus a pointer to the row. Simplified.
  const indexStorageMb = (tableSize * 40) / 1_000_000;
  const structuresPerSecond = writeRate * structuresPerWrite;
  const writeLoad = computeLoad(structuresPerSecond, WRITE_CAPACITY, { baseLatencyMs: 4, kneeAt: 0.65 });

  // Background traffic: the same SELECT repeated, and the write stream.
  useTicker(running, (dt) => {
    const current = state.current;

    const reads = sampleArrivals(READS_PER_SECOND, dt);
    for (let index = 0; index < reads; index += 1) {
      if (hasIndex) {
        current.particles.push({
          id: nextParticleId(),
          route: targetIndex >= 0 ? ['app', 'db', 'index', 'table', 'db', 'app'] : ['app', 'db', 'index', 'db', 'app'],
          leg: 0,
          t: 0,
          speed: 1.8,
          outcome: 'success',
        });
      } else {
        // Illustrative speed: the table leg crawls longer the more pages it reads.
        current.particles.push({
          id: nextParticleId(),
          route: ['app', 'db', 'table', 'db', 'app'],
          leg: 0,
          t: 0,
          speed: 1.8,
          slowLeg: 1,
          slowSpeed: clamp(1.6 / Math.sqrt(scanPages / 10), 0.22, 1.6),
          outcome: 'warning',
        });
      }
    }

    const writes = sampleArrivals(writeRate, dt);
    const share = visualShare(writeRate, WRITES_ANIMATED_PER_SECOND);
    for (let index = 0; index < writes; index += 1) {
      if (Math.random() >= share) continue;
      const rejected = Math.random() < writeLoad.errorRate;
      current.particles.push({
        id: nextParticleId(),
        route: rejected ? ['app', 'db'] : ['app', 'db', 'table'],
        leg: 0,
        t: 0,
        speed: 1.5,
        outcome: rejected ? 'failure' : 'success',
        forkToIndex: !rejected && hasIndex,
      });
    }

    const alive: Moving[] = [];
    for (const particle of current.particles) {
      const speed = particle.slowLeg === particle.leg ? (particle.slowSpeed ?? particle.speed) : particle.speed;
      particle.t += speed * dt;
      if (particle.t < 1) {
        alive.push(particle);
        continue;
      }
      if (particle.leg >= particle.route.length - 2) continue;
      particle.leg += 1;
      particle.t = 0;
      // A write reaching the planner updates the index as well as the table.
      if (particle.forkToIndex && particle.route[particle.leg] === 'db') {
        alive.push({ id: nextParticleId(), route: ['db', 'index'], leg: 0, t: 0, speed: 1.5, outcome: 'success' });
      }
      alive.push(particle);
    }
    current.particles = alive.length > PARTICLE_BUDGET ? alive.slice(-PARTICLE_BUDGET) : alive;
    rerender();
  });

  const reset = () => {
    clearResults();
    state.current = createState();
    setHasIndex(false);
    setTarget('');
    setTableSize(8000);
    setWriteRate(200);
    clear();
  };

  const edges = useMemo<DiagramEdge[]>(
    () => [
      { from: 'app', to: 'db', tone: 'brand', width: 2 },
      // Writes always land in the table; without an index, every read scans it too.
      { from: 'db', to: 'table', tone: hasIndex ? 'default' : 'warn', width: hasIndex ? 1.5 : 2.5 },
      // No index yet: the part is drawn, dashed, and no request travels it.
      { from: 'db', to: 'index', tone: hasIndex ? 'ok' : 'muted', dashed: !hasIndex, width: hasIndex ? 2 : 1.5 },
      { from: 'index', to: 'table', tone: hasIndex ? 'ok' : 'muted', dashed: !hasIndex, width: hasIndex ? 2 : 1.5 },
    ],
    [hasIndex],
  );

  const particleViews: ParticleView[] = state.current.particles.map((particle) => ({
    id: particle.id,
    from: particle.route[particle.leg],
    to: particle.route[particle.leg + 1],
    t: particle.t,
    outcome: particle.outcome ?? 'success',
  }));

  // Page strip: which table pages the last query read.
  const pagesPerCell = Math.max(1, tablePages / STRIP_CELLS);
  const cells = Math.min(STRIP_CELLS, tablePages);
  const scanPagesSoFar = scanning ? Math.ceil(scanPosition / ROWS_PER_PAGE) : (results.scan?.pagesRead ?? 0);
  const showScan = lastMode === 'scan' || scanning;
  const heapCell = targetIndex >= 0 ? Math.floor(Math.floor(targetIndex / ROWS_PER_PAGE) / pagesPerCell) : -1;

  const plan = hasIndex ? 'Index Scan' : 'Seq Scan';
  const pagesPerRead = hasIndex ? indexPages : scanPages;
  // Colour follows what a read cost, measured against one index lookup: a scan that stops on an early row is cheap too.
  const costTone = (pages: number): 'ok' | 'warn' | 'danger' =>
    pages <= indexPages ? 'ok' : pages <= indexPages * 10 ? 'warn' : 'danger';
  const resultTone = result ? costTone(result.pagesRead) : 'neutral';

  return (
    <LabShell
      title="Database Indexing Lab"
      description={`A users table with ${formatNumber(tableSize)} rows in ${formatNumber(tablePages)} pages. Find one row with and without an index, and see what the index costs on writes.`}
      running={running}
      onRunningChange={setRunning}
      onReset={reset}
      events={events}
      legend={
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
          <ParticleLegend outcomes={['success', 'warning', 'failure']} />
          <span className="text-[11px] text-faint">
            Circle: an index read or a write. Triangle: a read doing a full scan. Cross: a write rejected over capacity.
          </span>
        </div>
      }
      actions={
        <>
          <Button variant="secondary" onClick={() => runQuery('scan')}>
            <Search className="h-4 w-4" />
            Run without index
          </Button>
          <Button
            variant={hasIndex ? 'primary' : 'secondary'}
            onClick={() => {
              if (!hasIndex) {
                setHasIndex(true);
                log('CREATE INDEX idx_users_email - reads switch to the index path', 'info');
              }
              runQuery('index');
            }}
          >
            <Zap className="h-4 w-4" />
            {hasIndex ? 'Run with index' : 'Create index on email'}
          </Button>
          {hasIndex ? (
            <Button
              variant="danger"
              onClick={() => {
                setHasIndex(false);
                log('DROP INDEX idx_users_email - reads fall back to a full scan', 'warn');
                // The index is gone, so its result no longer describes anything.
                // The scan result still does, and stays.
                setResults((previous) => ({ ...previous, index: null }));
                setLastMode((mode) => (mode === 'index' ? (results.scan ? 'scan' : null) : mode));
              }}
            >
              <Trash2 className="h-4 w-4" />
              Drop index
            </Button>
          ) : null}
        </>
      }
      insight={
        <Insight>
          {result?.mode === 'index' ? (
            <>
              The index lookup read {result.pagesRead} pages: one per index level ({indexLevels}), then{' '}
              {result.found ? 'one table page to fetch the row' : 'nothing more, because the key is not in the index'}.
              The full scan reads up to {formatNumber(tablePages)} pages. The cost is on the other side: every INSERT,
              UPDATE and DELETE must now also maintain this index, and it takes roughly {indexStorageMb.toFixed(1)} MB.
            </>
          ) : result?.mode === 'scan' ? (
            <>
              A sequential scan read {formatNumber(result.pagesRead)} pages ({formatNumber(result.rowsInspected)} rows) to
              find one row. Doubling the table doubles the work - this is O(n). An index needs {indexLevels}{' '}
              index pages at this size, and one more level only when the table grows about {INDEX_FANOUT} times.
            </>
          ) : (
            <>
              Run the query both ways. The interesting number is not the milliseconds but the growth: a scan reads more
              pages with every row added, a B-tree lookup reads one page per level, and levels are added very rarely.
            </>
          )}
        </Insight>
      }
      metrics={
        <>
          <MetricsPanel
            items={[
              {
                key: 'pagesRead',
                label: 'Pages read',
                value: result ? formatNumber(scanning && result.mode === 'scan' ? scanPagesSoFar : result.pagesRead) : '-',
                tone: resultTone,
                hint: 'The database reads 8 KB pages, not rows. About 100 rows per table page here (simplified).',
                simulated: true,
              },
              {
                key: 'rowsScanned',
                label: 'Rows inspected',
                value: result ? formatNumber(scanning && result.mode === 'scan' ? scanPosition : result.rowsInspected) : '-',
                tone: resultTone,
              },
              {
                key: 'queryTime',
                label: 'Query time',
                value: result ? formatLatency(result.timeMs) : '-',
                tone: resultTone,
                hint: 'Estimated from pages read - the shape of the curve is what matters, not the exact number.',
                simulated: true,
              },
              { key: 'tableSize', label: 'Table rows', value: formatNumber(tableSize), hint: 'Rows in the users table.' },
              {
                key: 'levels',
                label: 'Index levels',
                value: hasIndex ? indexLevels : '-',
                hint: `One page read per level. About ${INDEX_FANOUT} keys per index page (simplified), so each level multiplies the reach by ${INDEX_FANOUT}.`,
                simulated: true,
              },
              {
                key: 'writeCost',
                label: 'Write overhead',
                value: hasIndex ? `+${Math.round(writeOverhead * 100)}%` : '0%',
                tone: hasIndex ? 'warn' : 'ok',
                hint: 'Extra structures updated per INSERT/UPDATE/DELETE: the table, plus one per index.',
                simulated: true,
              },
              {
                key: 'writeLatency',
                label: 'Write latency',
                value: formatLatency(writeLoad.latencyMs),
                tone: writeLoad.saturated ? 'danger' : writeLoad.cpu > 0.7 ? 'warn' : 'ok',
                hint: 'Time per INSERT at the current write rate. An index is paid for here.',
                simulated: true,
              },
              {
                key: 'storage',
                label: 'Index storage',
                value: hasIndex ? `${indexStorageMb.toFixed(1)} MB` : '0 MB',
                tone: hasIndex ? 'warn' : 'neutral',
                hint: 'About 40 bytes per row (key plus row pointer, simplified). Indexes must fit in memory to stay fast.',
                simulated: true,
              },
            ]}
          />

          <div className="card p-4">
            <p className="label mb-3">
              Index on users(email){hasIndex ? ', the pages one lookup reads' : ' - not created yet'}
            </p>
            <BTreeView
              shape={shape}
              rank={Math.min(rank, tableSize - 1)}
              email={email}
              heapPage={targetIndex >= 0 ? Math.floor(targetIndex / ROWS_PER_PAGE) + 1 : null}
              active={hasIndex}
            />
            <p className="mt-3 text-xs text-faint">
              {hasIndex
                ? `One page per level, root to leaf, then one table page for the row: ${indexPages} pages, not ${formatNumber(tablePages)}.`
                : 'What CREATE INDEX would build. Until then every read scans the table pages.'}{' '}
              Simplified: about {INDEX_FANOUT} keys per index page and {ROWS_PER_PAGE} rows per table page, so{' '}
              {formatNumber(tableSize)} rows need {indexLevels} {indexLevels === 1 ? 'level' : 'levels'}; a table{' '}
              {INDEX_FANOUT} times bigger needs one more.
            </p>
          </div>

          <div className="card overflow-hidden">
            <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
              <p className="label">users table</p>
              <p className="font-mono text-[11px] text-faint">
                {scanning
                  ? `scanning row ${formatNumber(scanPosition)} / ${formatNumber(scanState?.total ?? 0)}`
                  : 'idle'}
              </p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-left font-mono text-[11px]">
                <thead className="bg-elevated text-faint">
                  <tr>
                    <th className="px-4 py-2 font-medium">id</th>
                    <th className="px-4 py-2 font-medium">name</th>
                    <th className="px-4 py-2 font-medium">email</th>
                    <th className="px-4 py-2 font-medium">country</th>
                    <th className="px-4 py-2 font-medium">created_at</th>
                  </tr>
                </thead>
                <tbody>
                  <VisibleRows rows={rows} scanning={scanning} scanPosition={scanPosition} email={email} showHit={Boolean(result)} />
                </tbody>
              </table>
            </div>
          </div>
        </>
      }
      controls={
        <>
          <Slider
            label="Table size"
            value={tableSize}
            min={1000}
            max={50000}
            step={1000}
            onChange={(value) => {
              setTableSize(value);
              // The chosen email encodes a row number, so it may not exist in
              // the resized table - the Select would show another option while
              // the query silently searched for a row that is gone.
              setTarget('');
              clearResults();
              state.current.scan = null;
            }}
            format={(value) => `${formatNumber(value)} rows`}
            hint="Scan cost grows with this number. Index cost barely moves."
          />
          <Select
            label="Search for"
            value={email}
            options={[
              { value: sample.email, label: `${sample.email} (row ${sample.id})` },
              { value: rows[Math.floor(tableSize * 0.15)].email, label: 'an early row' },
              { value: rows[tableSize - 1].email, label: 'the last row (worst case)' },
              { value: 'missing@example.com', label: 'a row that does not exist' },
            ]}
            onChange={(value) => {
              setTarget(value);
              clearResults();
              state.current.scan = null;
            }}
            hint="LIMIT 1 lets a scan stop at the row. A missing row forces a full scan - there is nothing to stop at."
          />
          <Slider
            label="Write rate"
            value={writeRate}
            min={0}
            max={2000}
            step={50}
            onChange={setWriteRate}
            format={(value) => `${formatNumber(value)} writes/sec`}
            hint="Every write must update every index on the table."
          />
          <div className="border-t border-line pt-4">
            <p className="label mb-2">Write path cost</p>
            <Meter
              value={writeLoad.cpu}
              tone={writeLoad.saturated ? 'danger' : hasIndex ? 'warn' : 'ok'}
              label={hasIndex ? 'table + 1 index' : 'table only'}
            />
            <p className="mt-2 font-mono text-[11px] text-muted">
              {formatNumber(writeRate)} writes/sec {'->'} {formatNumber(structuresPerSecond)} structures updated/sec of{' '}
              {formatNumber(WRITE_CAPACITY)} (simplified)
            </p>
            {writeLoad.saturated ? (
              <p className="mt-1 text-[11px] text-danger">
                Over write capacity. Dropping the index would bring this back under the line - that is the trade the
                query time above is buying.
              </p>
            ) : null}
          </div>
          <div className="flex items-start gap-2 text-[11px] text-muted">
            <Database className="mt-0.5 h-3.5 w-3.5 shrink-0 text-faint" />
            <span>
              An index on a low-selectivity column (a boolean, a status with three values) usually will not be used -
              the planner correctly decides a scan is cheaper.
            </span>
          </div>
        </>
      }
    >
      <DiagramCanvas
        layout={LAYOUT}
        edges={edges}
        particles={particleViews}
        height={430}
        className="bg-canvas"
        underlay={
          <g>
            <rect
              x={250}
              y={10}
              width={700}
              height={412}
              rx={16}
              fill="none"
              strokeDasharray="6 5"
              strokeWidth={1.5}
              className="stroke-line"
            />
            <text x={266} y={30} className="fill-faint font-mono" style={{ fontSize: 11 }}>
              One PostgreSQL database
            </text>
          </g>
        }
      >
        <ArchNode kind="server" title="App server" subtitle="SELECT by email, LIMIT 1" placed={LAYOUT.app}>
          <NodeStatRow label="Reads" value="repeated" />
          <NodeStatRow label="Writes" value={`${formatNumber(writeRate)}/s`} />
        </ArchNode>
        <ArchNode
          kind="sql"
          title="Query planner"
          subtitle={hasIndex ? 'picks Index Scan' : 'no index: Seq Scan'}
          placed={LAYOUT.db}
          alert={writeLoad.saturated}
          status={writeLoad.saturated ? 'degraded' : 'healthy'}
        >
          <NodeStatRow label="Plan" value={plan} tone={hasIndex ? 'text-ok' : 'text-warn'} />
          <NodeStatRow label="Pages per read" value={formatNumber(pagesPerRead)} tone={hasIndex ? 'text-ok' : 'text-warn'} />
          <NodeStatRow
            label="Write latency"
            value={formatLatency(writeLoad.latencyMs)}
            tone={writeLoad.saturated ? 'text-danger' : 'text-ink'}
          />
        </ArchNode>
        <ArchNode
          kind="search"
          title="idx_users_email"
          subtitle={hasIndex ? `B-tree, about ${INDEX_FANOUT} keys per page` : 'not created yet'}
          placed={LAYOUT.index}
          status={hasIndex ? 'healthy' : 'down'}
          statusLabel={hasIndex ? 'In use' : 'Not created'}
        >
          {shape.map((pages, level) => (
            <NodeStatRow
              key={level}
              label={LEVEL_NAME(level, shape.length)}
              value={`read 1 of ${formatNumber(pages)} ${pages === 1 ? 'page' : 'pages'}`}
              tone={hasIndex ? 'text-ok' : 'text-faint'}
            />
          ))}
          <NodeStatRow
            label="Then the row"
            value={targetIndex >= 0 ? '1 table page' : 'key not found, stop'}
            tone={hasIndex ? 'text-ok' : 'text-faint'}
          />
        </ArchNode>
        <ArchNode
          kind="storage"
          title="users table"
          subtitle={`${formatNumber(tablePages)} pages of ${ROWS_PER_PAGE} rows`}
          placed={LAYOUT.table}
          alert={!hasIndex}
        >
          <div className="flex flex-wrap gap-[3px]" aria-label="Table pages read by the last query">
            {Array.from({ length: cells }, (_, cell) => {
              const read = showScan && cell < Math.ceil(scanPagesSoFar / pagesPerCell);
              const fetched = !showScan && lastMode === 'index' && cell === heapCell;
              return (
                <span
                  key={cell}
                  className={cn('h-2.5 w-[5px] rounded-[2px]', read ? 'bg-warn' : fetched ? 'bg-ok' : 'bg-line')}
                />
              );
            })}
          </div>
          <NodeStatRow
            label={pagesPerCell > 1 ? `1 bar = ${formatNumber(pagesPerCell)} pages` : '1 bar = 1 page'}
            value={
              showScan
                ? `${formatNumber(scanPagesSoFar)} pages scanned`
                : lastMode === 'index'
                  ? result?.found
                    ? '1 page fetched'
                    : 'no page fetched'
                  : 'run a query'
            }
            tone={showScan ? 'text-warn' : lastMode === 'index' ? 'text-ok' : 'text-faint'}
          />
        </ArchNode>
      </DiagramCanvas>

      <div className="grid gap-4 p-5 lg:grid-cols-2">
        <QueryPanel
          title="Without index"
          subtitle="Sequential scan"
          sql={`SELECT * FROM users\nWHERE email = '${email}'\nLIMIT 1;`}
          plan={`Limit\n  -> Seq Scan on users\n       Filter: (email = '...')\n       Rows Removed by Filter: ${formatNumber(
            results.scan
              ? Math.max(0, results.scan.rowsInspected - (results.scan.found ? 1 : 0))
              : Math.max(0, scanRows - (targetIndex >= 0 ? 1 : 0)),
          )}`}
          pages={results.scan ? (scanning ? scanPagesSoFar : results.scan.pagesRead) : null}
          time={results.scan ? results.scan.timeMs : null}
          tone={results.scan ? costTone(results.scan.pagesRead) : 'neutral'}
        />
        <QueryPanel
          title="With index"
          subtitle={hasIndex ? 'Index scan on users(email)' : 'No index created yet'}
          sql={`CREATE INDEX idx_users_email\n  ON users (email);\n\nSELECT * FROM users\nWHERE email = '${email}'\nLIMIT 1;`}
          plan={
            hasIndex
              ? `Limit\n  -> Index Scan using idx_users_email on users\n       Index Cond: (email = '...')`
              : 'Create the index to see the plan change.'
          }
          pages={results.index ? results.index.pagesRead : null}
          time={results.index ? results.index.timeMs : null}
          tone={results.index ? costTone(results.index.pagesRead) : 'neutral'}
        />
      </div>
    </LabShell>
  );
}

/** First position in a sorted list whose value is not below the key. */
function lowerBound(sorted: string[], key: string) {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (sorted[middle] < key) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** Page chips drawn per level; a wide level shows a window around the page on the path. */
const TREE_CHIPS = 7;

/**
 * The B-tree of idx_users_email as pages, root first. Each level shows the page the
 * lookup reads, among the pages of that level; the last row is the table page the
 * row lives in. Same simplified model as the cost numbers.
 */
function BTreeView({
  shape,
  rank,
  email,
  heapPage,
  active,
}: {
  shape: number[];
  rank: number;
  email: string;
  heapPage: number | null;
  active: boolean;
}) {
  // Leaf page holding the key, then its parent on each level above.
  const path: number[] = [];
  let page = Math.floor(rank / INDEX_FANOUT);
  for (let level = shape.length - 1; level >= 0; level -= 1) {
    path[level] = Math.min(page, shape[level] - 1);
    page = Math.floor(page / INDEX_FANOUT);
  }
  const chip = (onPath: boolean) =>
    cn(
      'rounded-md border px-2 py-1 font-mono text-[11px]',
      onPath && active ? 'border-brand bg-brand/10 text-brand' : 'border-line text-faint',
    );
  return (
    <div className="space-y-2 overflow-x-auto">
      {shape.map((pages, level) => {
        const start = clamp(path[level] - Math.floor(TREE_CHIPS / 2), 0, Math.max(0, pages - TREE_CHIPS));
        const end = Math.min(pages, start + TREE_CHIPS);
        const leaf = level === shape.length - 1;
        return (
          <div key={level} className="flex min-w-max items-center gap-2">
            <span className="w-32 shrink-0 text-[11px] text-muted">
              {LEVEL_NAME(level, shape.length)}
              <span className="text-faint">
                {' '}
                ({formatNumber(pages)} {pages === 1 ? 'page' : 'pages'})
              </span>
            </span>
            {start > 0 ? <span className="font-mono text-[11px] text-faint">+{formatNumber(start)}</span> : null}
            {Array.from({ length: end - start }, (_, offset) => {
              const index = start + offset;
              const onPath = index === path[level];
              return (
                <span key={index} className={chip(onPath)}>
                  {leaf && onPath ? (email.length > 14 ? `${email.slice(0, 13)}...` : email) : `page ${index + 1}`}
                </span>
              );
            })}
            {end < pages ? <span className="font-mono text-[11px] text-faint">+{formatNumber(pages - end)}</span> : null}
          </div>
        );
      })}
      <div className="flex min-w-max items-center gap-2">
        <span className="w-32 shrink-0 text-[11px] text-muted">Table (heap)</span>
        <span className={chip(heapPage !== null)}>{heapPage !== null ? `page ${formatNumber(heapPage)}` : 'key not found, stop'}</span>
      </div>
    </div>
  );
}

function VisibleRows({
  rows,
  scanning,
  scanPosition,
  email,
  showHit,
}: {
  rows: Row[];
  scanning: boolean;
  scanPosition: number;
  email: string;
  showHit: boolean;
}) {
  const start = scanning ? Math.max(0, scanPosition - 6) : 0;
  return (
    <>
      {rows.slice(start, start + 12).map((row) => {
        const isTarget = row.email === email;
        const isCurrent = scanning && row.id === scanPosition;
        return (
          <tr
            key={row.id}
            className={cn('border-t border-line', isCurrent && 'bg-warn/15', isTarget && showHit && !scanning && 'bg-ok/15')}
          >
            <td className="px-4 py-1.5 text-faint">{row.id}</td>
            <td className="px-4 py-1.5 text-muted">{row.name}</td>
            <td className={cn('px-4 py-1.5', isTarget ? 'font-semibold text-brand' : 'text-ink')}>{row.email}</td>
            <td className="px-4 py-1.5 text-muted">{row.country}</td>
            <td className="px-4 py-1.5 text-faint">{row.createdAt}</td>
          </tr>
        );
      })}
    </>
  );
}

const QUERY_TONE = { ok: 'text-ok', warn: 'text-warn', danger: 'text-danger', neutral: 'text-ink' } as const;

function QueryPanel({
  title,
  subtitle,
  sql,
  plan,
  pages,
  time,
  tone,
}: {
  title: string;
  subtitle: string;
  sql: string;
  plan: string;
  pages: number | null;
  time: number | null;
  tone: 'ok' | 'warn' | 'danger' | 'neutral';
}) {
  const valueClass = cn('font-mono text-lg font-semibold', QUERY_TONE[tone]);
  return (
    // min-w-0: in the one-column phone grid the SQL would otherwise widen the panel past its card, which clips it.
    <div className="min-w-0 rounded-2xl border border-line p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-2">
        <h3 className="text-sm font-semibold text-ink">{title}</h3>
        <span className="text-[11px] text-faint">{subtitle}</span>
      </div>
      <pre className="ascii mt-3">{sql}</pre>
      <pre className="ascii mt-2 text-[11px]">{plan}</pre>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <div>
          <p className="label">Pages read</p>
          <p className={valueClass}>
            {pages === null ? '-' : formatNumber(pages)}
          </p>
        </div>
        <div>
          <p className="label">Query time</p>
          <p className={valueClass}>
            {time === null ? '-' : formatLatency(time)}
          </p>
        </div>
      </div>
    </div>
  );
}

export default IndexingLab;
