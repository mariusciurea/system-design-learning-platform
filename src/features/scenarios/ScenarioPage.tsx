import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Check, Minus } from 'lucide-react';
import { AsciiBlock, ExplanationCard, TradeOffTable } from '@/components/learning';
import { Badge, difficultyTone, Tabs, type TabItem } from '@/components/ui';
import { getScenario } from '@/data/scenarios';
import { CONCEPT_BY_SLUG } from '@/data/concepts';

export function ScenarioPage() {
  const { slug } = useParams();
  const scenario = getScenario(slug);

  if (!scenario) {
    return (
      <div className="mx-auto max-w-2xl px-5 py-16 text-center">
        <h1 className="text-xl font-semibold text-ink">Scenario not found</h1>
        <p className="mt-2 text-sm text-muted">This scenario does not exist.</p>
        <Link
          to="/scenarios"
          className="mt-6 inline-flex h-10 items-center gap-2 rounded-xl border border-line px-4 text-sm font-medium text-ink transition-colors hover:border-brand hover:text-brand"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to all scenarios
        </Link>
      </div>
    );
  }

  const tabs: TabItem[] = [
    {
      id: 'requirements',
      label: '1. Requirements',
      content: (
        <div className="space-y-4">
          <ExplanationCard title="Functional requirements - what the system must DO">
            <ul className="mt-2 space-y-2">
              {scenario.functional.map((item) => (
                <li key={item.label} className="flex items-start gap-2.5">
                  {item.core ? (
                    <Check className="mt-0.5 h-4 w-4 shrink-0 text-ok" />
                  ) : (
                    <Minus className="mt-0.5 h-4 w-4 shrink-0 text-faint" />
                  )}
                  <span>
                    <span className={item.core ? 'text-ink' : 'text-faint'}>{item.label}</span>
                    {item.core ? <Badge tone="ok" className="ml-2">in scope</Badge> : <Badge className="ml-2">out of scope</Badge>}
                    {item.note ? <span className="mt-0.5 block text-xs text-faint">{item.note}</span> : null}
                  </span>
                </li>
              ))}
            </ul>
          </ExplanationCard>

          <ExplanationCard title="Non-functional requirements - how well">
            <div className="mt-2 overflow-x-auto">
              <table className="w-full min-w-[520px] text-left text-sm">
                <thead className="text-[11px] uppercase tracking-wide text-faint">
                  <tr>
                    <th className="py-2 font-medium">Attribute</th>
                    <th className="py-2 font-medium">Target</th>
                    <th className="py-2 font-medium">What it forces</th>
                  </tr>
                </thead>
                <tbody>
                  {scenario.nonFunctional.map((item) => (
                    <tr key={item.label} className="border-t border-line">
                      <td className="py-2 pr-4 text-ink">{item.label}</td>
                      <td className="py-2 pr-4 font-mono text-xs text-brand">{item.target}</td>
                      <td className="py-2 text-muted">{item.implication}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </ExplanationCard>
        </div>
      ),
    },
    {
      id: 'capacity',
      label: '2. Capacity',
      content: (
        <div className="space-y-2">
          {scenario.capacity.map((step) => (
            <div
              key={step.label}
              className="grid gap-2 rounded-xl border border-line bg-surface px-4 py-3 sm:grid-cols-[200px_1fr_auto] sm:items-center"
            >
              <span className="text-xs font-medium text-ink">{step.label}</span>
              <span className="font-mono text-[11px] text-muted">{step.formula}</span>
              <span className="font-mono text-sm font-semibold text-brand">= {step.result}</span>
            </div>
          ))}
          <p className="px-1 pt-2 text-xs text-faint">
            Round aggressively. The goal is to know whether this is a 100 req/sec system or a 100,000 req/sec system -
            they are different designs.
          </p>
        </div>
      ),
    },
    {
      id: 'design',
      label: '3. High-level design',
      content: (
        <div className="space-y-4">
          <AsciiBlock>{scenario.highLevel}</AsciiBlock>
          <ExplanationCard title="Database choice">
            <p className="font-medium text-ink">{scenario.database.choice}</p>
            <p className="mt-2">{scenario.database.reasoning}</p>
            <p className="mt-2 text-xs text-faint">
              <strong className="text-muted">Alternatives:</strong> {scenario.database.alternatives}
            </p>
          </ExplanationCard>
          <ExplanationCard title="API design">
            <ul className="mt-1 divide-y divide-line">
              {scenario.api.map((endpoint) => (
                <li key={`${endpoint.method}-${endpoint.path}`} className="py-2.5 last:pb-0">
                  <p className="break-words font-mono text-xs">
                    <span className="font-semibold text-brand">{endpoint.method}</span>{' '}
                    <span className="text-ink">{endpoint.path}</span>
                  </p>
                  <p className="mt-0.5 text-xs text-muted">{endpoint.note}</p>
                </li>
              ))}
            </ul>
          </ExplanationCard>
        </div>
      ),
    },
    {
      id: 'scaling',
      label: '4. Scaling & caching',
      content: (
        <div className="space-y-4">
          <ExplanationCard title="Scaling" items={scenario.scaling} marker="check" tone="ok" />
          <ExplanationCard title="Caching" items={scenario.caching} marker="check" />
        </div>
      ),
    },
    {
      id: 'reliability',
      label: '5. Reliability',
      content: (
        <div className="space-y-4">
          <ExplanationCard title="Reliability measures" items={scenario.reliability} marker="check" tone="ok" />
          <ExplanationCard title="Bottlenecks and fixes">
            <ul className="mt-1 divide-y divide-line">
              {scenario.bottlenecks.map((item) => (
                <li key={item.problem} className="py-2.5 last:pb-0">
                  <p className="text-sm text-ink">{item.problem}</p>
                  <p className="mt-1 text-xs text-ok">-&gt; {item.solution}</p>
                </li>
              ))}
            </ul>
          </ExplanationCard>
        </div>
      ),
    },
    {
      id: 'tradeoffs',
      label: '6. Trade-offs',
      content: (
        <div className="space-y-4">
          <TradeOffTable tradeoffs={scenario.tradeoffs} />
          <ExplanationCard title="Concepts used in this design">
            <div className="mt-2 flex flex-wrap gap-2">
              {scenario.concepts.map((slugItem) => {
                const concept = CONCEPT_BY_SLUG.get(slugItem);
                if (!concept) return null;
                return (
                  <Link
                    key={slugItem}
                    to={`/concepts/${slugItem}`}
                    className="rounded-full border border-line px-3 py-1.5 text-xs text-muted transition-colors hover:border-brand hover:text-brand"
                  >
                    {concept.title}
                  </Link>
                );
              })}
            </div>
          </ExplanationCard>
        </div>
      ),
    },
  ];

  return (
    <article>
      <header className="border-b border-line bg-surface px-5 py-6 lg:px-8">
        <div className="mx-auto max-w-5xl">
          <Link to="/scenarios" className="flex items-center gap-1.5 text-xs text-faint transition-colors hover:text-brand">
            <ArrowLeft className="h-3.5 w-3.5" />
            All scenarios
          </Link>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight text-ink lg:text-3xl">{scenario.title}</h1>
          <p className="mt-1.5 max-w-3xl text-sm text-muted">{scenario.tagline}</p>
          <Badge tone={difficultyTone(scenario.difficulty)} className="mt-3">
            {scenario.difficulty}
          </Badge>
        </div>
      </header>

      <div className="px-5 py-6 lg:px-8">
        <div className="mx-auto max-w-5xl">
          <Tabs items={tabs} />
        </div>
      </div>
    </article>
  );
}

export default ScenarioPage;
