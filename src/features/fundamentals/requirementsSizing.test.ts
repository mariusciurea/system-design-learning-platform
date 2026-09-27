import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exactEstimate, PRIMARY_WRITE_LIMIT } from './capacityModel.ts';
import { DAU, PRODUCTS, TRAFFIC, scaleImplications, sizeRequirements, type Product, type SizingInput } from './requirementsSizing.ts';

const RELAXED = 0;
const AVAILABILITY_999 = 1;

const input = (product: Product, dau: number, overrides: Partial<SizingInput> = {}): SizingInput => ({
  product,
  dau,
  availability: RELAXED,
  locationWrites: false,
  cache: false,
  ...overrides,
});

/** The Capacity Lab, fed the traffic profile the Requirements Lab uses for a product. */
const capacityLab = (product: Product, dau: number) =>
  exactEstimate({
    dau,
    requestsPerUser: TRAFFIC[product].requestsPerUser,
    writeShare: TRAFFIC[product].writeShare,
    peakFactor: TRAFFIC[product].peakFactor,
    objectSizeKb: 1,
    retentionYears: 1,
    replicationFactor: 3,
  });

test('at 10M users WhatsApp gets the 18 servers and the one primary the Capacity Lab opens on', () => {
  const sizing = sizeRequirements(input('whatsapp', 10_000_000, { availability: AVAILABILITY_999 }));

  assert.equal(sizing.app.count, 18);
  assert.equal(sizing.database.partitioned, false);
});

test('for the same daily users the app tier matches the Capacity model on every product', () => {
  for (const product of PRODUCTS) {
    for (const dau of DAU) {
      const capacity = capacityLab(product, dau);
      const sizing = sizeRequirements(input(product, dau, { availability: AVAILABILITY_999 }));

      assert.equal(sizing.app.count, capacity.servers, `${product} at ${dau} users`);
      assert.equal(sizing.peakQps, capacity.peakQps, `${product} at ${dau} users`);
    }
  }
});

test('for the same daily users the database decision matches the Capacity model on every product', () => {
  for (const product of PRODUCTS) {
    for (const dau of DAU) {
      const capacity = capacityLab(product, dau);
      const sizing = sizeRequirements(input(product, dau));

      assert.equal(sizing.database.partitioned, capacity.peakWriteQps > PRIMARY_WRITE_LIMIT, `${product} at ${dau} users`);
      assert.equal(sizing.database.peakWriteQps, capacity.peakWriteQps, `${product} at ${dau} users`);
    }
  }
});

test('above one server of load the headroom counts the same whatever the availability target', () => {
  const relaxed = sizeRequirements(input('whatsapp', 10_000_000));

  assert.equal(relaxed.app.count, capacityLab('whatsapp', 10_000_000).servers);
  assert.equal(relaxed.app.setBy, 'load');
});

test('100k users at relaxed targets need one app server and no read replicas', () => {
  const sizing = sizeRequirements(input('whatsapp', 100_000));

  assert.equal(sizing.app.count, 1);
  assert.equal(sizing.database.readReplicas, 0);
  assert.equal(sizing.database.partitioned, false);
});

test('a second server that only the availability target asks for is labelled as coming from availability', () => {
  const sizing = sizeRequirements(input('whatsapp', 100_000, { availability: AVAILABILITY_999 }));

  assert.equal(sizing.app.forLoad, 1);
  assert.equal(sizing.app.forAvailability, 2);
  assert.equal(sizing.app.count, 2);
  assert.equal(sizing.app.setBy, 'availability');
});

test('Uber drivers publishing locations write far faster than WhatsApp at the same user count', () => {
  const uber = sizeRequirements(input('uber', 10_000_000, { locationWrites: true }));
  const whatsapp = sizeRequirements(input('whatsapp', 10_000_000));

  assert.ok(uber.peakWriteQps > 10 * whatsapp.peakWriteQps, `${uber.peakWriteQps} vs ${whatsapp.peakWriteQps}`);
  // The location writes land in the in-memory geo index, not in the database.
  assert.ok(uber.index.peakWriteQps > 10 * whatsapp.peakWriteQps);
  assert.ok(Math.abs(uber.peakWriteQps - (uber.index.peakWriteQps + uber.database.peakWriteQps)) < 1e-6);
});

test('the location writes load the app tier too, so Uber needs more app servers', () => {
  const withLocations = sizeRequirements(input('uber', 10_000_000, { locationWrites: true }));
  const without = sizeRequirements(input('uber', 10_000_000));

  assert.ok(withLocations.app.count > without.app.count);
  assert.equal(without.index.peakWriteQps, 0);
});

test('with location writes the app tier still matches the Capacity model fed the whole traffic', () => {
  const sizing = sizeRequirements(input('uber', 10_000_000, { locationWrites: true }));
  const capacity = exactEstimate({
    dau: 10_000_000,
    requestsPerUser: sizing.requestsPerUser,
    writeShare: sizing.writeShare,
    peakFactor: TRAFFIC.uber.peakFactor,
    objectSizeKb: 1,
    retentionYears: 1,
    replicationFactor: 3,
  });

  assert.equal(sizing.app.count, capacity.servers);
  assert.equal(sizing.peakWriteQps, capacity.peakWriteQps);
});

test('the WebSocket tier is sized by held-open connections, not by the app server count', () => {
  const whatsapp = sizeRequirements(input('whatsapp', 10_000_000));
  const uber = sizeRequirements(input('uber', 10_000_000, { locationWrites: true }));

  assert.ok(whatsapp.ws.connections > 0);
  assert.notEqual(whatsapp.ws.count, whatsapp.app.count);
  // Same users online, same connections: the far larger Uber request rate does not change it.
  assert.equal(uber.ws.connections, whatsapp.ws.connections);
  assert.equal(uber.ws.count, whatsapp.ws.count);
  assert.ok(uber.app.count > whatsapp.app.count);
});

test('the WebSocket tier grows with the connections it holds', () => {
  const small = sizeRequirements(input('whatsapp', 100_000));
  const large = sizeRequirements(input('whatsapp', 100_000_000));

  assert.equal(small.ws.count, 1);
  assert.ok(large.ws.count > 10 * small.ws.count);
});

test('writes past what one primary absorbs split the database into partitions', () => {
  const sizing = sizeRequirements(input('whatsapp', 100_000_000));

  assert.equal(sizing.database.partitioned, true);
  assert.equal(sizing.database.partitions, Math.ceil(sizing.database.peakWriteQps / PRIMARY_WRITE_LIMIT));
});

test('read replicas appear only when reads outgrow one copy, and a cache in front delays them', () => {
  const noCache = sizeRequirements(input('instagram', 100_000_000));
  const withCache = sizeRequirements(input('instagram', 100_000_000, { cache: true }));

  assert.ok(noCache.database.readReplicas > 0);
  assert.ok(withCache.database.readReplicas < noCache.database.readReplicas);
});

test('the scale lines name only what the sizing actually adds', () => {
  const small = scaleImplications(sizeRequirements(input('whatsapp', 100_000)), 1, true);
  const huge = scaleImplications(sizeRequirements(input('whatsapp', 100_000_000)), 3, true);
  // Uber with only locations ticked has no database to replicate or partition.
  const noDatabase = scaleImplications(sizeRequirements(input('uber', 100_000_000)), 3, false);

  assert.deepEqual(small, ['One app server still carries the load']);
  assert.ok(!noDatabase.some((line) => /replica|partition/i.test(line)));
  assert.ok(huge.includes('Horizontal app tier behind a load balancer'));
  assert.ok(huge.includes('Writes split across database partitions'));
  assert.ok(huge.some((line) => line.startsWith('Region 2')));
});
