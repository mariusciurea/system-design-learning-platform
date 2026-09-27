import type { CSSProperties } from 'react';
import type { Category, CategoryId } from '@/types';

/**
 * Left-hand navigation groups. `icon` refers to a lucide-react icon name and is
 * resolved in the sidebar so that this file stays free of JSX.
 */
export const CATEGORIES: Category[] = [
  {
    id: 'getting-started',
    title: 'Getting Started',
    blurb: 'Requirements, estimation and how to think about a design.',
    icon: 'Compass',
  },
  {
    id: 'scaling',
    title: 'Scaling',
    blurb: 'Make one machine bigger, or make many machines cooperate.',
    icon: 'TrendingUp',
  },
  {
    id: 'networking',
    title: 'Networking',
    blurb: 'How a request finds your servers and gets there fast.',
    icon: 'Globe',
  },
  {
    id: 'data',
    title: 'Data',
    blurb: 'Storing, indexing, replicating and splitting your data.',
    icon: 'Database',
  },
  {
    id: 'performance',
    title: 'Performance',
    blurb: 'Caching layers and the cost of every millisecond.',
    icon: 'Zap',
  },
  {
    id: 'distributed',
    title: 'Distributed Systems',
    blurb: 'What breaks once state lives on more than one machine.',
    icon: 'Network',
  },
  {
    id: 'communication',
    title: 'Communication',
    blurb: 'How services talk: REST, gRPC, GraphQL, streaming.',
    icon: 'ArrowLeftRight',
  },
  {
    id: 'async',
    title: 'Asynchronous Systems',
    blurb: 'Queues, events and work that happens later.',
    icon: 'Layers',
  },
  {
    id: 'reliability',
    title: 'Reliability',
    blurb: 'Staying up while individual components fail.',
    icon: 'ShieldCheck',
  },
  {
    id: 'security',
    title: 'Security',
    blurb: 'Identity, access, transport and abuse protection.',
    icon: 'Lock',
  },
  {
    id: 'architecture',
    title: 'Architecture',
    blurb: 'Monoliths, services, events - and when each fits.',
    icon: 'Boxes',
  },
  {
    id: 'observability',
    title: 'Observability',
    blurb: 'Knowing what your system is doing right now.',
    icon: 'Activity',
  },
  {
    id: 'patterns',
    title: 'Design Patterns',
    blurb: 'Reusable shapes that show up in every large system.',
    icon: 'Shapes',
  },
];

export const CATEGORY_BY_ID = Object.fromEntries(
  CATEGORIES.map((category) => [category.id, category]),
) as Record<Category['id'], Category>;

/**
 * Sets --cat to the color of one Category (the --cat-* tokens in src/styles/index.css), so
 * everything inside can use text-cat, bg-cat/10 or border-cat/30. It is a wayfinding color only:
 * status stays ok/warn/danger, and a Category is always named in text beside its color.
 */
export const categoryStyle = (id: CategoryId) => ({ '--cat': `var(--cat-${id})` }) as CSSProperties;
