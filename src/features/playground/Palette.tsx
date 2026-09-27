import { useState } from 'react';
import { Info } from 'lucide-react';
import { NODE_KINDS, NODE_KIND_LIST } from '@/components/architecture';
import { formatNumber } from '@/utils/format';
import { cn } from '@/utils/cn';
import type { NodeKind } from '@/types';

/** The drag payload type a palette item carries onto the canvas. */
export const NODE_DRAG_TYPE = 'application/sdi-node';

/**
 * The component list: drag an item onto the canvas, or click or tap it to add it in the middle of the
 * view. Each item's description sits behind its own info button, so it is reachable without hover.
 */
export function Palette({ onAdd }: { onAdd: (kind: NodeKind) => void }) {
  const [openInfo, setOpenInfo] = useState<NodeKind | null>(null);

  return (
    <div>
      {/* A finger cannot drag out of a sheet that covers the canvas, so a touch screen gets only the tap path. */}
      <p className="mb-3 text-[11px] leading-relaxed text-faint coarse:hidden">
        Drag onto the canvas, or click or tap to add in the middle of the view. To connect two nodes, drag from the bottom
        handle to the top handle of another, or select one and use Connect in the inspector.
      </p>
      <p className="mb-3 hidden text-[11px] leading-relaxed text-faint coarse:block">
        Tap to add in the middle of the view. To connect two nodes, select one and use Connect in the inspector.
      </p>
      <ul className="space-y-1.5">
        {NODE_KIND_LIST.map((kind) => {
          const style = NODE_KINDS[kind];
          const infoOpen = openInfo === kind;
          const infoId = `palette-info-${kind}`;
          return (
            <li key={kind} className="rounded-lg border border-line transition-colors hover:border-brand/60">
              <div className="flex items-stretch">
                <button
                  type="button"
                  draggable
                  onDragStart={(event) => event.dataTransfer.setData(NODE_DRAG_TYPE, kind)}
                  onClick={() => onAdd(kind)}
                  aria-label={`Add ${style.label}`}
                  className="flex min-h-10 min-w-0 flex-1 items-center gap-2 rounded-l-lg px-2.5 py-2 text-left transition-colors hover:bg-elevated coarse:min-h-11"
                >
                  <span className={cn('flex h-6 w-6 shrink-0 items-center justify-center rounded', style.accent)}>
                    <style.Icon className="h-3.5 w-3.5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[11px] font-medium text-ink">{style.label}</span>
                    {style.capacity > 0 ? (
                      <span className="block font-mono text-[11px] text-faint">
                        {formatNumber(style.capacity)} req/s
                      </span>
                    ) : null}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => setOpenInfo(infoOpen ? null : kind)}
                  aria-label={`About ${style.label}`}
                  aria-expanded={infoOpen}
                  aria-controls={infoId}
                  className={cn(
                    'flex w-9 shrink-0 items-center justify-center rounded-r-lg text-faint transition-colors hover:bg-elevated hover:text-ink',
                    infoOpen && 'text-brand',
                  )}
                >
                  <Info className="h-3.5 w-3.5" />
                </button>
              </div>
              <p
                id={infoId}
                hidden={!infoOpen}
                className="border-t border-line px-2.5 py-2 text-[11px] leading-relaxed text-muted"
              >
                {style.blurb}
              </p>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
