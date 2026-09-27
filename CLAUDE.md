# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this project is

**System Design Interactive** — a browser-first educational application for learning system design
through simulations the learner can manipulate. It is not a documentation site: every major concept
is backed by a lab where changing a control changes the outcome.

Every page works as a Guest, with no network calls. The one backend is the optional Account in
`server/` (FastAPI + Postgres + SQLAlchemy Core, sign-in rented from Firebase Auth): it checks Firebase
ID tokens against the Google public keys (only `FIREBASE_PROJECT_ID`, no service account) and saves
only progress, one row per Concept per Account. See `docs/adr/0001-backend-with-rented-auth.md` and
the Learner / Account / Guest terms in `CONTEXT.md`.

Non-negotiable product rule: **if a page's only possible action is scrolling, it is not finished.**

## Commands

```bash
npm install      # install dependencies
npm run dev      # dev server on http://localhost:5173
npm run build    # check:visuals + check:content + tsc -b + vite build + check:bundle  (must pass)
npm run lint     # ESLint (typescript-eslint + react-hooks); CI fails on any finding
npm test         # the src/**/*.test.ts and scripts/**/*.test.ts files, on Node's own runner (node --test)
npm run check:visuals   # diagram geometry + wiring (concept, evolution and every Lab): overlap, overflow, truncated labels, replica consistency
npm run check:content   # every concept has its long-form lesson, a Lab and a 10-question Quiz, and sits in its category file
npm run check:bundle    # initial JS (entry + modulepreloads) stays under the gzip budget
npm run preview  # serve the production build
npx tsc --noEmit -p tsconfig.app.json   # fast typecheck of src/ only
```

The API (`server/`, Python 3.12, managed with uv):

```bash
docker compose up db                     # Postgres 17 on localhost:5432 (needs DATABASE_URL in .env)
cd server && uv sync                     # install the API and its dev tools
cd server && uv run --env-file ../.env uvicorn app.main:create_app --factory --reload --port 8000
cd server && uv run ruff check . && uv run ruff format --check . && uv run mypy . && uv run pytest -q
```

Server tests run on SQLite by default and on Postgres when `TEST_DATABASE_URL` is set; they drop the
tables of the database they point at, so never point it at a real one. Every variable name is in
`.env.example`; the real values live in the gitignored root `.env`.

`npm test` covers pure logic only, with no test dependency: Node (22.18 or later) runs the `.ts` files as they are,
so tested code imports nothing but types and relative `.ts` files - no React, no `@/` alias
(`src/app/providers/progressState.ts` is the example). `npm run build` is the gate: it typechecks
in strict mode (including `noUnusedLocals`/`noUnusedParameters`), bundles, and enforces the bundle
budget. `.github/workflows/ci.yml` runs `npm ci`, `lint`, `test`, `build` and
`npm audit --omit=dev --audit-level=high` on every push to master or staging and every PR, and a second
`server` job runs ruff, mypy and pytest against a Postgres service.

ESLint turns off the React Compiler rules `refs`, `purity` and `immutability` on purpose - they
forbid the ref-based simulation pattern below. `set-state-in-effect` stays on: derive state during
render where you can, and only suppress it with a comment saying what external thing is synced.

## Architecture

```
src/
├── app/            App, router, providers (theme, progress, layout)
├── components/
│   ├── architecture/   DiagramCanvas, ArchNode, geometry, node kinds  <- shared visual language
│   ├── charts/         LiveChart (plain SVG, no chart library), DistributionBar
│   ├── layout/         AppShell, Sidebar, TopBar, CommandSearch
│   ├── learning/       LabShell, MetricsPanel, QuizCard, TradeOffTable, RequestInspector
│   └── ui/             Button, Slider, Toggle, Tabs, Meter, Stat, ... (barrel: ui/index.ts)
├── data/           concepts/ (per category), scenarios/, glossary, categories  <- all content
│   └── concepts/deep/  long-form lesson per concept, code-split per category
├── features/       one folder per domain; labs and pages live here
├── hooks/          useRerender, useMediaQuery, useFitScale, ...
├── simulations/
│   ├── engine/     useTicker, MetricWindow, RateCounter, useSeries, useEventLog, particles
│   └── models/     computeLoad (queueing model), machine tiers
├── types/          Concept, LabId, SystemNode, SimulatedRequest, ...
└── utils/          cn, math, format, search

server/             the optional Account API (FastAPI)
├── app/            main.py (create_app factory), auth.py (token check), store.py (Account, progress,
│                   delete + tombstone), merge.py, schemas.py, db.py, settings.py, limits.py
├── tests/          pytest, tokens signed with a test key - no network
└── railway.json    the API deploy config (the root railway.json builds the web app)
```

### The Account (sign-in and progress sync)

- `src/features/account/firebase.ts` is the only module that imports `firebase/*`, and it is reached
  only by `import()`. A Guest never downloads it: it loads when the Learner clicks Sign in, or at start
  when localStorage has the `sdi:account` mark ("was signed in here").
- `AccountProvider` wraps `ProgressProvider`. `useAccount()` gives the status, `openSignIn`,
  `signOut` and `request(path)` for API calls: it adds the token, never throws, and turns a 410
  (a deleted Account) into a sign-out. Nothing renders waiting for the server.
- Progress sync is local-first and lives in `src/app/providers/progressSync.ts` (pure, runs on
  Node); `ProgressProvider` only wires it to React and window events. Every change is saved to
  localStorage, and its slug goes into the outbox `sdi:progress:outbox`, which is sent 2 s after the
  last change with `POST /progress` (only the changed Concepts). The answer is all the Account
  progress, so a push is also a pull; `GET /progress` is used only when the outbox is empty. A
  failure retries after 5 s, doubling up to 5 min, and again on `online` and when the tab shows.
- Every save merges into what is stored, so two tabs never overwrite each other; a stored progress
  that was removed or emptied (a sign-out, a Guest Reset) empties the other tabs.
- A Guest Reset empties the browser (a Guest has no other device to reach). A signed-in Reset writes
  cleared-at records for every Concept and sends them, so an offline device cannot bring old
  progress back. A Guest browser drops leftover cleared-at records on load and at sign-in.
- Delete my Account runs in this order: re-authenticate (Google popup or password), `DELETE /me`,
  then Firebase `deleteUser`, then sign out to an empty Guest. If `DELETE /me` fails, nothing is
  deleted; if its answer is lost, trying again finishes the job. While it runs, a 410 does not sign
  out (the Firebase user must still be deleted), and `deleteUser` uses the user kept at re-auth.
- A tab that loaded as a Guest never loads Firebase, so it follows the `sdi:account` mark instead:
  when another tab sets it, this tab restores the Account (`afterMarkChange` in `accountState.ts`).
- A sync failure that a retry will not fix (a 401, 403 or 404: a wrong API address or Firebase
  project) is still retried, and said once in the console.
- `onSignedOut` is where local state is emptied: empty it, never Reset it - a Reset writes cleared-at
  records, and those would wipe the Account at the next sign-in.
- Open a Firebase popup synchronously inside the click handler, with no `await` before it, or the
  browser blocks the popup. Email and password actions have no popup, so they may wait for the SDK.
- Sign-in is Google (popup) or email and password (sign in, create account, "Forgot password?").
  The confirm email is sent after sign-up but never required - the server does not check
  `email_verified`; keep it that way. Until it is confirmed, `/account` asks for it and can send it
  again: Firebase lets a Google sign-in for the same Gmail address replace an unconfirmed password. Keep the Firebase setting "One account per email address" on:
  it is what makes Google and a password for one email the same uid, and so the same Account.
- Every Firebase error becomes a plain sentence in `src/features/account/signInErrors.ts`, never a
  code. Wrong password and unknown email read the same, so the dialog never tells whether an
  Account exists.
- If Firebase reCAPTCHA Enterprise is ever turned on for email and password, the CSP needs
  `https://www.google.com` (and `https://www.gstatic.com`) in `script-src` and `frame-src`.
- `server/app/merge.py` is a line-for-line port of `mergeConcept` in
  `src/app/providers/progressState.ts`. Change the two together.
- Tables are created at start (`accounts`, `progress`, `deleted_accounts`); there are no migrations
  yet. `deleted_accounts` keeps a sha256 of the uid, so an old token of a deleted Account gets 410.
- Security headers: `dist/serve.json` is generated at build time by
  `scripts/vite-plugin-security-headers.ts` from `public/serve.json` plus `VITE_API_URL` and
  `VITE_FIREBASE_AUTH_DOMAIN`. Edit the template or `scripts/security-headers.ts`, never `dist/`. The
  dev server does not apply serve.json. With the `VITE_FIREBASE_*` vars missing, the build is
  Guest-only: no Sign in button, and the CSP is the plain 'self' one.
- Deploy: Railway deploys the `staging` branch to the staging environment and `master` to
  production, each after CI passes ("Wait for CI"), so CI runs on pushes to both. To deploy staging,
  merge `master` into `staging` and push. The web app and the API are two Railway services. The API service has Root Directory
  `server/` and its config file path set to `/server/railway.json` (Railway does not look for the
  config file inside the Root Directory).

### The three layers that matter

1. **Engine** (`simulations/`) — framework-agnostic simulation primitives. `useTicker` drives a
   `requestAnimationFrame` loop with a clamped `dt`; `computeLoad` turns load/capacity into CPU,
   latency and error rate.
2. **Architecture components** (`components/architecture/`) — `DiagramCanvas` renders an SVG wiring
   layer plus HTML node cards positioned on top, in a 960px design space that is scaled as one
   layer stack (`useFitScale`) to fit its container between 0.5x and 1x; below 0.5x it scrolls
   sideways inside its own card, never the page. Every lab uses it, so a Redis node looks identical
   everywhere. Author layouts in design-space pixels; anything that turns a pointer position into
   diagram coordinates must divide by the scale (nothing does today - clicks are element handlers).
3. **LabShell** (`components/learning/`) — the chrome around every lab: toolbar, stage, control
   column, metrics strip, event log. Labs supply only their diagram and their controls.

### Simulation state pattern

Labs keep mutable simulation state in a `useRef` and call `useRerender(30)` from inside the ticker,
instead of pushing every particle position into React state. Copy this pattern in new labs — it is
what keeps 60fps animation from causing 60 array copies per second.

```tsx
const state = useRef<State>(createState());
const rerender = useRerender(30);
useTicker(running, (dt) => { /* mutate state.current */ rerender(); });
```

## How to add things

### A new concept (content only)

1. Add a `Concept` object to `src/data/concepts/<category>.ts` - the file named after its
   `category`, because the concept page loads lessons per category file (`check:content` enforces it).
2. Add an animated diagram for it in `src/data/visuals/` - **this is the important half**. A concept
   page leads with its diagram; the prose is secondary and collapsed.
3. Add a `ConceptDepth` entry to `src/data/concepts/deep/<category>.ts`, keyed by slug. This is the
   Lesson under the Diagram and `check:content` fails the build without it. See below.
4. Give it a Lab and a Quiz: set `lab` to a registered `LabId` (a new Lab, or a shared one with a
   Lab focus - see below), and write `quiz` with at least 10 scenario questions. `check:content`
   fails the build on a Concept with no Lab or with fewer than 10 questions. Make the wrong options
   as specific as the right one: it also fails when, across a Category, the right option is the
   strictly longest (or shortest) option in more than 35% of the questions.
5. That is it — the sidebar, search, glossary links, category page and progress tracking all read
   from `CONCEPTS`. That export (`@/data/concepts`) is a light `ConceptSummary` index generated at
   build time by `scripts/vite-plugin-concept-index.ts`; the lesson body is fetched with
   `loadConcept(category, slug)`. Never import `concepts/all.ts`, `concepts/summaries.ts` or a
   category file from shell code - that puts every lesson back into the main bundle. A lab, being
   its own lazy chunk, may import its category file directly (see `CacheStrategiesLab`).
6. `related` slugs are resolved defensively (`resolveRelated`), so a typo degrades instead of
   crashing — but fix typos anyway.

### The long-form lesson (`src/data/concepts/deep/`)

Written for a junior who has never met the idea. Every concept has one, and the shape is fixed.
It renders under the Diagram: the analogy shows open, the rest behind "Read the full explanation".

- `analogy` — one everyday picture with a title. The thing they will still remember next week.
- `deepDive` — 2-3 sections of real prose, optionally with `bullets` and one fixed-width `code`
  block (ASCII only, aligned — it renders through `AsciiBlock`).
- `examples` — at least one worked example with **concrete numbers** in every walkthrough step, and
  a `result` line saying what the numbers proved.
- `jargon` — 4-6 terms seniors use without explaining, in plain language.
- `remember` — 3-5 one-line takeaways.

Two rules that are easy to miss: it is loaded **lazily, per category** (`loadDepth`), so never
import these modules statically — that would put ~700 KB of prose into the main bundle. And the
strings are single-quoted TypeScript, so prose avoids apostrophes ("does not", "the budget of the
caller") rather than escaping them.

### A new interactive lab

1. Create the component in `src/features/<domain>/<Name>Lab.tsx`, default-exported.
2. Build it on `LabShell` + `DiagramCanvas` + the engine primitives. Keep `running` in
   `useLabRunning()` and pass its setter as `onRunningChange`: after the Lab's `onReset` (every
   control back to its start, simulation state cleared) LabShell pauses the Lab, so Reset always
   shows the start setup and Run starts it from there.
3. Add a `LabId` to `src/types/index.ts`.
4. Add a row to `LABS` in `src/features/labs/registry.ts` (lazy import).
5. Set `lab: '<id>'` on the concept that should host it.

The lab then appears on the concept page's "Interactive lab" tab, at `/labs/<id>`, in search, and
on the labs index — no other wiring.

The Lab must render a `DiagramCanvas` - in its own file, or through a component it imports
(`FlowVisual` counts). `check:content` reads the source and fails the build on a Lab that does not.

#### A Lab focus for a shared lab

When several concepts host one lab, each opens it on the setup that teaches its own concept - its
Lab focus. `RetryBackoffLab` is the worked example (Retry opens on immediate retries, Exponential
backoff on backoff with jitter):

1. List the focus ids in `LabFocusIds` in `src/types/index.ts`: `'<lab-id>': 'focus-a' | 'focus-b'`.
2. In the lab, take `{ focus }: LabProps<'<lab-id>'>`, keep a `DEFAULT_SETUP`, and map every id to
   its setup in a `Record<LabFocus<'<lab-id>'>, Setup>` - a new id without a setup fails typecheck.
   Keep the controls in one `Setup` state that starts from
   `focus ? FOCUS_SETUPS[focus] : DEFAULT_SETUP`, and make Reset set it back to that same start,
   not to `DEFAULT_SETUP` - one object, so Reset cannot miss a control. `useLabSetup(start)`
   (`src/hooks/useLabSetup.ts`) holds it and gives `change(key)`, the onChange for one control.
3. Set `labFocus: 'focus-a'` next to `lab: '<lab-id>'` on the concept. The `Concept` type pairs the
   two, so a typo, or a focus of another lab, fails typecheck.

The concept page passes the focus and keys the lab by concept slug, so moving between two hosts of
the same lab remounts it on the new focus. `/labs/<id>` passes no focus and gets `DEFAULT_SETUP`.

### A new playground component kind

Add it to `NODE_KINDS` in `src/components/architecture/nodeKinds.tsx` (icon, accent, capacity,
blurb). It shows up in the palette, the diagrams and the analysis automatically.

## Visual-first rule

The product complaint that shaped this app was "too much text". Concept pages therefore lead with a
**running diagram**, not a paragraph:

- `src/data/visuals/` maps every concept slug to a `VisualSpec` (nodes, edges with a particle
  `rate`, and `steps` - its Walkthrough). All 102 concepts have one - keep it that way.
- `FlowVisual` renders a spec as a self-running Diagram. With `walkthrough` (the concept page only),
  a spec with `steps` also gets a chip row under the canvas: "Live" for the traffic, then one chip
  per step. Picking a step stops the traffic and walks one request along that hop, on the same
  Diagram, with a caption of **six words or fewer**. Play advances the steps and loops.
- The concept page has four tabs, in this order: Diagram, Interactive lab, Trade-offs (as chips),
  Quiz. A tab with nothing to show (no Lab or no Quiz yet) is hidden. The Diagram tab shows the Diagram with
  its Walkthrough, then the Lesson under it: the Analogy is open, and all the other prose folds
  behind one "Read the full explanation" button, which stays open while the learner stays on that
  Concept. The right column is short cards only.
- Run `npm run check:visuals` after editing a spec. It covers `src/data/visuals`, the home hero and
  the `src/features/evolution` stage layouts, and fails the build on overlapping boxes, nodes past
  the canvas, labels too long for their box, step captions over six words, nodes with no edges, a
  concept Diagram with fewer than 2 steps, a node no step visits, a step along a wire the Diagram
  does not draw (either direction counts - a response goes back), and
  **edge labels that land behind a node card** (the SVG wiring layer is painted under the HTML
  nodes, so such a label is simply invisible). Move one with `labelT`, shorten it, or drop it.
- The same check covers every Lab Diagram. The Labs build theirs in JSX, so it renders each Lab in
  Node (`scripts/lab-diagrams.mjs`): as it opens, with every Lab focus, with its sliders and
  steppers at both ends and toggles off and on, and with each SegmentedControl or Select option.
  It reads each card's real height from its markup (`scripts/node-box.mjs`) and fails on a card
  that renders taller than its placed `h`, a cut title or subtitle, overlap, a box past the canvas
  and a hidden edge label. It cannot reach what only the running simulation changes, choices made
  with plain buttons, or HTML on a Diagram that is not an `ArchNode`; it prints those limits on
  every run. `LABS=cdn,proxy npm run check:visuals` checks only those Labs.
- A node carrying a badge (`isNew` in the evolution stages) needs about 52px more width - the badge
  sits on the title row and the title is `truncate`, so "Replica 1" silently becomes "Replic...".
  With a subtitle it also makes the card 10px taller. The check knows both; trust it over
  eyeballing the box.
### Diagrams must be true, not balanced

A diagram is read as an architecture claim, so wiring it for visual balance teaches the wrong thing.
The rule the check enforces: **nodes that are replicas of each other must have identical
connections.** "API 1 talks to Redis but API 2 does not" describes instances that are not
interchangeable, which contradicts the entire stateless/horizontal-scaling lesson.

- Replicas are same-kind nodes whose labels differ only by a trailing number (`API 1`/`API 2`).
  Roles in a chain (`Service A` -> `Service B`) are not replicas and are left alone.
- When the asymmetry *is* the lesson - a failed node ejected from the pool, one partition holding
  the key, the third retry succeeding - set `asymmetric: '<reason>'` on the spec or stage. The
  reason is required, so the intent is reviewable instead of assumed.
- If the honest wiring needs too many arrows (3 instances x 4 dependencies), collapse the tier into
  one node (`API x3`), as stages 5-7 do. Collapsing is honest; drawing one arrow out of three is not.
- Anything that fronts the whole system is redundant in reality. Draw the pair where it is
  introduced and label it afterwards (`2 nodes, multi-AZ`) rather than leaving a single box that
  quietly says "this is where everything goes down".

- A part the story deliberately does not reach (a pruned partition, a cut feature) gets a step with
  `skipped: true`: its wire is shown dashed and no request travels it. Never send a `failure` dot
  there - that tells the learner traffic arrived and broke.
- Work done inside one part (a browser parsing and painting a page) is a step whose `from` equals
  its `to`: that part lights up, every wire fades and no request travels, so it needs no wire.
  Use it only for real work in one part - a hop between two parts still travels a drawn wire.
- A Walkthrough step shows its caption in a strip above the canvas - never as an edge label (on a
  short edge it lands on a node) and never floated over the canvas (it covers the top-left node).
- `FlowVisual` auto-fits its spec to the container width (0.5x-1.3x, via `DiagramCanvas`'s `fit`
  prop), so a spec authored at 760px fills a wider card instead of stopping halfway across it. Pass
  `zoom` only to pin a scale.
- `FlowVisual` has a Pause/Play control, starts paused under `prefers-reduced-motion`, and stops
  ticking while scrolled off screen (`useAutoplay`). Its nodes and edges are memoized on `spec` (and
  the active Walkthrough step), so only the particle layer re-renders per frame - keep it that way.
- `ArchNode` glides to a new placement with a CSS transition (`.arch-node` in
  `src/styles/index.css`), not an animation library: framer-motion cost every diagram page 42 KB
  gzip for this one effect. Do not add it back for a node effect.

## Content conventions

These are editorial rules, not style preferences. They are the reason the app is worth using.

- **Trade-off first.** Never write "X is better than Y". Write what X gains and what X costs. The
  `TradeOff` type forces `gains` and `costs` to both be filled in.
- **Visualization first, short explanation second, deep explanation optional** (`Expandable`).
- **Every concept must answer:** what is it, why does it exist, how does it work, when to use it,
  advantages, trade-offs, common mistakes, related concepts.
- **Scenario-based quizzes**, not definition recall.
- Prose uses plain hyphens and ASCII in `diagram` fields — the monospace blocks are rendered with
  `AsciiBlock`/`.ascii` and must line up in a fixed-width font.
- Simulations aim for **conceptual correctness + educational clarity + convincing feedback**, not
  scientific accuracy. Where a model is a simplification (e.g. `computeLoad`), say so in a comment
  and in the UI when a number could be mistaken for a measurement.

## Visual conventions

- Colors come from CSS variables in `src/styles/index.css`, exposed to Tailwind as semantic names:
  `canvas surface elevated line field ink muted faint brand ok warn danger info violet` (`field` is the
  3:1 border of a form field; `line` only separates surfaces). Never hard-code a
  hex value in a component.
- Each Category has its own color (`--cat-<id>` in `src/styles/index.css`), for wayfinding only.
  Set it with `style={categoryStyle(id)}` and use `text-cat`, `bg-cat/10`, `border-cat/30` inside;
  `CategoryTag` shows a Category as a chip or a label. Never use `ok`/`warn`/`danger` for a
  Category: those mean status (health, Difficulty, Done).
- SVG presentation attributes (and anything computed in JS) cannot read `var()`; use
  `useThemeColors()` for real color strings. Do not add a chart library for a new chart - extend
  `LiveChart`; recharts was removed because it cost every chart lab ~96 KB gzip.
- Status is never communicated by color alone — particles have distinct shapes (circle, diamond,
  triangle, cross) and every status has a text label (`HealthIndicator`, `ParticleLegend`).
- Dark mode is the default when the OS does not ask for light (first paint follows `prefers-color-scheme`), and it is the theme diagrams are tuned for; both themes must stay readable.
- **Text is never smaller than 11px** - labels, captions, monospace numbers, node subtitles and stat
  rows, SVG `<text>` and edge labels alike. `text-[11px]` is the floor; there is no `text-[9px]` or
  `text-[10px]` in the app, and an SVG `fontSize` is at least 11. (A diagram scaled below 1x by
  `useFitScale` shrinks its text with it - that is the one exception, and why a diagram scrolls
  inside its card instead of shrinking past its floor.)
- **Touch targets are at least 44x44px on a coarse pointer** (a touch screen); with a mouse the
  compact desktop sizes stay. One base rule in `src/styles/index.css` gives `button`, `a[href]`,
  `select`, `summary`, every `input` except range/checkbox/radio/hidden, and `role`
  tab/button/switch/option/menuitem a 44px min-height and min-width under `@media (pointer:
  coarse)`, so a raw `<button>` on a new page is covered with no extra class. It uses `:where()`
  (zero specificity), so a `min-h-*`/`min-w-*` utility on the element wins; a fixed `h-8` does not
  make it smaller, because a min size beats a height. For something else that is clickable (a `div`
  with `onClick`, a focusable `span`), give it a real role or `coarse:min-h-11`. A control that must
  stay visually small grows an invisible hit area instead: `Toggle` opts out with `coarse:min-h-0`
  and uses a `::before`; `InfoTip` (a `span`) and `Slider` (a range input) are not matched by the
  rule and use an `::after` and padding with `bg-clip-content`. Use `coarse:` for touch-only
  classes, not `[@media(pointer:coarse)]:`, and `short:` (under 640px tall, a phone held sideways)
  for anything pinned that would crowd the rest. Both Tailwind variants are defined in
  `tailwind.config.js`. Controls inside a `DiagramCanvas` (`data-diagram`) are exempt: the diagram
  is fixed geometry, and a taller button in a node would push it over its neighbour.

## Gotchas

- Do **not** `import * as Icons from 'lucide-react'` — it pulls every icon into the main bundle.
  Use named imports, or `CategoryIcon` in `src/data/categoryIcons.tsx` for name-based lookup.
- Tailwind's default scale has no `4.5` step; `h-4.5` silently does nothing.
- `noUnusedLocals` is on: an unused import fails the build, not just a lint run.
- Every route and lab is code-split. Import them with `lazyWithRetry` (`src/utils/lazyWithRetry.ts`),
  not bare `React.lazy`: after a dev-server restart or a redeploy the old document points at chunks
  that no longer exist, and a bare `lazy` turns that into "Failed to fetch dynamically imported
  module". Heavy deps reached only from lazy chunks are listed in `optimizeDeps.include` so Vite
  never re-optimizes and force-reloads mid-session.
- Labs that size node boxes at runtime (load balancer, horizontal scaling, auto scaling, queue) must
  keep the widest label readable: minimum width is 54 + the title width (the per-letter table in `scripts/node-box.mjs`, about 7px a letter), and the whole row must
  stay inside the 960px canvas. The check renders them at their smallest and largest settings.
- The Bash tool on this machine has had trouble with large heredocs containing `.tsx`; prefer the
  Write tool for source files.
- `ArchNode` grows to fit its content and truncates its title, so an undersized box silently
  clips its label or overlaps the node below. `npm run check:visuals` catches both; it runs as part
  of `npm run build`. A compact card is 68.5px with a title (78.5 not compact), 73 with a subtitle
  and 83 with a subtitle and a badge; each `NodeStatRow` adds 16.5 plus a 6px gap (the first one
  adds the card gap, 4 or 6), so a compact card with a subtitle and 2 stat rows is 116 (`CARD` in
  `scripts/node-box.mjs`, measured in Chromium - not chrome-headless-shell, whose stat rows are 1px
  taller). Minimum width is 54 + the per-letter title width table in `scripts/node-box.mjs` (about
  7px a letter), or the subtitle table (about 6px) if wider; 62 + for a card that is not compact.
- Everything persists to `localStorage` (`sdi:theme`, `sdi:progress:v2`, `sdi:layout` for which
  side panels the learner folded, `sdi:account`, the "was signed in here" mark, and
  `sdi:progress:outbox`, the Concepts the server has not confirmed yet). The app must work fully as a Guest, with no network calls.
  The only backend is the optional Account (`server/`, FastAPI + Postgres, sign-in by Firebase
  Auth), and it only saves progress - see `docs/adr/0001-backend-with-rented-auth.md`. Never make a
  page wait for the server, and never load the Firebase SDK for a Guest.

## Agent skills

### Issue tracker

GitHub Issues on `clisu-constantin/system-design-learning-platform`, via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five default labels, unchanged. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
