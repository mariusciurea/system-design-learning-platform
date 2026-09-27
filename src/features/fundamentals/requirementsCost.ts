/**
 * The monthly bill of a Requirements Lab design, relative to the simplest design of the same product.
 *
 * Simplified model: every part drawn is billed per instance at a fixed weight (one app server = 1),
 * times BIGGER_MACHINE_PRICE when it runs on the largest machine,
 * three zones add the traffic between them, and region 2 is billed as a full copy of region 1 plus
 * the writes copied to it. Real bills depend on the provider, the machine sizes and the traffic;
 * the weights are round ratios chosen so the comparisons point the right way, not a price list.
 *
 * Pure: no React and only relative imports, so `npm test` runs it.
 */
import {
  BIGGER_MACHINE_PRICE,
  RELAXED,
  architecture,
  coreOf,
  instancesOf,
  type Architecture,
  type InstancedPart,
  type Setup,
} from './requirementsArchitecture.ts';
import type { Product } from './requirementsSizing.ts';

/** A part with a bill of its own. Users are not billed; region 2 is billed as a copy of region 1. */
export type CostedPart = InstancedPart;

/**
 * Relative monthly cost of one instance, one app server = 1. Illustrative ratios:
 * - a database copy is a bigger machine with fast disks and backups, so about 3 app servers;
 * - a managed load balancer node costs a fraction of a server, but it always runs as a pair;
 * - a cache is a memory-heavy node; queue + workers is a queue plus at least one worker;
 * - an in-memory geo or search index is a small cluster of its own;
 * - object storage and a CDN are billed by use, about one server at these sizes;
 * - media servers relay voice and video, so they pay for bandwidth as well as compute.
 */
export const PART_COST: Record<CostedPart, number> = {
  api: 1,
  ws: 1,
  db: 3,
  lb: 0.3,
  cache: 1.5,
  async: 1.5,
  index: 2,
  objects: 1,
  cdn: 1,
  media: 2,
};

/** Traffic between three zones, as a share of what runs in them. Illustrative. */
export const CROSS_ZONE_SHARE = 0.1;
/** Writes copied to region 2, as a share of what region 1 costs. Illustrative. */
export const CROSS_REGION_SHARE = 0.1;

const LINE_LABEL: Record<CostedPart, string> = {
  api: 'App servers',
  ws: 'WebSocket servers',
  db: 'Database copies',
  lb: 'Load balancers',
  cache: 'Cache',
  async: 'Queue + workers',
  index: 'Index',
  objects: 'Object storage',
  cdn: 'CDN',
  media: 'Media servers',
};

/** The billing order: the order parts are laid out in. */
const COSTED: CostedPart[] = ['cdn', 'lb', 'media', 'objects', 'api', 'ws', 'db', 'async', 'index', 'cache'];

export interface CostLine {
  id: CostedPart | 'zones' | 'region2' | 'cross-region';
  label: string;
  /** Instances billed; 1 for the traffic and region lines. */
  instances: number;
  cost: number;
}

/** The bill line by line: each part drawn, then zone traffic, then region 2. */
export function costLines(arch: Architecture): CostLine[] {
  const lines: CostLine[] = [];
  for (const id of COSTED) {
    if (!arch.parts[id]) continue;
    const instances = instancesOf(id, arch);
    // The largest machine is billed at its price in standard ones, a premium over its capacity.
    const price = arch.machineSize[id] ? BIGGER_MACHINE_PRICE : 1;
    lines.push({ id, label: LINE_LABEL[id], instances, cost: instances * PART_COST[id] * price });
  }
  if (lines.length === 0) return lines;

  const parts = sum(lines);
  if (arch.zones > 1) {
    lines.push({ id: 'zones', label: `Traffic between ${arch.zones} zones`, instances: 1, cost: parts * CROSS_ZONE_SHARE });
  }
  if (arch.region2) {
    const region1 = sum(lines);
    lines.push({ id: 'region2', label: 'Region 2, a full copy', instances: 1, cost: region1 });
    // Only stored writes cross to region 2 (the dashed wire), so without a database nothing does.
    if (arch.parts.db) {
      lines.push({ id: 'cross-region', label: 'Writes copied to region 2', instances: 1, cost: region1 * CROSS_REGION_SHARE });
    }
  }
  return lines;
}

const sum = (lines: CostLine[]) => lines.reduce((total, line) => total + line.cost, 0);

/** Monthly cost in app-server units. 0 when nothing is built. */
export const monthlyCost = (arch: Architecture) => sum(costLines(arch));

/** The yardstick of a product: its core features at the relaxed targets, one copy of everything. */
export const simplestSetup = (product: Product): Setup => ({
  product,
  selected: coreOf(product),
  nfr: RELAXED,
  panel: 'targets',
});

/** Monthly cost as a multiple of the simplest design of the same product (x1). */
export function relativeCost(setup: Setup, arch: Architecture = architecture(setup)): number {
  return monthlyCost(arch) / monthlyCost(architecture(simplestSetup(setup.product)));
}

/** "x1", "x2.4", "x0.5"; whole numbers from x10, where a decimal would suggest precision. */
export function formatCost(multiple: number): string {
  return `x${multiple >= 10 ? Math.round(multiple) : Number(multiple.toFixed(1))}`;
}
