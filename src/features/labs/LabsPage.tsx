import { useState } from 'react';
import { Link } from 'react-router-dom';
import { FlaskConical } from 'lucide-react';
import { Badge, difficultyTone, SegmentedControl } from '@/components/ui';
import { CATEGORY_BY_ID, categoryStyle } from '@/data/categories';
import { CategoryTag } from '@/data/categoryIcons';
import type { Difficulty } from '@/types';
import { LABS } from './registry';

export function LabsPage() {
  const [difficulty, setDifficulty] = useState<Difficulty | 'all'>('all');
  const labs = LABS.filter((lab) => difficulty === 'all' || lab.difficulty === difficulty);

  return (
    <div className="px-5 py-8 lg:px-8">
      <div className="mx-auto max-w-6xl">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-ink">Interactive Labs</h1>
            <p className="mt-1.5 max-w-2xl text-sm text-muted">
              {LABS.length} simulations you can actually change: move traffic, add servers, kill nodes, pick
              algorithms, and watch the consequences in live metrics.
            </p>
          </div>
          {/* On a phone the filter wraps under the title onto a full-width row
              that its four options share; from sm up it hugs its labels. */}
          <SegmentedControl
            value={difficulty}
            size="sm"
            fill
            className="sm:w-auto"
            options={[
              { value: 'all', label: 'All' },
              { value: 'Beginner', label: 'Beginner' },
              { value: 'Intermediate', label: 'Intermediate' },
              { value: 'Advanced', label: 'Advanced' },
            ]}
            onChange={setDifficulty}
          />
        </header>

        <div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {labs.map((lab) => (
            <Link
              key={lab.id}
              to={`/labs/${lab.id}`}
              style={categoryStyle(lab.category)}
              className="group flex flex-col rounded-2xl border border-line bg-surface p-5 transition-all hover:border-brand/50 hover:shadow-card"
            >
              <div className="flex items-start justify-between gap-3">
                <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-cat/10 text-cat">
                  <FlaskConical className="h-5 w-5" />
                </span>
                <Badge tone={difficultyTone(lab.difficulty)}>{lab.difficulty}</Badge>
              </div>
              <h2 className="mt-3 text-sm font-semibold text-ink group-hover:text-brand">{lab.title}</h2>
              <p className="mt-1.5 flex-1 text-xs leading-relaxed text-muted">{lab.blurb}</p>
              <CategoryTag category={CATEGORY_BY_ID[lab.category]} className="mt-3" />
            </Link>
          ))}
        </div>

        {labs.length === 0 ? (
          <p className="mt-10 text-center text-sm text-muted">No labs at this difficulty.</p>
        ) : null}
      </div>
    </div>
  );
}

export default LabsPage;
