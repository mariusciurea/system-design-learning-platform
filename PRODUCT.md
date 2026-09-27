# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

The primary Learner is a junior developer who studies system design on their own, at their own pace,
and has often never met the idea before. A real second use is a developer getting ready for a system
design interview, who needs to cover many Concepts quickly and check their understanding. Study comes
first: when the two pull apart, favour the junior who is learning the idea for the first time.

A Learner may be a Guest (no Account, progress in this browser only) or signed in to an Account
(progress saved to the server and shared across devices). Every page must work fully for a Guest.

## Product Purpose

System Design Interactive teaches system design by letting the Learner change a running simulation and
watch the outcome change. It exists because reading that "a load balancer spreads requests" does not
build intuition; setting the traffic, adding a server, killing one and watching health checks pull it
out of the pool does.

It is a free, public site. Success means Learners understand the trade-off behind each Concept, pass
its Quiz, and come back to study the next one.

## Positioning

Every Concept is backed by a Lab the Learner drives, not just a page to read. Each Concept leads with a
running Diagram and a Walkthrough, then a Lab where changing a control changes the result, then its
Trade-offs and a scenario Quiz. The Diagram and the Lab tell the same story with the same parts and the
same Example product, so the Lab reads as the Diagram made adjustable.

The product rule: if a page's only possible action is scrolling, it is not finished.

## Operating Context

- Mostly used on a desktop or laptop browser, because Diagrams need space. Tablets and phones are
  supported: the sidebar becomes an overlay and a Diagram scrolls sideways inside its card rather
  than shrinking past readability.
- The Learner moves between Concepts grouped by Category (Scaling, Caching, Databases, and so on),
  plus six Tools above the Categories: Interactive Labs, Playground, System Evolution, Compare Mode,
  Scenarios and Glossary.
- Progress is local-first: saved in the browser at once, then synced in the background for a signed-in
  Learner. Nothing waits for the server.
- No Learning path exists yet: Concepts have no set order or prerequisites (deferred on 2026-09-23).

## Capabilities and Constraints

- 102 Concepts across the Categories, each with a Diagram with a Walkthrough, a Lab, a long-form
  Lesson, Trade-offs and a Quiz of at least 10 scenario questions. Passing a Quiz with 70% or more
  makes a Concept Done.
- Browser-first React app (Vite, TypeScript, Tailwind). The one backend is the optional Account API
  (FastAPI + Postgres, sign-in by Firebase Auth), which only saves progress.
- A Guest never downloads the Firebase SDK and makes no network calls.
- Build-time gates enforce content and visual rules: every Concept has its Lesson, Lab and Quiz;
  Diagrams have no overlapping boxes, truncated labels or dishonest wiring; the initial JS stays under
  its gzip budget.
- Domain terms are fixed in `CONTEXT.md` (Concept, Category, Lesson, Diagram, Walkthrough, Lab, Lab
  focus, Example product, Trade-offs, Quiz, Tools, Playground, Learner, Account, Guest, Done). Use them
  and avoid their listed synonyms.

## Brand Commitments

- Name: System Design Interactive. Tagline in the README: "Learn. Visualize. Experiment. Design."
- Trade-off first: never say "X is better than Y"; say what X gains and what X costs.
- Visualization first, short explanation second, deep explanation optional. The product complaint that
  shaped the app was "too much text".
- Animation must explain: nothing moves for decoration.
- Diagrams must be true, not balanced: replicas have identical wiring, and any deliberate asymmetry is
  stated.
- Honest models: where a number is a heuristic rather than a measurement, the UI says so.
- Plain, simple English in the UI and Lessons, written for a junior.

## Evidence on Hand

- The content itself: 102 Concepts with Diagrams (`src/data/visuals/`), Lessons
  (`src/data/concepts/deep/`), Labs (`src/features/`) and Quizzes.
- Internal review notes in `docs/findings/`.
- No Learner quotes, testimonials, user numbers or press exist. Future work must not invent them.

## Product Principles

1. Doing beats reading: every Concept earns its place with something the Learner can change.
2. Show the trade-off, never a winner.
3. Teach the problem before the component: show what went wrong that made the component useful.
4. Truth over polish: a Diagram or a number that looks right but teaches the wrong thing is a defect.
5. Never gate learning: a Guest gets everything, and no page waits for a server.

## Accessibility & Inclusion

- Status is never shown by color alone: particles have distinct shapes and every state has a text label.
- Text is never smaller than 11px.
- Touch targets are at least 44x44px on a touch screen.
- Real form controls with labels, visible focus rings and full keyboard use.
- Pause/Play on every running Diagram, which starts paused under `prefers-reduced-motion`.
- Dark and light themes are both first-class; dark is the default when the OS does not ask for light.
