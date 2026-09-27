import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SETUP,
  FOCUS_SETUPS,
  LOOP_USERS,
  NFRS,
  PART_ORDER,
  RELAXED,
  REQUIREMENTS,
  REGION2,
  SINGLE_POINT_EXEMPT,
  SLOTS,
  WRITE_FLOWS,
  alreadyMet,
  architecture,
  targetApplies,
  targetOffHint,
  coreOf,
  edgesFor,
  implicationsFor,
  instancesOf,
  legendFor,
  routesFor,
  singlePointsHint,
  subtitleFor,
  switchProduct,
  wireKeyOf,
  type InstancedPart,
  type Nfr,
  type PartId,
  type Setup,
} from './requirementsArchitecture.ts';
import { bottleneckStat, findBottleneck } from './requirementsBottleneck.ts';
import { PRODUCTS, type Product } from './requirementsSizing.ts';
import { foundationVisuals } from '../../data/visuals/foundations.ts';

const setup = (product: Product, ids: string[], nfr: Partial<Nfr> = {}): Setup => ({
  product,
  selected: Object.fromEntries(ids.map((id) => [id, true])),
  nfr: { ...RELAXED, ...nfr },
  panel: 'features',
});

const allRoutes = (s: Setup) => {
  const arch = architecture(s);
  return arch.flows.flatMap((flow) => routesFor(flow, arch).map((variant) => ({ flow, ...variant })));
};

/** True when `route` walks `hops` in order, one after the other. */
const walks = (route: string[], hops: string[]) =>
  route.some((_, start) => hops.every((id, offset) => route[start + offset] === id));

// ---------------------------------------------------------------------------
// Legend
// ---------------------------------------------------------------------------

test('the legend lists only the wire tones and particle shapes on screen', () => {
  const legend = legendFor(architecture(setup('whatsapp', ['send'])));

  assert.deepEqual(
    legend.wires.map((wire) => wire.tone),
    ['brand'],
  );
  assert.deepEqual(
    legend.outcomes.map((entry) => entry.outcome),
    ['success'],
  );
});

test('every wire tone drawn has a legend line, and every legend line is drawn', () => {
  const settings: Setup[] = [
    setup('whatsapp', ['send', 'receive', 'groups', 'images'], { latency: 1, users: 3 }),
    setup('whatsapp', Object.keys(coreOf('whatsapp')).concat('stories'), { availability: 3, consistency: 2 }),
    setup('uber', Object.keys(coreOf('uber')).concat('pool', 'schedule'), { durability: 1 }),
    setup('instagram', ['upload', 'feed', 'search'], { users: 2 }),
    setup('uber', ['location', 'match', 'track'], { availability: 3 }),
    DEFAULT_SETUP,
    FOCUS_SETUPS['functional-requirements'],
    { ...FOCUS_SETUPS['functional-requirements'], nfr: { ...RELAXED, availability: 3 } },
  ];
  for (const s of settings) {
    const arch = architecture(s);
    const drawn = new Set(edgesFor(arch).map(wireKeyOf));
    const listed = new Set(legendFor(arch).wires.map((wire) => wire.tone));
    assert.deepEqual([...listed].sort(), [...drawn].sort(), JSON.stringify(s));
  }
});

test('the legend names each wire colour the way it is drawn', () => {
  const legend = legendFor(architecture(setup('whatsapp', ['send', 'receive', 'groups', 'images'], { users: 3 })));
  const label = (tone: string) => legend.wires.find((wire) => wire.tone === tone)?.label ?? '';

  assert.match(label('info'), /^Indigo/);
  assert.match(label('violet'), /^Violet/);
  assert.match(label('ok'), /^Green/);
  assert.match(label('dashed'), /region 2/);
  assert.ok(!legend.wires.some((wire) => /cyan/i.test(wire.label)));
});

test('a cache hit shape is listed only when a cache or CDN answers something', () => {
  const plain = legendFor(architecture(setup('whatsapp', ['send', 'receive'])));
  const cached = legendFor(architecture(setup('whatsapp', ['send', 'receive'], { users: 2 })));

  assert.ok(!plain.outcomes.some((entry) => entry.outcome === 'cache-hit'));
  assert.ok(cached.outcomes.some((entry) => entry.outcome === 'cache-hit'));
});

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

test('a group message travels through the queue to the WebSocket tier and on to the phones', () => {
  const routes = allRoutes(setup('whatsapp', ['groups']));
  const delivered = routes.filter(({ route }) => walks(route, ['async', 'ws']) && route[route.length - 1] === 'users');

  assert.ok(delivered.length > 0, JSON.stringify(routes.map(({ route }) => route)));
});

test('an image upload reaches object storage without passing through the queue', () => {
  const routes = allRoutes(setup('whatsapp', ['send', 'images']));
  const uploads = routes.filter(({ flow }) => flow === 'upload');

  assert.ok(uploads.length > 0);
  for (const { route } of uploads) {
    assert.equal(route[route.length - 1], 'objects');
    assert.ok(!route.includes('async'), route.join(' -> '));
  }
  // Processing is a separate, queued job.
  assert.ok(routes.some(({ flow, route }) => flow === 'process' && walks(route, ['api', 'async'])));
});

test('with only text features picked, no latency level adds a CDN', () => {
  for (const product of PRODUCTS) {
    const text = REQUIREMENTS[product].filter((option) => !option.flows.includes('media')).map((option) => option.id);
    for (let latency = 0; latency <= 2; latency += 1) {
      const arch = architecture(setup(product, text, { latency }));
      assert.equal(arch.parts.cdn, undefined, `${product} at latency level ${latency}`);
    }
  }
  assert.ok(architecture(setup('whatsapp', ['send', 'images'], { latency: 1 })).parts.cdn);
});

test('only write traffic is drawn going to region 2', () => {
  for (const product of PRODUCTS) {
    const routes = allRoutes(setup(product, Object.keys(coreOf(product)), { users: 3 }));
    const copied = routes.filter(({ route }) => route.includes('r2-db'));

    for (const { flow, route } of copied) {
      assert.ok(WRITE_FLOWS.has(flow), `${product}: ${flow} copied (${route.join(' -> ')})`);
      assert.equal(route[route.length - 2], 'db');
    }
    for (const { flow, route } of routes) {
      if (WRITE_FLOWS.has(flow) && route.includes('db')) assert.ok(route.includes('r2-db'), `${product}: ${flow}`);
    }
  }
});

test('the copy to region 2 is one dashed wire from the database', () => {
  const edges = edgesFor(architecture(setup('whatsapp', ['send'], { users: 3 })));
  const copy = edges.filter((edge) => edge.to === 'r2-db' || edge.from === 'r2-db');

  assert.equal(copy.length, 1);
  assert.equal(copy[0].from, 'db');
  assert.equal(copy[0].dashed, true);
});

// ---------------------------------------------------------------------------
// Baselines and forced decisions
// ---------------------------------------------------------------------------

test('the relaxed baseline keeps durable storage', () => {
  assert.equal(NFRS.find((spec) => spec.id === 'durability')?.values[RELAXED.durability], 'Normal');
});

/** Words a forced-decision line uses for a part, and whether that part is on the diagram. */
const NAMED_PARTS: [RegExp, (arch: ReturnType<typeof architecture>) => boolean][] = [
  [/\breplicas?\b/i, (arch) => arch.sizing.database.readReplicas > 0 && Boolean(arch.parts.db)],
  [/conflict/i, (arch) => arch.region2],
  [/\bCDN\b/, (arch) => Boolean(arch.parts.cdn)],
  [/cach/i, (arch) => Boolean(arch.parts.cache)],
  [/database|standby/i, (arch) => Boolean(arch.parts.db)],
  [/multi-region|region 2|between regions/i, (arch) => arch.region2],
];

test('no forced-decision line names a part that is not drawn', () => {
  const starts = [...Object.values(FOCUS_SETUPS), DEFAULT_SETUP];
  const settings: Setup[] = [...starts];
  for (const product of PRODUCTS) {
    for (const option of REQUIREMENTS[product]) {
      for (const users of [0, 1, 2, 3]) {
        for (const latency of [0, 1, 2]) {
          for (const consistency of [0, 1, 2]) {
            for (const [availability, durability] of [[0, 0], [1, 1], [2, 1], [3, 0]]) {
              settings.push(setup(product, [option.id], { users, latency, consistency, availability, durability }));
            }
          }
        }
      }
    }
  }
  for (const s of settings) {
    const arch = architecture(s);
    for (const line of implicationsFor(s, arch)) {
      for (const [pattern, drawn] of NAMED_PARTS) {
        if (pattern.test(line)) assert.ok(drawn(arch), `"${line}" with ${JSON.stringify(s)}`);
      }
    }
  }
});

test('the relaxed baseline of one text feature is Users, one app server and one database', () => {
  const arch = architecture(setup('whatsapp', ['send']));
  const drawn = Object.values(arch.parts).map((part) => part?.title);

  assert.deepEqual(drawn, ['Users', 'App server', 'Database']);
});

// ---------------------------------------------------------------------------
// Switching product
// ---------------------------------------------------------------------------

test('a focus that starts on the core features gets the core features of the other product', () => {
  const away = switchProduct(FOCUS_SETUPS['functional-requirements'], 'uber');

  assert.deepEqual(away.selected, coreOf('uber'));
});

// ---------------------------------------------------------------------------
// Nothing truncated
// ---------------------------------------------------------------------------

// Advance widths from scripts/check-visuals.mjs (measured in headless Chromium): the title font
// (text-xs semibold) and the 11px subtitle font. Anything else counts as wide as a "W".
const TITLE_CHAR_W: Record<string, number> = {
  ' ': 3.2, '+': 7.9, '-': 5.8, ':': 4, '0': 8, '1': 6, '2': 7.6, '3': 7.9, '4': 8.1, '5': 7.8, '6': 8.1, '7': 7.2,
  '8': 8.1, '9': 8.1, A: 8.6, B: 8.2, C: 8.8, D: 8.9, E: 7.4, G: 9.1, I: 3.7, L: 7.1, M: 10.8, N: 9.2, O: 9.4, P: 8,
  Q: 9.4, R: 8.2, S: 8, U: 9.1, W: 12, a: 7, b: 7.7, c: 7, d: 7.7, e: 7.1, f: 4.8, g: 7.6, h: 7.5, i: 3.3, k: 7,
  l: 3.4, m: 11, n: 7.4, o: 7.4, p: 7.7, q: 7.7, r: 5, s: 6.7, t: 4.8, u: 7.4, v: 6.9, w: 9.9, x: 6.8, y: 7, z: 6.7,
};
const SUB_CHAR_W: Record<string, number> = {
  '0': 7, '1': 5.2, '2': 6.8, '3': 7, '4': 7.2, '5': 6.9, '6': 7.1, '7': 6.4, '8': 7.1, '9': 7.1, ' ': 3.2, '%': 10.3,
  '+': 7, ',': 3.4, '-': 5.3, '.': 3.4, '/': 3.5, ':': 3.4, '~': 7, A: 7.5, B: 7.3, C: 8, D: 8.1, E: 6.7, F: 6.4,
  G: 8.3, H: 8.3, I: 3.1, K: 7.4, L: 6.4, M: 9.7, N: 8.3, O: 8.6, P: 7.1, R: 7.3, S: 7.1, T: 7.1, U: 8.2, W: 10.8,
  a: 6.2, b: 6.9, c: 6.3, d: 6.9, e: 6.4, f: 4.1, g: 6.8, h: 6.6, i: 2.8, j: 2.8, k: 6.1, l: 2.9, m: 9.7, n: 6.5,
  o: 6.6, p: 6.8, q: 6.8, r: 4.3, s: 5.9, t: 4.1, u: 6.5, v: 6.1, w: 8.6, x: 5.9, y: 6.1, z: 6,
};
const width = (table: Record<string, number>, wide: number) => (text: string) =>
  [...text].reduce((sum, ch) => sum + (table[ch] ?? wide), 0);
const titleWidth = width(TITLE_CHAR_W, 12);
const subWidth = width(SUB_CHAR_W, 10.8);
/** Stat values are 11px monospace semibold: 6.7px a character. */
const monoWidth = (text: string) => text.length * 6.7;
/** Compact ArchNode: 16 padding + 2 border, and the 28 icon + 8 gap before the title column. */
const INNER = 18;
const TITLE_COLUMN = 54;

function* everySetting(): Generator<Setup> {
  for (const product of PRODUCTS) {
    const ids = REQUIREMENTS[product].map((option) => option.id);
    for (let mask = 1; mask < 1 << ids.length; mask += 1) {
      const chosen = ids.filter((_, index) => mask & (1 << index));
      for (const availability of [0, 1, 2, 3]) {
        for (const users of [0, 1, 2, 3]) {
          for (const latency of [0, 1, 2]) {
            for (const consistency of [0, 2]) {
              for (const durability of [0, 1]) {
                yield setup(product, chosen, { availability, users, latency, consistency, durability });
              }
            }
          }
        }
      }
    }
  }
}

test('no part title, subtitle, stat or status line is truncated at any setting', () => {
  let checked = 0;
  for (const s of everySetting()) {
    const arch = architecture({ ...s, showNotBuilt: true });
    for (const part of [...Object.values(arch.parts), ...Object.values(arch.notBuilt)]) {
      if (!part) continue;
      const w = part.id === 'region2' ? REGION2.w : SLOTS[part.id].w;
      const where = `${part.id} in ${JSON.stringify(s)}`;
      assert.ok(TITLE_COLUMN + titleWidth(part.title) <= w, `title "${part.title}" of ${where}`);
      const subtitle = subtitleFor(part, arch);
      assert.ok(TITLE_COLUMN + subWidth(subtitle) <= w, `subtitle "${subtitle}" of ${where}`);
      if (part.stat) {
        const row = subWidth(part.stat.label) + 8 + monoWidth(part.stat.value);
        assert.ok(INNER + row <= w, `stat "${part.stat.label} ${part.stat.value}" of ${where}`);
      }
      if (part.status) {
        // 8px dot + 6px gap, text at 11px medium (a little wider than regular).
        assert.ok(INNER + 14 + subWidth(part.status) * 1.04 <= w, `status "${part.status}" of ${where}`);
      }
      checked += 1;
    }
  }
  assert.ok(checked > 1000);
});

// ---------------------------------------------------------------------------
// Single points: no hidden single instance
// ---------------------------------------------------------------------------

test('the parts exempt from single points are the managed ones: object storage and the CDN', () => {
  assert.deepEqual([...SINGLE_POINT_EXEMPT].sort(), ['cdn', 'objects']);
});

test('from 99.99% up no drawn part is a single instance, for every product with every feature ticked', () => {
  for (const product of PRODUCTS) {
    const every = REQUIREMENTS[product].map((option) => option.id);
    for (const availability of [2, 3]) {
      for (const users of [0, 1, 2, 3]) {
        for (const latency of [0, 1, 2]) {
          const arch = architecture(setup(product, every, { availability, users, latency }));
          for (const id of PART_ORDER) {
            if (!arch.parts[id] || id === 'users' || id === 'region2' || SINGLE_POINT_EXEMPT.has(id)) continue;
            const where = `${product} ${id} at ${JSON.stringify({ availability, users, latency })}`;
            assert.ok(instancesOf(id, arch) > 1, where);
            // A tier with more than one copy says so in its title.
            assert.match(arch.parts[id]?.title ?? '', /x\d/, where);
          }
          assert.deepEqual(arch.singlePoints, [], `${product} at ${JSON.stringify({ availability, users, latency })}`);
        }
      }
    }
  }
});

test('from 99.99% the cache, queue + workers, index and media servers run one copy in each of the 3 zones', () => {
  const at = (product: Product, availability: number) =>
    architecture(setup(product, REQUIREMENTS[product].map((option) => option.id), { availability, latency: 1 }));
  const titles = (arch: ReturnType<typeof architecture>) =>
    (['cache', 'async', 'index', 'media'] as const).map((id) => arch.parts[id]?.title);

  assert.deepEqual(titles(at('whatsapp', 1)), ['Cache', 'Queue + workers', undefined, 'Media servers']);
  assert.deepEqual(titles(at('whatsapp', 2)), ['Cache x3', 'Queue + workers x3', undefined, 'Media servers x3']);
  assert.deepEqual(titles(at('instagram', 2)), ['Cache x3', 'Queue + workers x3', 'Search index x3', undefined]);
  assert.deepEqual(titles(at('uber', 3)), ['Cache x3', 'Queue + workers x3', 'Geo index x3', undefined]);
  const four = at('uber', 2);
  assert.equal(four.zones, 3);
  for (const id of ['cache', 'async', 'index'] as const) {
    assert.equal(instancesOf(id, four), 3, id);
    assert.ok(four.parts[id]?.reasons.includes('99.99%'), `${id} names the target that copied it`);
  }
});

/**
 * Copies of one slice of a part: a failure of one of them is survived only when this is above 1.
 * The database counts its copies per partition - partitions split the data, they do not copy it.
 */
const copiesPerSlice = (id: InstancedPart, arch: ReturnType<typeof architecture>) =>
  id === 'db' ? arch.dbCopies : instancesOf(id, arch);

/** The drawn parts Single points must count: one copy of their slice, and not a managed service. */
const singleCopyParts = (arch: ReturnType<typeof architecture>) =>
  PART_ORDER.filter((id): id is InstancedPart => Boolean(arch.parts[id]) && id !== 'users' && id !== 'region2').filter(
    (id) => !SINGLE_POINT_EXEMPT.has(id) && copiesPerSlice(id, arch) === 1,
  );

test('Single points counts every drawn part with one copy of its slice that is not exempt, at every setting', () => {
  let counted = 0;
  for (const s of everySetting()) {
    const arch = architecture({ ...s, showNotBuilt: true });
    const single = singleCopyParts(arch);
    assert.equal(arch.singlePoints.length, single.length, `${single.join(', ')} vs ${arch.singlePoints.join(', ')} in ${JSON.stringify(s)}`);
    counted += single.length;
  }
  assert.ok(counted > 1000);
});

test('a partitioned database with one copy per partition is a single point, and the bill still counts every partition', () => {
  // Uber at 100M daily users and 99%: two partitions, one copy each, no standby.
  const uber = architecture({ ...FOCUS_SETUPS['non-functional-requirements'], nfr: { ...RELAXED, users: 3 } });
  assert.equal(uber.parts.db?.title, 'DB: 2 partitions x1');
  assert.ok(uber.singlePoints.includes('each database partition'), uber.singlePoints.join(', '));
  assert.equal(instancesOf('db', uber), 2, 'billed: both partitions');

  // The what-is-system-design loop, with the writes partitioned and no read replicas.
  const loop = { ...FOCUS_SETUPS['what-is-system-design'], loop: { users: 3, fixes: ['scale-out' as const, 'cache' as const, 'partition' as const] } };
  const partitioned = architecture(loop);
  assert.ok(partitioned.sizing.database.partitions > 1);
  assert.equal(partitioned.dbCopies, 1);
  assert.ok(partitioned.singlePoints.includes('each database partition'), partitioned.singlePoints.join(', '));

  // With a standby, each partition has a second copy.
  const standby = architecture({ ...FOCUS_SETUPS['non-functional-requirements'], nfr: { ...RELAXED, users: 3, availability: 2 } });
  assert.ok(!standby.singlePoints.some((name) => /database/.test(name)), standby.singlePoints.join(', '));
});

test('the Single points hint says every part has a second copy only when every counted part has one', () => {
  let none = 0;
  for (const s of everySetting()) {
    const arch = architecture(s);
    const hint = singlePointsHint(arch);
    const everyPartCopied = singleCopyParts(arch).length === 0;
    assert.equal(/every part drawn has a second copy/.test(hint), everyPartCopied, `${hint} in ${JSON.stringify(s)}`);
    if (everyPartCopied) none += 1;
    for (const name of arch.singlePoints) assert.ok(hint.includes(name), `${name} in ${hint}`);
  }
  assert.ok(none > 100);
});

test('below 99.99% a single cache, queue + workers or index is a single point, named as drawn', () => {
  const arch = architecture(setup('instagram', ['upload', 'feed', 'search'], { availability: 1, latency: 1 }));

  assert.deepEqual(arch.singlePoints, ['database', 'queue + workers', 'search index', 'cache']);
  // Not built parts are never billed and never a single point.
  const functional = architecture(FOCUS_SETUPS['functional-requirements']);
  assert.ok(functional.notBuilt.media);
  assert.ok(!functional.singlePoints.includes('media servers'));
});

test('a part with several reasons names the first and counts the rest', () => {
  const arch = architecture(setup('whatsapp', ['send', 'receive', 'groups', 'receipts']));
  const api = arch.parts.api;

  assert.ok(api);
  assert.equal(subtitleFor(api, arch), 'for send +3 more');
});

// ---------------------------------------------------------------------------
// Every control changes the diagram
// ---------------------------------------------------------------------------

/**
 * What the learner sees change: each part with its title, stat row and status line, each wire with
 * its tone, and the zones. Not the subtitles - "for send +3 more" counting one more reason is not a
 * new part, wire or number.
 */
function drawn(s: Setup): string {
  const arch = architecture(s);
  const parts = PART_ORDER.flatMap((id) => {
    const part = arch.parts[id];
    return part ? [[id, part.title, part.stat?.label, part.stat?.value, part.status]] : [];
  });
  const wires = edgesFor(arch)
    .map((edge) => [edge.from, edge.to, edge.tone, Boolean(edge.dashed)].join(' '))
    .sort();
  return JSON.stringify({ parts, wires, zones: arch.zones });
}

/** The part subtitles, which `drawn` leaves out: a target that is off must not add its name to one either. */
function subtitles(s: Setup): string[] {
  const arch = architecture(s);
  return PART_ORDER.flatMap((id) => {
    const part = arch.parts[id];
    return part ? [subtitleFor(part, arch)] : [];
  });
}

const TARGETS: [string, Nfr][] = [
  ['relaxed targets', RELAXED],
  ['default targets', DEFAULT_SETUP.nfr],
];

test('ticking the features in list order, every tick changes the diagram', () => {
  for (const product of PRODUCTS) {
    const ids = REQUIREMENTS[product].map((option) => option.id);
    for (const [name, nfr] of TARGETS) {
      for (let index = 1; index < ids.length; index += 1) {
        const before = setup(product, ids.slice(0, index), nfr);
        const after = setup(product, ids.slice(0, index + 1), nfr);
        assert.notEqual(drawn(after), drawn(before), `${product}: ticking ${ids[index]} at ${name}`);
      }
    }
  }
});

test('every extra feature ticked on top of the core changes the diagram', () => {
  for (const product of PRODUCTS) {
    const core = Object.keys(coreOf(product));
    for (const [name, nfr] of TARGETS) {
      for (const option of REQUIREMENTS[product].filter((entry) => !entry.core)) {
        const before = setup(product, core, nfr);
        const after = setup(product, [...core, option.id], nfr);
        assert.notEqual(drawn(after), drawn(before), `${product}: ticking ${option.id} at ${name}`);
      }
    }
  }
});

/** The feature sets the target tests walk, per product: each feature alone, the core, and every one. */
const featureSets = (product: Product): string[][] => [
  ...REQUIREMENTS[product].map((option) => [option.id]),
  Object.keys(coreOf(product)),
  REQUIREMENTS[product].map((option) => option.id),
];

/** The targets the other targets are stepped from: the two starts, and each way of a second database copy. */
const BASELINES: [string, Nfr][] = [
  ...TARGETS,
  ['a standby at 99.99%', { ...RELAXED, availability: 2 }],
  ['a sync standby for Critical durability', { ...RELAXED, durability: 1 }],
  ['region 2 at 99.999%', { ...RELAXED, availability: 3 }],
];

/** Every combination of the target levels. */
function* everyNfr(specs = NFRS, nfr: Nfr = RELAXED): Generator<Nfr> {
  if (specs.length === 0) {
    yield nfr;
    return;
  }
  const [head, ...tail] = specs;
  for (let level = 0; level < head.values.length; level += 1) yield* everyNfr(tail, { ...nfr, [head.id]: level });
}

/**
 * Some levels draw what an earlier choice already built: 99.9% when the load already runs more than
 * two of each server, 100 ms when the users already put a cache in front of the reads, 99.999% when
 * 100M users already built region 2, Critical when 99.99% and Strong already make each write wait
 * for a standby. The slider stays on, so the Lab says so under it (`alreadyMet`). Every other level
 * changes a part, a wire, a stat or status line, or the zones - checked from every combination of
 * the other targets.
 */
test('every target level changes the diagram, or the target is off, or the Lab says it is already met', () => {
  const met = new Set<string>();
  for (const product of PRODUCTS) {
    for (const ids of featureSets(product)) {
      for (const nfr of everyNfr()) {
        for (const spec of NFRS) {
          const level = nfr[spec.id];
          if (level === 0) continue;
          const before = setup(product, ids, { ...nfr, [spec.id]: level - 1 });
          const after = setup(product, ids, nfr);
          const hint = alreadyMet(spec.id, after);
          const where = `${product} [${ids.join(', ')}]: ${spec.label} ${spec.values[level]} at ${JSON.stringify(nfr)}`;
          if (!targetApplies(spec.id, architecture(before))) {
            assert.equal(hint, undefined, where);
            continue;
          }
          if (drawn(after) === drawn(before)) {
            assert.match(hint ?? '', /^Already met: /, where);
            met.add(`${spec.id} ${level}`);
          } else {
            assert.equal(hint, undefined, where);
          }
        }
      }
    }
  }
  // The four levels the review found, and no other.
  assert.deepEqual([...met].sort(), ['availability 1', 'availability 3', 'durability 1', 'latency 1']);
});

test('the already-met line names what built the part earlier', () => {
  const core = (product: Product, nfr: Partial<Nfr>) => setup(product, Object.keys(coreOf(product)), nfr);
  const uber = architecture(core('uber', { users: 2 })).sizing;

  assert.equal(
    alreadyMet('availability', core('uber', { users: 2, availability: 1 })),
    `Already met: the load already needs ${uber.app.forLoad} app servers and ${uber.ws.forLoad} WebSocket servers behind a load balancer, more than the 2 copies of each 99.9% asks for.`,
  );
  assert.equal(alreadyMet('latency', core('whatsapp', { users: 2, latency: 1 })), 'Already met: 10M daily users already put a cache in front of the database reads.');
  assert.equal(alreadyMet('availability', core('instagram', { users: 3, availability: 3 })), 'Already met: 100M daily users already built region 2, a full copy of region 1.');
  assert.equal(
    alreadyMet('durability', core('uber', { availability: 2, consistency: 2, durability: 1 })),
    'Already met: 99.99% already keeps a standby copy, and Strong consistency already makes each write wait for it.',
  );
  // A level that draws something new, a level at the bottom and a target that is off say nothing.
  assert.equal(alreadyMet('availability', core('uber', { availability: 1 })), undefined);
  assert.equal(alreadyMet('availability', core('uber', { users: 2 })), undefined);
  assert.equal(alreadyMet('latency', setup('uber', ['location'], { users: 2, latency: 1 })), undefined);
});

test('a target that does not apply draws nothing and says nothing at any level', () => {
  let off = 0;
  for (const product of PRODUCTS) {
    for (const ids of featureSets(product)) {
      for (const [, nfr] of BASELINES) {
        for (const spec of NFRS) {
          const at = (level: number) => setup(product, ids, { ...nfr, [spec.id]: level });
          if (targetApplies(spec.id, architecture(at(0)))) continue;
          off += 1;
          for (let level = 1; level < spec.values.length; level += 1) {
            const where = `${product} [${ids.join(', ')}]: ${spec.label} ${spec.values[level]}`;
            assert.equal(targetApplies(spec.id, architecture(at(level))), false, where);
            assert.equal(drawn(at(level)), drawn(at(0)), where);
            assert.deepEqual(subtitles(at(level)), subtitles(at(0)), where);
            assert.deepEqual(implicationsFor(at(level), architecture(at(level))), implicationsFor(at(0), architecture(at(0))), where);
          }
        }
      }
    }
  }
  assert.ok(off > 0);
});

test('P95 latency is off while no picked feature reads, and durability while nothing is stored', () => {
  const off = (product: Product, ids: string[], id: 'latency' | 'durability') => !targetApplies(id, architecture(setup(product, ids)));

  assert.equal(off('whatsapp', ['groups'], 'latency'), true);
  assert.equal(off('instagram', ['like'], 'latency'), true);
  assert.equal(off('uber', ['location'], 'latency'), true);
  assert.equal(off('whatsapp', ['send'], 'latency'), false);
  assert.equal(off('uber', ['location'], 'durability'), true);
  assert.equal(off('whatsapp', ['calls'], 'durability'), true);
  assert.equal(off('uber', ['request'], 'durability'), false);
  for (const id of ['latency', 'durability', 'consistency'] as const) {
    assert.match(targetOffHint(id, architecture(setup('uber', ['location']))) ?? '', /\w/, id);
    assert.equal(targetOffHint(id, architecture(setup('whatsapp', ['send'], { availability: 2 }))), undefined, id);
  }
});

test('once the database has a second copy, every consistency level changes the diagram', () => {
  const consistency = NFRS.find((spec) => spec.id === 'consistency');
  assert.ok(consistency);
  for (const product of PRODUCTS) {
    const core = Object.keys(coreOf(product));
    // A standby (99.99%), a sync standby (Critical durability), a whole region 2 (99.999%), and
    // region 2 through the users (100M) - at 99% and 99.9%, where region 1 may hold one copy per partition.
    for (const copies of [{ availability: 2 }, { durability: 1 }, { availability: 3 }, { users: 3 }, { users: 3, availability: 1 }]) {
      assert.ok(targetApplies('consistency', architecture(setup(product, core, copies))), `${product} with ${JSON.stringify(copies)}`);
      const shapes: string[] = consistency.values.map((_, level) => drawn(setup(product, core, { ...copies, consistency: level })));
      assert.equal(new Set(shapes).size, consistency.values.length, `${product}: every level differs with ${JSON.stringify(copies)}`);
    }
  }
  // The case that drew nothing: Uber at 100M and 99%, two partitions with one copy each, and region 2.
  const uber = (level: number) => architecture(setup('uber', Object.keys(coreOf('uber')), { users: 3, consistency: level }));
  assert.equal(uber(0).parts.db?.title, 'DB: 2 partitions x1');
  assert.equal(uber(0).region2, true);
  assert.notEqual(uber(0).parts.db?.status, uber(1).parts.db?.status);
  // Where the status line says the reads go, a forced-decision line says why.
  const readsLine = [/any database copy/, /primary right after their own write/, /primary only/];
  for (const level of [0, 1, 2]) {
    const s = setup('uber', Object.keys(coreOf('uber')), { users: 3, consistency: level });
    assert.ok(implicationsFor(s, architecture(s)).some((line) => readsLine[level].test(line)), `${uber(level).parts.db?.status}`);
  }
});

test('with one database copy the consistency level draws nothing, and the lab says why', () => {
  for (const product of PRODUCTS) {
    const core = Object.keys(coreOf(product));
    const shapes = new Set([0, 1, 2].map((consistency) => drawn(setup(product, core, { consistency }))));
    assert.equal(shapes.size, 1, product);
    for (const consistency of [0, 1, 2]) {
      const s = setup(product, core, { consistency });
      assert.ok(
        implicationsFor(s, architecture(s)).some((line) => /one database copy/i.test(line)),
        `${product} at consistency ${consistency}`,
      );
    }
  }
});

test('the target levels that drew nothing are gone', () => {
  const values = (id: string) => NFRS.find((spec) => spec.id === id)?.values;

  assert.deepEqual(values('latency'), ['500 ms', '100 ms', '20 ms']);
  assert.deepEqual(values('durability'), ['Normal', 'Critical']);
});

test('a line a latency level adds names only a part that level adds or changes', () => {
  // The parts a latency line can name, and the words it names them by.
  const named: [RegExp, PartId][] = [
    [/\bCDN\b/, 'cdn'],
    [/cach/i, 'cache'],
  ];
  const partOf = (s: Setup, id: PartId) => {
    const part = architecture(s).parts[id];
    return JSON.stringify(part ? [part.title, part.stat, part.status] : null);
  };
  let checked = 0;
  for (const product of PRODUCTS) {
    for (const ids of featureSets(product)) {
      for (const [name, nfr] of BASELINES) {
        for (let level = 1; level < 3; level += 1) {
          const before = setup(product, ids, { ...nfr, latency: level - 1 });
          const after = setup(product, ids, { ...nfr, latency: level });
          const had = new Set(implicationsFor(before, architecture(before)));
          for (const line of implicationsFor(after, architecture(after)).filter((entry) => !had.has(entry))) {
            for (const [pattern, id] of named) {
              if (!pattern.test(line)) continue;
              checked += 1;
              assert.notEqual(partOf(after, id), partOf(before, id), `"${line}" at ${product} [${ids.join(', ')}] ${name}, latency ${level}`);
            }
          }
        }
      }
    }
  }
  assert.ok(checked > 10);
  // The CDN is drawn by the features that send files; 100 ms does not add it, so no line credits it.
  const images = setup('whatsapp', ['send', 'images'], { latency: 1 });
  assert.ok(architecture(images).parts.cdn);
  assert.ok(!implicationsFor(images, architecture(images)).some((line) => /\bCDN\b/.test(line)));
});

test('receipts push each message back to the sender over the WebSocket tier', () => {
  const without = architecture(setup('whatsapp', ['send', 'receive', 'groups']));
  const withReceipts = architecture(setup('whatsapp', ['send', 'receive', 'groups', 'receipts']));

  assert.equal(without.parts.ws?.status, undefined);
  assert.equal(withReceipts.parts.ws?.status, '3 pushes per message');
  // The receipt comes up the recipient connection, is stored, and goes back down to the sender.
  const routes = allRoutes(setup('whatsapp', ['send', 'receive', 'receipts']));
  const receipts = routes.filter(({ flow }) => flow === 'receipt');
  assert.ok(receipts.some(({ route }) => walks(route, ['ws', 'api', 'db'])));
  assert.ok(receipts.some(({ route }) => walks(route, ['api', 'ws']) && route[route.length - 1] === 'users'));
});

test('stories are kept 24 hours and a scheduled job deletes them', () => {
  const images = setup('whatsapp', ['send', 'images']);
  const stories = setup('whatsapp', ['send', 'images', 'stories']);

  assert.equal(architecture(images).parts.objects?.stat, undefined);
  assert.deepEqual(architecture(stories).parts.objects?.stat, { label: 'Stories kept', value: '24 h' });
  const routes = allRoutes(setup('whatsapp', ['send', 'stories']));
  assert.ok(routes.some(({ flow, route }) => flow === 'expire' && walks(route, ['async', 'objects'])));
});

test('critical durability adds a synchronous standby in a second zone', () => {
  const normal = architecture(setup('whatsapp', ['send']));
  const critical = architecture(setup('whatsapp', ['send'], { durability: 1 }));

  assert.equal(normal.dbCopies, 1);
  assert.equal(normal.zones, 1);
  assert.equal(normal.parts.db?.stat?.label, 'Peak writes');
  assert.equal(critical.dbCopies, 2);
  assert.equal(critical.zones, 2);
  assert.equal(critical.parts.db?.stat?.label, 'Peak sync writes');
  // At 99.99% the standby is already there: critical durability makes it synchronous.
  const failover = architecture(setup('whatsapp', ['send'], { availability: 2 }));
  const syncFailover = architecture(setup('whatsapp', ['send'], { availability: 2, durability: 1 }));
  assert.equal(failover.parts.db?.stat?.label, 'Peak writes');
  assert.equal(syncFailover.parts.db?.stat?.label, 'Peak sync writes');
});

test('strong consistency with region 2 draws the copy as a solid amber wire the write waits for', () => {
  const eventual = architecture(setup('whatsapp', ['send'], { availability: 3 }));
  const strong = architecture(setup('whatsapp', ['send'], { availability: 3, consistency: 2 }));
  const copy = (arch: ReturnType<typeof architecture>) => edgesFor(arch).find((edge) => edge.to === 'r2-db');

  assert.equal(copy(eventual)?.dashed, true);
  assert.equal(copy(strong)?.dashed, undefined);
  assert.equal(copy(strong)?.tone, 'warn');
  const legend = legendFor(strong).wires;
  assert.ok(legend.some((wire) => wire.tone === 'warn' && /^Amber/.test(wire.label)));
  assert.ok(!legend.some((wire) => wire.tone === 'dashed'));
});

test('a 20 ms target keeps the hot data in memory, so the cache answers more reads', () => {
  const hundred = architecture(setup('whatsapp', ['send'], { latency: 1 }));
  const twenty = architecture(setup('whatsapp', ['send'], { latency: 2 }));

  assert.equal(hundred.parts.cache?.stat?.value, '80% (model)');
  assert.equal(twenty.parts.cache?.stat?.value, '99% (model)');
  const hits = (arch: ReturnType<typeof architecture>) =>
    routesFor('read', arch).find((variant) => variant.outcome === 'cache-hit')?.weight;
  assert.equal(hits(twenty), 0.99);
});

test('Uber pooling batches requests through the workers into the geo index', () => {
  const routes = allRoutes(setup('uber', ['location', 'match', 'pool']));
  assert.ok(routes.some(({ route }) => walks(route, ['api', 'async', 'index'])));
});

// ---------------------------------------------------------------------------
// The Functional Requirements focus: features only, and what saying no leaves out
// ---------------------------------------------------------------------------

const FUNCTIONAL = FOCUS_SETUPS['functional-requirements'];

test('the Functional Requirements focus opens on the WhatsApp core features at relaxed targets', () => {
  assert.equal(FUNCTIONAL.product, 'whatsapp');
  assert.deepEqual(FUNCTIONAL.selected, coreOf('whatsapp'));
  assert.deepEqual(FUNCTIONAL.nfr, RELAXED);
  assert.equal(FUNCTIONAL.panel, 'features');
});

test('on the Functional Requirements focus every built part names a picked feature as its reason', () => {
  const picked = new Set(REQUIREMENTS.whatsapp.filter((option) => FUNCTIONAL.selected[option.id]).map((option) => option.short));
  const arch = architecture(FUNCTIONAL);
  const built = Object.values(arch.parts).filter((part) => part && part.id !== 'users');

  assert.ok(built.length > 0);
  for (const part of built) {
    assert.ok(part);
    for (const reason of part.reasons) assert.ok(picked.has(reason), `${part.title}: "${reason}" is not a picked feature`);
  }
});

test('on the Functional Requirements focus each unpicked feature draws its parts as not built', () => {
  const arch = architecture(FUNCTIONAL);
  const notBuilt = Object.fromEntries(Object.values(arch.notBuilt).map((part) => [part?.id, part?.reasons]));

  assert.deepEqual(notBuilt, { cdn: ['images', 'stories'], media: ['calls'], objects: ['images', 'stories'] });
  assert.equal(arch.notBuilt.media?.title, 'Media servers');
  assert.equal(arch.notBuilt.media?.kind, 'server');
});

test('a not-built part is wired with dashed grey wires that no request travels', () => {
  const arch = architecture(FUNCTIONAL);
  const notBuilt = new Set(Object.keys(arch.notBuilt));
  const touching = edgesFor(arch).filter((edge) => notBuilt.has(edge.from) || notBuilt.has(edge.to));

  assert.ok(touching.some((edge) => [edge.from, edge.to].sort().join('|') === 'media|users'));
  for (const edge of touching) {
    assert.equal(edge.dashed, true, `${edge.from} -> ${edge.to}`);
    assert.equal(wireKeyOf(edge), 'not-built');
  }
  for (const { route } of allRoutes(FUNCTIONAL)) {
    assert.ok(!route.some((id) => notBuilt.has(id)), route.join(' -> '));
  }
});

test('a part is never both built and not built, and no request reaches a not-built part', () => {
  let checked = 0;
  for (const s of everySetting()) {
    const shown: Setup = { ...s, showNotBuilt: true };
    const arch = architecture(shown);
    for (const id of Object.keys(arch.notBuilt)) {
      assert.equal(arch.parts[id as keyof typeof arch.parts], undefined, `${id} in ${JSON.stringify(s)}`);
    }
    const notBuilt = new Set(Object.keys(arch.notBuilt));
    if (notBuilt.size === 0) continue;
    for (const flow of arch.flows) {
      for (const { route } of routesFor(flow, arch)) assert.ok(!route.some((id) => notBuilt.has(id)), route.join(' -> '));
    }
    checked += 1;
  }
  assert.ok(checked > 100);
});

test('not-built parts are drawn only on the Functional Requirements focus', () => {
  const others = [DEFAULT_SETUP, FOCUS_SETUPS['what-is-system-design'], FOCUS_SETUPS['non-functional-requirements']];
  for (const s of others) {
    const arch = architecture(s);
    assert.deepEqual(arch.notBuilt, {}, JSON.stringify(s));
    assert.ok(!edgesFor(arch).some((edge) => wireKeyOf(edge) === 'not-built'));
  }
});

test('with nothing picked there is nothing to leave out', () => {
  assert.deepEqual(architecture({ ...FUNCTIONAL, selected: {} }).notBuilt, {});
});

test('the legend explains the dashed not-built wires only while they are drawn', () => {
  const label = (s: Setup) => legendFor(architecture(s)).wires.find((wire) => wire.tone === 'not-built')?.label;

  assert.match(label(FUNCTIONAL) ?? '', /not built/i);
  assert.equal(label({ ...FUNCTIONAL, showNotBuilt: false }), undefined);
  // Every extra feature picked: nothing is left out, so the legend line goes too.
  const everything = Object.fromEntries(REQUIREMENTS.whatsapp.map((option) => [option.id, true]));
  assert.equal(label({ ...FUNCTIONAL, selected: everything }), undefined);
});

test('ticking an unpicked feature turns its not-built parts into built ones', () => {
  const withCalls = architecture({ ...FUNCTIONAL, selected: { ...FUNCTIONAL.selected, calls: true } });

  assert.equal(withCalls.notBuilt.media, undefined);
  assert.equal(withCalls.parts.media?.title, 'Media servers');
});

test('switching product keeps the not-built parts and the focus start of each product', () => {
  const away = switchProduct(FUNCTIONAL, 'instagram');
  const back = switchProduct(away, 'whatsapp');

  assert.equal(away.showNotBuilt, true);
  assert.deepEqual(away.selected, coreOf('instagram'));
  assert.ok(architecture(away).notBuilt.index, 'search is not picked, so the Search index is not built');
  assert.deepEqual(back, FUNCTIONAL);
});

test('consistency can be set only while there is a second copy to be inconsistent with', () => {
  const core = Object.keys(coreOf('whatsapp'));
  const applies = (s: Setup) => targetApplies('consistency', architecture(s));
  assert.equal(applies(setup('whatsapp', core)), false, 'one database copy');
  assert.equal(applies(setup('whatsapp', core, { availability: 2 })), true, 'a standby');
  assert.equal(applies(setup('whatsapp', core, { availability: 3 })), true, 'region 2');
  assert.equal(applies(setup('whatsapp', [])), false, 'no database');
});

// ---------------------------------------------------------------------------
// The Non-Functional Requirements focus: Uber, on the quality targets
// ---------------------------------------------------------------------------

const NON_FUNCTIONAL = FOCUS_SETUPS['non-functional-requirements'];

test('the Non-Functional Requirements focus opens on the Uber core features, on the targets panel, at relaxed targets', () => {
  assert.equal(NON_FUNCTIONAL.product, 'uber');
  assert.deepEqual(NON_FUNCTIONAL.selected, coreOf('uber'));
  assert.deepEqual(NON_FUNCTIONAL.nfr, RELAXED);
  assert.equal(NON_FUNCTIONAL.panel, 'targets');
  assert.equal(NON_FUNCTIONAL.showNotBuilt, undefined);
});

test('from the Non-Functional focus, 99.99% draws redundant instances in three zones and an automated standby', () => {
  const arch = architecture({ ...NON_FUNCTIONAL, nfr: { ...RELAXED, availability: 2 } });

  assert.equal(arch.zones, 3);
  assert.equal(arch.parts.lb?.title, 'Load balancer x2');
  assert.ok(arch.sizing.app.count > 1, 'more than one app server');
  assert.ok(arch.sizing.ws.count > 1, 'more than one WebSocket server');
  assert.equal(arch.dbCopies, 2, 'the primary and its standby');
  assert.ok(arch.parts.db?.reasons.includes('99.99% failover'));
  assert.deepEqual(arch.singlePoints, []);
});

/**
 * Every node of a Concept Diagram against the Lab part with the same id, on the Lab setup the
 * Diagram shows: the same title, the same stat row (the red part shows its load against its limit),
 * the same status line (none where the Lab has none), the Users subtitle, and only wires the Lab draws.
 */
function assertDiagramMatchesLab(slug: string, s: Setup) {
  const spec = foundationVisuals[slug];
  const arch = architecture(s);
  const red = findBottleneck(s, arch);
  for (const node of spec.nodes) {
    const part = arch.parts[node.id as PartId];
    const where = `${slug}: ${node.label}`;
    assert.ok(part, `${where} is not a part of the Lab`);
    assert.equal(node.label, part.title, where);
    const stat = red?.part === node.id ? bottleneckStat(red) : part.stat;
    assert.deepEqual(node.stat, stat ? [stat.label, stat.value] : undefined, `${where}: stat row`);
    assert.equal(node.statusLabel, red?.part === node.id ? 'Over its limit' : part.status, `${where}: status`);
    if (node.id === 'users') assert.equal(node.sub, subtitleFor(part, arch), where);
  }
  const wires = new Set(edgesFor(arch).map((edge) => [edge.from, edge.to].sort().join('|')));
  for (const edge of spec.edges) assert.ok(wires.has([edge.from, edge.to].sort().join('|')), `${slug}: wire ${edge.from} -> ${edge.to}`);
}

test('the Non-Functional Diagram draws the parts of the Lab at 99.99%, under the same names and stat rows', () => {
  assertDiagramMatchesLab('non-functional-requirements', { ...NON_FUNCTIONAL, nfr: { ...RELAXED, availability: 2 } });
});

test('the What is System Design Diagram draws the Lab at round 2, and no step crosses the Load balancer before it is built', () => {
  const start = FOCUS_SETUPS['what-is-system-design'];
  const roundOne = { ...start, loop: { users: 1, fixes: [] } };
  const roundTwo = { ...start, loop: { users: 2, fixes: ['scale-out' as const] } };

  assertDiagramMatchesLab('what-is-system-design', roundTwo);
  assert.equal(findBottleneck(roundTwo)?.id, 'db-reads');
  // At 1M users, before its fix, the Lab has no Load balancer and the App server is red.
  assert.equal(architecture(roundOne).parts.lb, undefined);
  assert.equal(findBottleneck(roundOne)?.part, 'api');
  const steps = foundationVisuals['what-is-system-design'].steps ?? [];
  const firstRed = steps.findIndex((step) => step.outcome === 'failure');
  assert.deepEqual([steps[firstRed].from, steps[firstRed].to], ['api', 'api']);
  for (const step of steps.slice(0, firstRed + 1)) assert.ok(step.from !== 'lb' && step.to !== 'lb', step.label);
});

test('every What is System Design step agrees with the nodes it plays on, or names the earlier round it tells', () => {
  // The Diagram draws round 2 (10M users, after the round 1 fix). A caption about an earlier round
  // says which one ("1M users"), and is held to the Lab at that round; any other caption is held to
  // the nodes drawn.
  const start = FOCUS_SETUPS['what-is-system-design'];
  const labAt = (users: number) => architecture({ ...start, loop: { users, fixes: users >= 2 ? ['scale-out' as const] : [] } });
  /** A count a caption claims for a part, and whether a Lab title agrees with it. */
  const claims: [RegExp, PartId, (title: string) => boolean][] = [
    [/\bone server\b|\bApp server\b(?!s)/, 'api', (title) => title === 'App server'],
    [/\bmore servers\b|\bApp servers\b/, 'api', (title) => /^App servers x\d+$/.test(title)],
    [/\bone Database\b/i, 'db', (title) => title === 'Database'],
  ];
  const steps = foundationVisuals['what-is-system-design'].steps ?? [];
  const drawn = new Map(foundationVisuals['what-is-system-design'].nodes.map((node) => [node.id, node.label]));
  for (const step of steps) {
    const round = LOOP_USERS.findIndex((users) => new RegExp(`(^|\\s)${users}\\b`).test(step.label));
    const arch = labAt(round === -1 ? 2 : round);
    for (const [pattern, id, agrees] of claims) {
      if (!pattern.test(step.label)) continue;
      // Without a round, the caption describes the nodes on screen: they are the Lab at round 2.
      const title = round === -1 ? drawn.get(id) : arch.parts[id]?.title;
      assert.ok(title && agrees(title), `"${step.label}" against "${title}"`);
    }
  }
});

test('the Non-Functional Lesson numbers: single points 5, 3, 0 and about 32 requests a second', () => {
  const at = (availability: number) => architecture({ ...NON_FUNCTIONAL, nfr: { ...RELAXED, availability } });

  assert.deepEqual(at(0).singlePoints, ['app server', 'WebSocket server', 'database', 'queue + workers', 'geo index']);
  assert.deepEqual(at(1).singlePoints, ['database', 'queue + workers', 'geo index']);
  assert.deepEqual(at(2).singlePoints, []);
  assert.equal(at(2).parts.async?.title, 'Queue + workers x3');
  assert.equal(at(2).parts.index?.title, 'Geo index x3');
  assert.equal(Math.round(at(0).sizing.peakQps), 32);
  assert.deepEqual(at(1).parts.api?.stat, { label: '1 for load', value: '+1 for 99.9%' });
  assert.equal(at(1).parts.ws?.title, 'WebSocket x2');
});

test('Critical durability on its own turns the Uber database into a synchronous standby in a second zone (quiz nfr-9)', () => {
  const arch = architecture({ ...NON_FUNCTIONAL, nfr: { ...RELAXED, durability: 1 } });

  assert.equal(arch.parts.db?.title, 'Database x2');
  assert.equal(arch.parts.db?.stat?.label, 'Peak sync writes');
  assert.equal(arch.syncStandby, true);
  assert.equal(arch.zones, 2);
});

test('Uber at 10M daily users: 479 app servers and a cache, one database primary, workers already there (quiz nfr-11)', () => {
  const at = (users: number) => architecture({ ...NON_FUNCTIONAL, nfr: { ...RELAXED, users } });
  const [before, after] = [at(1), at(2)];

  assert.equal(before.sizing.app.count, 6);
  assert.equal(after.sizing.app.count, 479);
  assert.equal(before.parts.cache, undefined);
  assert.ok(after.parts.cache);
  assert.ok(before.parts.async, 'Queue + workers are there for payments before 10M');
  assert.equal(after.parts.db?.title, 'Database');
  assert.equal(after.parts.db?.status, 'One primary is enough');
  assert.equal(Math.round(after.sizing.peakQps), 318_287);
  assert.equal(Math.round(after.sizing.database.peakWriteQps), 1_157);
  assert.equal(Math.round(after.sizing.index.peakWriteQps), 312_500);
  assert.equal(after.region2, false);
});
