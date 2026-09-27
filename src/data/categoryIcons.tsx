import {
  Activity,
  ArrowLeftRight,
  Boxes,
  Circle,
  Compass,
  Database,
  Globe,
  Layers,
  Lock,
  Network,
  Shapes,
  ShieldCheck,
  TrendingUp,
  Zap,
} from 'lucide-react';
import type { ComponentType } from 'react';
import type { Category } from '@/types';
import { cn } from '@/utils/cn';
import { categoryStyle } from './categories';

/**
 * Explicit icon map for the navigation.
 *
 * Importing the whole lucide-react namespace to resolve icons by name pulls
 * every icon into the main bundle, so the icons used by categories are listed
 * here instead.
 */
const ICONS: Record<string, ComponentType<{ className?: string }>> = {
  Activity,
  ArrowLeftRight,
  Boxes,
  Compass,
  Database,
  Globe,
  Layers,
  Lock,
  Network,
  Shapes,
  ShieldCheck,
  TrendingUp,
  Zap,
};

export function CategoryIcon({ name, className }: { name: string; className?: string }) {
  const Icon = ICONS[name] ?? Circle;
  return <Icon className={className} />;
}

/**
 * A Category with its icon in its own color: a chip (concept and lab headers) or a plain inline
 * label (the foot of a lab card). The chip sits beside the Difficulty badge, so its text stays
 * neutral and only the icon and a faint tint carry the color. The name is always there, so the
 * color is never the only cue.
 */
export function CategoryTag({
  category,
  variant = 'inline',
  className,
}: {
  category: Pick<Category, 'id' | 'title' | 'icon'>;
  variant?: 'chip' | 'inline';
  className?: string;
}) {
  return (
    <span
      style={categoryStyle(category.id)}
      className={cn(
        variant === 'chip'
          ? 'chip border-cat/25 bg-cat/[0.06] text-muted'
          : 'inline-flex items-center gap-1.5 text-[11px] font-medium text-cat',
        className,
      )}
    >
      <CategoryIcon name={category.icon} className="h-3 w-3 shrink-0 text-cat" />
      {category.title}
    </span>
  );
}
