// A relative path, not the @/ alias: requirementsArchitecture.test.ts reads these specs on Node.
import type { VisualSpec } from '../../components/architecture/FlowVisual.tsx';

/** Getting started, plus the remaining quality-attribute concepts. */
export const foundationVisuals: Record<string, VisualSpec> = {
  'what-is-system-design': {
    // The Requirements Lab on this Concept at round 2 of the loop, shortened: Instagram at 10M daily
    // users after round 1 put more app servers behind a load balancer, with the Database now red for
    // feed reads. The same parts under the same names and stat rows (Object storage and Queue +
    // workers are left out); every number is the sizing model (requirementsBottleneck.ts), and a
    // test holds each stat row to the Lab. The steps before round 1 was fixed never travel a wire
    // through the Load balancer: the Lab has none until that fix, so they stay on one part. The
    // nodes show round 2, so a caption about an earlier round names its users ("at 100k", "1M
    // users") and is held to the Lab at that round; every other caption agrees with the nodes.
    width: 800,
    height: 320,
    caption:
      'Instagram, one bottleneck at a time: at 1M daily users the App server passed its limit; at 10M the Database passes 10,000 reads/s.',
    nodes: [
      { id: 'users', kind: 'client', label: 'Users', sub: '10M daily users', x: 16, y: 112, w: 150, h: 95, stat: ['Peak', '~17.4K req/s'] },
      { id: 'lb', kind: 'load-balancer', label: 'Load balancer x2', sub: 'round 1 fix', x: 196, y: 115, w: 176, h: 90 },
      { id: 'api', kind: 'server', label: 'App servers x27', sub: 'stateless now', x: 402, y: 112, w: 180, h: 95, stat: ['Peak load', '~17.4K req/s'] },
      {
        id: 'db',
        kind: 'sql',
        label: 'Database',
        sub: 'one copy, feed reads',
        x: 606,
        y: 112,
        w: 186,
        h: 95,
        status: 'overloaded',
        statusLabel: 'Over its limit',
        stat: ['Peak reads', '~16.5K of 10K/s'],
      },
    ],
    edges: [
      { from: 'users', to: 'lb', tone: 'brand', rate: 1.6 },
      { from: 'lb', to: 'api', tone: 'brand', rate: 1.6 },
      { from: 'api', to: 'db', tone: 'brand', rate: 1.4 },
    ],
    steps: [
      { from: 'users', to: 'users', label: 'Requirements: post, feed, follow, like' },
      { from: 'api', to: 'db', label: 'Simplest design at 100k: one server' },
      { from: 'api', to: 'api', label: '1M users: App server over limit', outcome: 'failure' },
      { from: 'lb', to: 'api', label: 'Add one component: more servers' },
      { from: 'api', to: 'api', label: 'Its cost: servers must be stateless', outcome: 'warning' },
      { from: 'api', to: 'db', label: 'Repeat at 10M: Database reads over', outcome: 'failure' },
      { from: 'db', to: 'db', label: 'Next: cache, replicas or bigger machine' },
    ],
  },

  'functional-requirements': {
    // The Requirements Lab on this Concept, shortened: WhatsApp at relaxed targets, the same parts
    // under the same names, each named by the feature that forced it; calls are not picked, so the
    // Media servers stay grey and unbuilt.
    width: 760,
    height: 320,
    caption: 'Each picked feature pulls in the parts it needs. An unpicked one builds nothing.',
    nodes: [
      { id: 'users', kind: 'client', label: 'Users', sub: '1k daily users', x: 20, y: 120, w: 160, h: 80 },
      { id: 'media', kind: 'server', label: 'Media servers', sub: 'for calls', x: 20, y: 230, w: 170, h: 80, status: 'down', statusLabel: 'Not built' },
      { id: 'api', kind: 'server', label: 'App server', sub: 'for send', x: 280, y: 120, w: 170, h: 80 },
      { id: 'ws', kind: 'service', label: 'WebSocket server', sub: 'for live delivery', x: 280, y: 230, w: 200, h: 80 },
      { id: 'db', kind: 'sql', label: 'Database', sub: 'for send', x: 560, y: 20, w: 180, h: 80 },
      { id: 'async', kind: 'queue', label: 'Queue + workers', sub: 'for group fan-out', x: 560, y: 120, w: 180, h: 80 },
    ],
    edges: [
      { from: 'users', to: 'api', tone: 'brand', rate: 1.4 },
      { from: 'api', to: 'db', tone: 'brand', rate: 1.4 },
      { from: 'api', to: 'ws', tone: 'violet', rate: 1.2 },
      { from: 'ws', to: 'users', tone: 'violet', rate: 1.2 },
      { from: 'api', to: 'async', tone: 'info', rate: 1 },
      { from: 'async', to: 'ws', tone: 'violet', rate: 1 },
      { from: 'users', to: 'media', tone: 'muted', dashed: true },
    ],
    steps: [
      { from: 'users', to: 'api', label: 'Send needs an App server' },
      { from: 'api', to: 'db', label: 'Each message stored in Database' },
      { from: 'api', to: 'ws', label: 'Live delivery needs a WebSocket server' },
      { from: 'ws', to: 'users', label: 'Pushed down the open connection' },
      { from: 'api', to: 'async', label: 'Groups need Queue + workers' },
      { from: 'async', to: 'ws', label: 'Workers copy it to every member' },
      { from: 'users', to: 'media', label: 'Calls not picked: nothing built', skipped: true },
    ],
  },

  'non-functional-requirements': {
    // The Requirements Lab on this Concept after raising Availability to 99.99%: Uber, the same
    // parts under the same names and stat rows, shortened to the ride request and its live
    // tracking (the Geo index x3 and Queue + workers x3 are left out, and the caption says so). The
    // Lab draws zones as an underlay, not a part, so here they live in the subtitles. x3 is
    // `relativeCost` for that setup (requirementsCost.ts), inside the 2-3x a test holds it to.
    width: 800,
    height: 320,
    caption: '99.99% for Uber ride requests: every tier copied into 3 zones (the geo index and queue too, not drawn here) and a database standby promoted automatically. Monthly cost x1 -> x3 (simplified model).',
    nodes: [
      { id: 'users', kind: 'client', label: 'Users', sub: '1k daily users', x: 16, y: 112, w: 150, h: 95, stat: ['Peak', '~32 req/s'] },
      { id: 'lb', kind: 'load-balancer', label: 'Load balancer x2', sub: 'skips a dead server', x: 196, y: 115, w: 176, h: 90 },
      { id: 'api', kind: 'server', label: 'App servers x3', sub: 'one in each of 3 zones', x: 402, y: 20, w: 196, h: 95, stat: ['1 for load', '+2 for 99.99%'] },
      { id: 'ws', kind: 'service', label: 'WebSocket x3', sub: 'one in each of 3 zones', x: 402, y: 205, w: 196, h: 95, stat: ['1 for load', '+2 for 99.99%'] },
      { id: 'db', kind: 'sql', label: 'Database x2', sub: 'primary + standby', x: 628, y: 20, w: 164, h: 95, statusLabel: 'Reads: any copy', stat: ['Peak writes', '<1/s'] },
    ],
    edges: [
      { from: 'users', to: 'lb', tone: 'brand', rate: 1.4 },
      { from: 'lb', to: 'api', tone: 'brand', rate: 1.4 },
      { from: 'api', to: 'db', tone: 'brand', rate: 1.2 },
      { from: 'api', to: 'ws', tone: 'violet', rate: 1 },
      { from: 'ws', to: 'lb', tone: 'violet', rate: 1 },
    ],
    steps: [
      { from: 'users', to: 'lb', label: 'Ride request reaches the balancer pair' },
      { from: 'lb', to: 'api', label: 'Health check skips a dead server' },
      { from: 'lb', to: 'api', label: 'One app server per zone' },
      { from: 'api', to: 'ws', label: 'One WebSocket server per zone' },
      { from: 'ws', to: 'lb', label: 'Driver position streamed to rider' },
      { from: 'api', to: 'db', label: 'Trip stored, copied to standby' },
      { from: 'db', to: 'db', label: 'Primary dies: standby promoted automatically', outcome: 'warning' },
      { from: 'api', to: 'api', label: 'Monthly cost: x1 becomes x3', outcome: 'warning' },
    ],
  },

  'capacity-estimation': {
    width: 786,
    height: 300,
    // Every number is what the Capacity Lab shows on the capacity-estimation Lab focus (exact mode).
    caption: '10M DAU x 20 = 200M requests/day = 2,315 req/sec average, 11,574 at peak: 18 app servers, 40 GB a day, 219 TB after 5 years x 3 copies.',
    nodes: [
      { id: 'clients', kind: 'client', label: 'Clients', sub: '10M DAU x 20/day', x: 10, y: 102, w: 161, h: 95, stat: ['Average', '2,315/s'] },
      { id: 'lb', kind: 'load-balancer', label: 'Load balancer', sub: 'pair, sees all traffic', x: 192, y: 102, w: 176, h: 95, stat: ['Peak', '11,574 req/s'] },
      { id: 'app', kind: 'server', label: 'App tier x 18', sub: '1,000 req/s each', x: 389, y: 102, w: 191, h: 95, stat: ['Needed at peak', '12'] },
      { id: 'db', kind: 'sql', label: 'Database', sub: 'primary + read replicas', x: 604, y: 10, w: 178, h: 95, stat: ['Peak writes', '1,157/s'] },
      { id: 'store', kind: 'storage', label: 'Object storage', sub: '2 KB per write', x: 604, y: 195, w: 178, h: 95, stat: ['5 yr x 3 copies', '219 TB'] },
    ],
    edges: [
      { from: 'clients', to: 'lb', tone: 'brand', rate: 3 },
      { from: 'lb', to: 'app', tone: 'brand', rate: 3 },
      { from: 'app', to: 'db', tone: 'default', rate: 1.5 },
      { from: 'app', to: 'store', tone: 'default', rate: 1.5 },
    ],
    steps: [
      { from: 'clients', to: 'lb', label: 'Users x 20 = 200M/day' },
      { from: 'clients', to: 'lb', label: 'Divide by 86,400: 2,315/sec' },
      { from: 'lb', to: 'app', label: 'Times 5 at peak: 11,574/sec', outcome: 'warning' },
      { from: 'lb', to: 'app', label: '1,000 each: 12, x 1.5: 18' },
      { from: 'app', to: 'db', label: '10% writes: 1,157/sec peak' },
      { from: 'app', to: 'store', label: '2 KB each: 40 GB/day' },
      { from: 'app', to: 'store', label: 'Times 365: 15 TB/year' },
      { from: 'app', to: 'store', label: 'Keep 5 years: 73 TB' },
      { from: 'app', to: 'store', label: 'Times 3 copies: 219 TB' },
    ],
  },

  'back-of-the-envelope': {
    width: 760,
    height: 300,
    caption: 'One request: the ocean round trip (~150 ms) costs 300x the datacenter hop and over 1,000x the SSD read.',
    nodes: [
      { id: 'user', kind: 'client', label: 'User in Europe', sub: 'app runs in the US', x: 20, y: 104, w: 170, h: 95, stat: ['round trip', '~150 ms'], alert: true },
      { id: 'app', kind: 'server', label: 'App server', sub: 'US datacenter', x: 230, y: 110, w: 150, h: 80 },
      { id: 'db', kind: 'sql', label: 'Database', sub: 'same datacenter', x: 420, y: 104, w: 150, h: 95, stat: ['hop', '~0.5 ms'] },
      { id: 'ram', kind: 'cache', label: 'RAM', sub: 'page in memory', x: 610, y: 20, w: 140, h: 95, stat: ['read', '~100 ns'] },
      { id: 'ssd', kind: 'storage', label: 'SSD', sub: 'page on disk', x: 610, y: 190, w: 140, h: 95, stat: ['read', '~100 us'] },
    ],
    edges: [
      { from: 'user', to: 'app', tone: 'danger', rate: 1, outcome: 'warning' },
      { from: 'app', to: 'db', tone: 'brand', rate: 2 },
      { from: 'db', to: 'ram', tone: 'ok', rate: 3, outcome: 'cache-hit' },
      { from: 'db', to: 'ssd', tone: 'warn', rate: 1 },
    ],
    steps: [
      { from: 'user', to: 'app', label: 'Ocean round trip: ~150 ms', outcome: 'warning' },
      { from: 'app', to: 'db', label: 'Same-datacenter hop: ~0.5 ms' },
      { from: 'db', to: 'ram', label: 'Page in RAM: ~100 ns', outcome: 'cache-hit' },
      { from: 'db', to: 'ssd', label: 'Miss: SSD read, ~100 us' },
    ],
  },

  // ---- Quality attributes -------------------------------------------------
  availability: {
    width: 760,
    height: 280,
    caption: 'Dependencies in series multiply: 99.99% x 99.9% x 99.9% is about 99.79%.',
    nodes: [
      { id: 'lb', kind: 'load-balancer', label: 'LB', sub: '99.99%', x: 40, y: 100, w: 140, h: 80 },
      { id: 'api', kind: 'server', label: 'API', sub: '99.9%', x: 230, y: 100, w: 140, h: 80 },
      { id: 'db', kind: 'sql', label: 'Database', sub: '99.9%', x: 420, y: 100, w: 150, h: 80 },
      { id: 'total', kind: 'monitoring', label: '~99.79%', sub: '18 h/year down', x: 607, y: 100, w: 135, h: 80, alert: true },
    ],
    edges: [
      { from: 'lb', to: 'api', tone: 'ok', rate: 2.4 },
      { from: 'api', to: 'db', tone: 'ok', rate: 2.4 },
      { from: 'db', to: 'total', tone: 'warn', rate: 2, outcome: 'warning' },
    ],
    steps: [
      { from: 'lb', to: 'api', label: 'LB hands the request on' },
      { from: 'api', to: 'db', label: 'API cannot answer without DB' },
      { from: 'db', to: 'total', label: 'Multiply: 99.79%, 18 h down', outcome: 'warning' },
    ],
  },

  consistency: {
    width: 760,
    height: 290,
    caption: 'Same write, three contracts about what a reader may see next.',
    nodes: [
      { id: 'write', kind: 'client', label: 'write(x = 2)', x: 40, y: 105, w: 160, h: 78 },
      { id: 'lin', kind: 'sql', label: 'Linearizable', sub: 'everyone sees 2', x: 300, y: 15, w: 190, h: 80 },
      { id: 'ryw', kind: 'sql', label: 'Read-your-writes', sub: 'the writer sees 2', x: 300, y: 105, w: 190, h: 80 },
      { id: 'eventual', kind: 'nosql', label: 'Eventual', sub: 'someone still sees 1', x: 300, y: 195, w: 190, h: 80, alert: true },
      { id: 'reader', kind: 'client', label: 'Reader', x: 580, y: 105, w: 150, h: 78 },
    ],
    edges: [
      { from: 'write', to: 'lin', tone: 'ok', rate: 1.6 },
      { from: 'write', to: 'ryw', tone: 'ok', rate: 1.6 },
      { from: 'write', to: 'eventual', tone: 'ok', rate: 1.6 },
      { from: 'lin', to: 'reader', tone: 'ok', rate: 1.4 },
      { from: 'eventual', to: 'reader', tone: 'warn', rate: 1.4, outcome: 'warning' },
    ],
    steps: [
      { from: 'write', to: 'lin', label: 'Write to a linearizable store' },
      { from: 'lin', to: 'reader', label: 'Every reader now sees 2' },
      { from: 'write', to: 'ryw', label: 'Same write, read-your-writes store' },
      { from: 'ryw', to: 'write', label: 'Only the writer must see 2' },
      { from: 'write', to: 'eventual', label: 'Same write, eventual store' },
      { from: 'eventual', to: 'reader', label: 'Another reader still sees 1', outcome: 'warning' },
    ],
  },

  'partition-tolerance': {
    width: 760,
    height: 330,
    caption: 'Only the side holding a majority may accept writes; the cut-off minority refuses them.',
    nodes: [
      { id: 'client', kind: 'client', label: 'Client', x: 30, y: 128, w: 130, h: 74 },
      { id: 'a', kind: 'sql', label: 'Node A', sub: 'leader', x: 240, y: 123, w: 150, h: 84 },
      { id: 'b', kind: 'sql', label: 'Node B', sub: 'majority side', x: 550, y: 4, w: 180, h: 74 },
      { id: 'c', kind: 'sql', label: 'Node C', sub: 'majority side', x: 550, y: 86, w: 180, h: 74 },
      { id: 'd', kind: 'sql', label: 'Node D', sub: 'minority: no writes', x: 550, y: 168, w: 180, h: 74, status: 'degraded' },
      { id: 'e', kind: 'sql', label: 'Node E', sub: 'minority: no writes', x: 550, y: 250, w: 180, h: 74, status: 'degraded' },
    ],
    edges: [
      { from: 'client', to: 'a', tone: 'brand', rate: 1.6 },
      { from: 'a', to: 'b', tone: 'ok', rate: 1.6 },
      { from: 'a', to: 'c', tone: 'ok', rate: 1.6 },
      { from: 'a', to: 'd', tone: 'danger', dashed: true, label: 'X partition X' },
      { from: 'a', to: 'e', tone: 'danger', dashed: true },
    ],
    steps: [
      { from: 'client', to: 'a', label: 'Write reaches leader Node A' },
      { from: 'a', to: 'b', label: 'Stored on B: two of five' },
      { from: 'a', to: 'c', label: 'Stored on C: three, a majority' },
      { from: 'a', to: 'd', label: 'Partition: D never receives it', outcome: 'failure' },
      { from: 'a', to: 'e', label: 'E cut off too: minority', outcome: 'failure' },
      { from: 'a', to: 'client', label: 'Three of five: write acknowledged' },
    ],
  },

  sli: {
    width: 760,
    height: 260,
    caption: 'SLI = good events / valid events, measured as close to the user as possible.',
    nodes: [
      { id: 'reqs', kind: 'client', label: 'Valid requests', sub: 'health checks excluded', x: 40, y: 88, w: 180, h: 84 },
      { id: 'good', kind: 'monitoring', label: 'Good: non-5xx', sub: 'and under 300 ms', x: 300, y: 20, w: 210, h: 80 },
      { id: 'bad', kind: 'client', label: 'Bad: slow or 5xx', x: 300, y: 165, w: 210, h: 76 },
      { id: 'sli', kind: 'monitoring', label: 'SLI 99.93%', sub: 'good / valid', x: 590, y: 88, w: 150, h: 84 },
    ],
    edges: [
      { from: 'reqs', to: 'good', tone: 'ok', rate: 4 },
      { from: 'reqs', to: 'bad', tone: 'danger', rate: 0.4, outcome: 'failure' },
      { from: 'good', to: 'sli', tone: 'brand', rate: 2.4 },
      { from: 'bad', to: 'sli', tone: 'danger', rate: 0.3, outcome: 'failure' },
    ],
    steps: [
      { from: 'reqs', to: 'good', label: 'Fast and non-5xx: good event' },
      { from: 'reqs', to: 'bad', label: 'Slow or 5xx: bad event', outcome: 'failure' },
      { from: 'bad', to: 'sli', label: 'Bad events still count as valid', outcome: 'failure' },
      { from: 'good', to: 'sli', label: 'Good over valid: 99.93%' },
    ],
  },

  slo: {
    width: 760,
    height: 260,
    caption: '99.9% over 30 days is an error budget of 43 minutes - a number you can spend.',
    nodes: [
      { id: 'sli', kind: 'monitoring', label: 'SLI', sub: 'measured', x: 20, y: 88, w: 130, h: 84 },
      { id: 'slo', kind: 'server', label: 'SLO 99.9%', sub: '30 days', x: 190, y: 88, w: 150, h: 84 },
      { id: 'budget', kind: 'queue', label: 'Error budget', sub: '43 minutes', x: 380, y: 88, w: 170, h: 84 },
      { id: 'ship', kind: 'client', label: 'Budget left', sub: 'ship risky changes', x: 590, y: 20, w: 160, h: 80 },
      { id: 'freeze', kind: 'client', label: 'Budget spent', sub: 'reliability first', x: 590, y: 165, w: 160, h: 80, alert: true },
    ],
    edges: [
      { from: 'sli', to: 'slo', tone: 'brand', rate: 2 },
      { from: 'slo', to: 'budget', tone: 'ok', rate: 2 },
      { from: 'budget', to: 'ship', tone: 'ok', rate: 1.4 },
      { from: 'budget', to: 'freeze', tone: 'danger', rate: 0.6, outcome: 'failure' },
    ],
    steps: [
      { from: 'sli', to: 'slo', label: 'Measure against 99.9% target' },
      { from: 'slo', to: 'budget', label: '0.1% of 30 days: 43 min' },
      { from: 'budget', to: 'ship', label: 'Budget left: ship and experiment' },
      { from: 'budget', to: 'freeze', label: 'Budget spent: freeze risky changes', outcome: 'failure' },
    ],
  },

  sla: {
    width: 760,
    height: 250,
    caption: 'Keep the SLA below the SLO, so you see trouble before a customer can claim.',
    nodes: [
      { id: 'sli', kind: 'monitoring', label: 'SLI', sub: 'one measurement', x: 30, y: 85, w: 150, h: 80 },
      { id: 'slo', kind: 'server', label: 'SLO 99.9%', sub: 'internal, 43 min', x: 290, y: 20, w: 180, h: 80 },
      { id: 'sla', kind: 'api-gateway', label: 'SLA 99.5%', sub: 'contract, 216 min', x: 290, y: 150, w: 180, h: 80 },
      { id: 'oncall', kind: 'client', label: 'On-call', sub: 'burn-rate page', x: 570, y: 20, w: 170, h: 80 },
      { id: 'credits', kind: 'client', label: 'Credits', sub: '10% of monthly fee', x: 570, y: 150, w: 170, h: 80 },
    ],
    edges: [
      { from: 'sli', to: 'slo', tone: 'brand', rate: 2 },
      { from: 'sli', to: 'sla', tone: 'violet', rate: 2 },
      { from: 'slo', to: 'oncall', tone: 'warn', rate: 0.8, outcome: 'warning' },
      { from: 'sla', to: 'credits', tone: 'danger', rate: 0.4, outcome: 'failure' },
    ],
    steps: [
      { from: 'sli', to: 'slo', label: 'Internal target: 99.9%' },
      { from: 'slo', to: 'oncall', label: 'Budget burning fast: page on-call', outcome: 'warning' },
      { from: 'sli', to: 'sla', label: 'Same SLI, judged monthly' },
      { from: 'sla', to: 'credits', label: 'Below 99.5%: credits owed', outcome: 'failure' },
    ],
  },

  alerting: {
    width: 760,
    height: 270,
    caption: 'Fast burn pages a human; slow burn opens a ticket. Everything else is noise.',
    nodes: [
      { id: 'signal', kind: 'monitoring', label: 'Burn rate', x: 40, y: 95, w: 160, h: 80 },
      { id: 'page', kind: 'client', label: 'Page on-call', sub: '14.4x burn', x: 300, y: 20, w: 180, h: 80 },
      { id: 'ticket', kind: 'storage', label: 'Ticket', sub: '1x burn', x: 300, y: 170, w: 180, h: 80 },
      { id: 'runbook', kind: 'search', label: 'Runbook', x: 570, y: 95, w: 160, h: 78 },
    ],
    edges: [
      { from: 'signal', to: 'page', tone: 'danger', rate: 1.2, outcome: 'failure' },
      { from: 'signal', to: 'ticket', tone: 'warn', rate: 1.6, outcome: 'warning' },
      { from: 'page', to: 'runbook', tone: 'ok', rate: 1.2 },
    ],
    steps: [
      { from: 'signal', to: 'page', label: 'Burn 14.4x: gone in 2 days', outcome: 'failure' },
      { from: 'page', to: 'runbook', label: 'On-call opens the runbook' },
      { from: 'signal', to: 'ticket', label: 'Burn 1x: a ticket, no page', outcome: 'warning' },
    ],
  },
};
