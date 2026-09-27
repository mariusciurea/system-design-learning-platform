import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SETUP,
  FOCUS_SETUPS,
  RELAXED,
  REQUIREMENTS,
  architecture,
  coreOf,
  instancesOf,
  type Nfr,
  type Setup,
} from './requirementsArchitecture.ts';
import { PRODUCTS, type Product } from './requirementsSizing.ts';
import {
  CROSS_REGION_SHARE,
  CROSS_ZONE_SHARE,
  PART_COST,
  costLines,
  formatCost,
  monthlyCost,
  relativeCost,
  simplestSetup,
} from './requirementsCost.ts';

const core = (product: Product, nfr: Partial<Nfr> = {}): Setup => ({
  product,
  selected: coreOf(product),
  nfr: { ...RELAXED, ...nfr },
  panel: 'targets',
});

const withAvailability = (setup: Setup, availability: number): Setup => ({ ...setup, nfr: { ...setup.nfr, availability } });

const inRange = (value: number, low: number, high: number, what: string) =>
  assert.ok(value >= low && value <= high, `${what}: x${value.toFixed(2)} is not within x${low}-x${high}`);

// ---------------------------------------------------------------------------
// The yardstick
// ---------------------------------------------------------------------------

test('the simplest design of every product is x1', () => {
  for (const product of PRODUCTS) {
    assert.equal(relativeCost(simplestSetup(product)), 1, product);
  }
});

test('the simplest design is the core features at the relaxed targets, one copy of everything', () => {
  for (const product of PRODUCTS) {
    const simplest = simplestSetup(product);
    assert.deepEqual(simplest.selected, coreOf(product));
    assert.deepEqual(simplest.nfr, RELAXED);
    for (const line of costLines(architecture(simplest))) assert.equal(line.instances, 1, `${product}: ${line.label}`);
  }
});

test('the Non-Functional Requirements focus opens on x1', () => {
  assert.equal(relativeCost(FOCUS_SETUPS['non-functional-requirements']), 1);
});

test('the Functional Requirements focus opens on x1: its not-built parts are not billed', () => {
  const focus = FOCUS_SETUPS['functional-requirements'];
  const arch = architecture(focus);
  const billed = new Set(costLines(arch).map((line) => line.id));

  assert.ok(Object.keys(arch.notBuilt).length > 0);
  for (const id of Object.keys(arch.notBuilt)) assert.ok(!billed.has(id as never), `${id} is not built but billed`);
  assert.equal(relativeCost(focus), 1);
  assert.equal(monthlyCost(arch), monthlyCost(architecture({ ...focus, showNotBuilt: false })));
});

test('with nothing to build there is no cost', () => {
  const empty: Setup = { ...DEFAULT_SETUP, selected: {} };
  assert.equal(monthlyCost(architecture(empty)), 0);
  assert.equal(relativeCost(empty), 0);
});

// ---------------------------------------------------------------------------
// Availability: the Non-Functional Diagram says 99.99% costs 2-3x
// ---------------------------------------------------------------------------

test('raising availability from 99.9% to 99.99% moves the cost into 2x-3x', () => {
  for (const product of PRODUCTS) {
    for (const [name, start] of [
      ['relaxed baseline', core(product)],
      ['default targets', { ...DEFAULT_SETUP, product, selected: coreOf(product) }],
    ] as const) {
      // What availability alone costs: against the same design at 99%. From the relaxed baseline that
      // is the x1 yardstick itself; at the default targets (100k users) the yardstick is the 1k-user
      // design, so relativeCost would also count the raise in users.
      const at99 = monthlyCost(architecture(withAvailability(start, 0)));
      if (name === 'relaxed baseline') assert.equal(relativeCost(withAvailability(start, 0)), 1);
      const threeNines = monthlyCost(architecture(withAvailability(start, 1))) / at99;
      const fourNines = monthlyCost(architecture(withAvailability(start, 2))) / at99;
      assert.ok(threeNines < 2, `${product} at ${name}, 99.9%: x${threeNines.toFixed(2)}`);
      inRange(fourNines, 2, 3, `${product} at ${name}, 99.99%`);
    }
  }
});

test('from the Non-Functional focus on Uber, raising availability 99.9% -> 99.99% lands the cost in 2x-3x', () => {
  const focus = FOCUS_SETUPS['non-functional-requirements'];
  assert.equal(focus.product, 'uber');

  const threeNines = relativeCost(withAvailability(focus, 1));
  const fourNines = relativeCost(withAvailability(focus, 2));
  assert.ok(threeNines < 2, `99.9%: x${threeNines.toFixed(2)}`);
  inRange(fourNines, 2, 3, '99.99%');
});

test('the cost multipliers the Non-Functional Diagram, Lesson and Quiz quote come from the model', () => {
  const focus = FOCUS_SETUPS['non-functional-requirements'];
  // Diagram and Lesson: 99.9% then 99.99% from the focus start.
  assert.equal(formatCost(relativeCost(withAvailability(focus, 1))), 'x1.3');
  assert.equal(formatCost(relativeCost(withAvailability(focus, 2))), 'x3');
  // Lesson: the x1 design bills 8.5 units, the 99.9% one 11.1 and the 99.99% one 25.4.
  assert.equal(monthlyCost(architecture(focus)), 8.5);
  assert.equal(monthlyCost(architecture(withAvailability(focus, 1))).toFixed(1), '11.1');
  assert.equal(monthlyCost(architecture(withAvailability(focus, 2))).toFixed(1), '25.4');
  // Lesson: the parts of the 99.99% bill before the zone traffic, line by line.
  const fourNines = costLines(architecture(withAvailability(focus, 2)));
  assert.deepEqual(
    fourNines.map((line) => [line.id, line.instances, line.cost]),
    [['lb', 2, 0.6], ['api', 3, 3], ['ws', 3, 3], ['db', 2, 6], ['async', 3, 4.5], ['index', 3, 6], ['zones', 1, fourNines[6].cost]],
  );
  assert.equal(fourNines.slice(0, 6).reduce((total, line) => total + line.cost, 0).toFixed(1), '23.1');
  // Quiz nfr-9: Critical durability on its own.
  assert.equal(formatCost(relativeCost({ ...focus, nfr: { ...focus.nfr, durability: 1 } })), 'x1.5');
});

test('every availability step costs more than the one before', () => {
  for (const product of PRODUCTS) {
    let previous = 0;
    for (let availability = 0; availability <= 3; availability += 1) {
      const cost = relativeCost(core(product, { availability }));
      assert.ok(cost > previous, `${product} at availability level ${availability}`);
      previous = cost;
    }
  }
});

test('every copy the diagram draws is billed: the bill counts what instancesOf counts', () => {
  for (const product of PRODUCTS) {
    const every = Object.fromEntries(REQUIREMENTS[product].map((option) => [option.id, true]));
    for (const availability of [0, 1, 2, 3]) {
      const arch = architecture({ ...core(product, { availability, latency: 1 }), selected: every });
      for (const line of costLines(arch)) {
        if (line.id === 'zones' || line.id === 'region2' || line.id === 'cross-region') continue;
        assert.equal(line.instances, instancesOf(line.id, arch), `${product} ${line.id} at availability ${availability}`);
      }
    }
  }
});

test('three zones bill the traffic between them', () => {
  const oneZone = costLines(architecture(core('whatsapp', { availability: 1 })));
  const threeZones = costLines(architecture(core('whatsapp', { availability: 2 })));

  assert.equal(oneZone.find((line) => line.id === 'zones'), undefined);
  const zones = threeZones.find((line) => line.id === 'zones');
  assert.ok(zones);
  const parts = threeZones.filter((line) => line.id !== 'zones').reduce((sum, line) => sum + line.cost, 0);
  assert.equal(zones.cost, parts * CROSS_ZONE_SHARE);
});

// ---------------------------------------------------------------------------
// Instances: every copy on the diagram is billed
// ---------------------------------------------------------------------------

test('each part is billed per instance drawn', () => {
  const arch = architecture(core('uber', { availability: 2, users: 2 }));
  const lines = costLines(arch);
  const line = (id: string) => lines.find((entry) => entry.id === id);

  assert.equal(line('api')?.instances, arch.sizing.app.count);
  assert.equal(line('ws')?.instances, arch.sizing.ws.count);
  assert.equal(line('db')?.instances, arch.dbCopies * arch.sizing.database.partitions);
  assert.equal(line('lb')?.instances, 2);
  // One copy of the geo index and of the queue + workers in each of the 3 zones.
  assert.equal(line('async')?.instances, 3);
  assert.equal(line('index')?.instances, 3);
  assert.equal(line('cache')?.instances, 3);
  for (const entry of lines) {
    if (entry.id === 'zones' || entry.id === 'region2' || entry.id === 'cross-region') continue;
    assert.equal(entry.cost, entry.instances * PART_COST[entry.id], entry.label);
  }
});

test('a partitioned database bills every partition, although each one alone is a single point', () => {
  // Uber at 100M daily users and 99%: "DB: 2 partitions x1".
  const arch = architecture(core('uber', { users: 3 }));
  const db = costLines(arch).find((entry) => entry.id === 'db');

  assert.equal(arch.sizing.database.partitions, 2);
  assert.equal(arch.dbCopies, 1);
  assert.equal(db?.instances, 2);
  assert.equal(db?.cost, 2 * PART_COST.db);
});

test('more users means more instances, and more instances cost more', () => {
  for (const product of PRODUCTS) {
    let previous = 0;
    for (let users = 0; users <= 3; users += 1) {
      const cost = relativeCost(core(product, { users }));
      assert.ok(cost >= previous, `${product} at users level ${users}`);
      previous = cost;
    }
    assert.ok(relativeCost(core(product, { users: 2 })) > relativeCost(core(product, { users: 1 })), product);
  }
});

test('a database standby for critical durability is billed', () => {
  for (const product of PRODUCTS) {
    assert.ok(relativeCost(core(product, { durability: 1 })) > relativeCost(core(product)), product);
  }
});

test('the synchronous standby of critical durability bills the traffic to its second zone', () => {
  const lines = costLines(architecture(core('whatsapp', { durability: 1 })));
  const zones = lines.find((line) => line.id === 'zones');

  assert.equal(zones?.label, 'Traffic between 2 zones');
  assert.equal(lines.find((line) => line.id === 'db')?.instances, 2);
});

test('a cache for a tight latency target is billed', () => {
  assert.ok(relativeCost(core('whatsapp', { latency: 1 })) > relativeCost(core('whatsapp', { latency: 0 })));
});

test('stories bill the queue and workers of their cleanup job when nothing else needs them', () => {
  const plain = costLines(architecture({ ...core('whatsapp'), selected: { send: true, images: true } }));
  const stories = costLines(architecture({ ...core('whatsapp'), selected: { send: true, stories: true } }));

  assert.ok(plain.some((line) => line.id === 'async'), 'images already queue their resizing');
  assert.ok(stories.some((line) => line.id === 'async' && line.cost === PART_COST.async));
});

test('region 2 is a full copy of region 1, plus the writes copied to it', () => {
  const arch = architecture(core('whatsapp', { availability: 3 }));
  const lines = costLines(arch);
  const region1 = lines
    .filter((line) => line.id !== 'region2' && line.id !== 'cross-region')
    .reduce((sum, line) => sum + line.cost, 0);

  assert.equal(lines.find((line) => line.id === 'region2')?.cost, region1);
  assert.equal(lines.find((line) => line.id === 'cross-region')?.cost, region1 * CROSS_REGION_SHARE);
  assert.ok(monthlyCost(arch) > 2 * region1);
});

test('an extra feature that adds a part adds to the bill, and none takes from it', () => {
  for (const product of PRODUCTS) {
    for (const nfr of [RELAXED, DEFAULT_SETUP.nfr]) {
      const base: Setup = { ...core(product), nfr };
      for (const option of REQUIREMENTS[product].filter((entry) => !entry.core)) {
        const more: Setup = { ...base, selected: { ...base.selected, [option.id]: true } };
        const addsPart = Object.keys(architecture(more).parts).length > Object.keys(architecture(base).parts).length;
        // Pooling or scheduling on Uber reuse parts already drawn: no new box, no new line on the bill.
        if (addsPart) assert.ok(relativeCost(more) > relativeCost(base), `${product} + ${option.id}`);
        else assert.equal(relativeCost(more), relativeCost(base), `${product} + ${option.id}`);
      }
    }
  }
});

test('one requirement on its own costs less than the whole core', () => {
  const cost = relativeCost({ ...core('whatsapp'), selected: { send: true } });
  assert.ok(cost > 0 && cost < 1, `x${cost}`);
});

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

test('the multiplier reads x1, one decimal below x10 and whole numbers above', () => {
  assert.equal(formatCost(1), 'x1');
  assert.equal(formatCost(2.38), 'x2.4');
  assert.equal(formatCost(1.96), 'x2');
  assert.equal(formatCost(0.46), 'x0.5');
  assert.equal(formatCost(12.4), 'x12');
});
