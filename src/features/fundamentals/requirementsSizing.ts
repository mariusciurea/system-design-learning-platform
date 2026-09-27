/**
 * How big the Requirements Lab draws each tier, done with the same model as the Capacity Lab
 * (`capacityModel.ts`): 1,000 req/sec per app server, 50% headroom, 10,000 writes/sec for one
 * database primary. The same daily users therefore give the same app servers and the same database
 * decision on both pages.
 *
 * Every number here is a planning assumption, not a measurement. Pure: no React, so `npm test` runs it.
 */
import { exactEstimate, HEADROOM, PRIMARY_WRITE_LIMIT, type Estimate } from './capacityModel.ts';

export type Product = 'whatsapp' | 'instagram' | 'uber';

export const PRODUCTS: Product[] = ['whatsapp', 'instagram', 'uber'];

/** The daily active users behind each step of the Users slider (1k, 100k, 10M, 100M). */
export const DAU = [1_000, 100_000, 10_000_000, 100_000_000];

export interface TrafficProfile {
  /** Requests one daily user sends in a day: opening chats, scrolling, booking. */
  requestsPerUser: number;
  /** Share of those requests that write to the database, 0..1. */
  writeShare: number;
  /** How far the busiest hour sits above the daily average. */
  peakFactor: number;
}

/**
 * The everyday traffic of each product. WhatsApp uses the numbers the Capacity Lab opens on
 * (20 requests a day, 10% writes), so the two pages can be compared directly; Instagram is read
 * heavier (scrolling a feed); Uber sends few requests per rider. Illustrative planning numbers.
 */
export const TRAFFIC: Record<Product, TrafficProfile> = {
  whatsapp: { requestsPerUser: 20, writeShare: 0.1, peakFactor: 5 },
  instagram: { requestsPerUser: 30, writeShare: 0.05, peakFactor: 5 },
  uber: { requestsPerUser: 10, writeShare: 0.2, peakFactor: 5 },
};

/**
 * Uber drivers publishing their location: about 1 daily user in 10 is a driver, online 6 hours and
 * sending a location every 4 seconds (5,400 a day). Spread over every daily user that is 540 extra
 * writes each, and they land in the in-memory geo index, not in the database.
 */
export const LOCATION_WRITES_PER_USER = 540;

/** Copies of a tier an availability target asks for: 99% one, 99.9% two, 99.99% one per zone (3). */
export const AVAILABILITY_COPIES = [1, 2, 3, 3];

/** Share of daily users holding a connection open at the peak. Simplified planning assumption. */
export const CONNECTED_AT_PEAK = 0.1;
/** Held-open connections one WebSocket server keeps. Simplified planning assumption. */
export const CONNECTIONS_PER_SERVER = 50_000;
/** Reads/sec one database copy serves - the same round number as the primary write limit. */
export const READS_PER_COPY = 10_000;
/** Share of reads the cache answers before they reach the database. Illustrative. */
export const CACHE_HIT = 0.8;

export interface SizingInput {
  product: Product;
  dau: number;
  /** Availability level, 0 (99%) to 3 (99.999%). */
  availability: number;
  /** Drivers publish their location (Uber): extra writes into the geo index. */
  locationWrites: boolean;
  /** A cache sits in front of the database. */
  cache: boolean;
}

export interface TierSize {
  /** Servers the load needs at peak, before headroom. */
  atPeak: number;
  /**
   * Servers for the load with the Capacity Lab headroom. When the whole load fits one server the
   * headroom would be a whole spare server, and whether to keep a spare is what the availability
   * target decides - so it is left to `forAvailability`.
   */
  forLoad: number;
  /** Copies the availability target asks for. */
  forAvailability: number;
  count: number;
  /** Which of the two set `count`. */
  setBy: 'load' | 'availability';
}

export interface Sizing {
  /** Everything the app tier serves, per daily user - what to type into the Capacity Lab to compare. */
  requestsPerUser: number;
  writeShare: number;
  peakQps: number;
  /** Every write at peak, wherever it lands. */
  peakWriteQps: number;
  app: TierSize;
  ws: TierSize & { connections: number };
  database: {
    /** Every read at peak that the product sends the database, before any cache answers it. */
    peakReadQps: number;
    peakWriteQps: number;
    /** The Capacity Lab decision: past one primary write limit, the writes are partitioned. */
    partitioned: boolean;
    partitions: number;
    /** Read replicas per partition, for the reads the cache does not answer. */
    readReplicas: number;
  };
  /** Writes that land in the in-memory geo index (Uber locations). */
  index: { peakWriteQps: number };
  /** A cache answers most reads before the database. */
  cached: boolean;
}

function tier(atPeak: number, withHeadroom: number, availability: number): TierSize {
  const forLoad = atPeak <= 1 ? 1 : withHeadroom;
  const forAvailability = AVAILABILITY_COPIES[availability] ?? 1;
  const count = Math.max(forLoad, forAvailability);
  return { atPeak, forLoad, forAvailability, count, setBy: forAvailability > forLoad ? 'availability' : 'load' };
}

function estimate(dau: number, requestsPerUser: number, writeShare: number, peakFactor: number): Estimate {
  // Object size, retention and replication only feed storage, which this lab does not draw.
  return exactEstimate({ dau, requestsPerUser, writeShare, peakFactor, objectSizeKb: 1, retentionYears: 1, replicationFactor: 3 });
}

export function sizeRequirements({ product, dau, availability, locationWrites, cache }: SizingInput): Sizing {
  const profile = TRAFFIC[product];
  const extraWrites = locationWrites ? LOCATION_WRITES_PER_USER : 0;
  const requestsPerUser = profile.requestsPerUser + extraWrites;
  const writeShare = (profile.requestsPerUser * profile.writeShare + extraWrites) / requestsPerUser;

  // The app tier serves every request; the database sees only the product's own writes and reads.
  const total = extraWrites > 0 ? estimate(dau, requestsPerUser, writeShare, profile.peakFactor) : null;
  const db = estimate(dau, profile.requestsPerUser, profile.writeShare, profile.peakFactor);
  const all = total ?? db;

  const partitioned = db.peakWriteQps > PRIMARY_WRITE_LIMIT;
  const partitions = partitioned ? Math.ceil(db.peakWriteQps / PRIMARY_WRITE_LIMIT) : 1;
  const readsPerPartition = (db.peakReadQps * (cache ? 1 - CACHE_HIT : 1)) / partitions;
  const readReplicas = Math.max(0, Math.ceil(readsPerPartition / READS_PER_COPY) - 1);

  const connections = dau * CONNECTED_AT_PEAK;
  const wsAtPeak = Math.max(1, Math.ceil(connections / CONNECTIONS_PER_SERVER));

  return {
    requestsPerUser,
    writeShare,
    peakQps: all.peakQps,
    peakWriteQps: all.peakWriteQps,
    app: tier(all.serversAtPeak, all.servers, availability),
    ws: { ...tier(wsAtPeak, Math.ceil(wsAtPeak * HEADROOM), availability), connections },
    database: { peakReadQps: db.peakReadQps, peakWriteQps: db.peakWriteQps, partitioned, partitions, readReplicas },
    index: { peakWriteQps: total ? total.peakWriteQps - db.peakWriteQps : 0 },
    cached: cache,
  };
}

/**
 * What the daily-users target forces, read from the sizing rather than from the slider alone - so
 * 100k users at 116 req/sec do not claim a horizontal tier and read replicas the diagram does not draw.
 */
export function scaleImplications(sizing: Sizing, usersLevel: number, database: boolean): string[] {
  const lines: string[] = [];
  if (sizing.app.forLoad > 1) lines.push('Horizontal app tier behind a load balancer');
  if (sizing.cached && usersLevel >= 2) lines.push('Caching layer for hot reads');
  if (database && sizing.database.readReplicas > 0) lines.push('Read replicas');
  if (database && sizing.database.partitioned) lines.push('Writes split across database partitions');
  if (usersLevel >= 2) lines.push('Async processing for anything slow');
  if (usersLevel >= 3) lines.push('Region 2: a full copy of region 1, and DNS sends users to the nearest');
  if (lines.length === 0) lines.push('One app server still carries the load');
  return lines;
}
