/**
 * Renders every Lab in Node and records the Diagram it draws, so check-visuals can
 * check Lab layouts the way it checks VisualSpecs.
 *
 * A Lab builds its layout and its node cards in JSX, often from its controls, so
 * reading the source is not enough. Instead each Lab is bundled with esbuild and
 * rendered with react-dom/server, with four small hooks added to the bundle:
 *
 * - DiagramCanvas records its width, height, layout and edges.
 * - ArchNode records its placement and wraps its markup in <sdi-node>, so the
 *   check can read what the card holds (subtitle, stat rows, meters, badge).
 * - Slider, Stepper, Toggle, SegmentedControl and Select record their props, so
 *   the check can call their onChange like a learner would.
 * - useState and useRef (as imported by src/ code) hand back, by call order, the
 *   values an onChange set and the refs it changed, so they are there on the next
 *   render. A server render keeps no state between renders; this is what lets it
 *   render a Lab at a new setting (a Lab often rebuilds its simulation, kept in a
 *   ref, when a control changes).
 *
 * Each Lab is rendered with no focus and with every Lab focus, and from each of
 * those starts: as it opens, with every slider and stepper at its minimum and
 * every toggle off, with every slider at its maximum and every toggle on, and
 * once per option of every choice control (at start, minimum and maximum).
 *
 * It sees only the first frame of each setting: state the simulation changes
 * while it runs (a server that auto-scaling adds, a node a failure takes down)
 * and choices made with plain buttons are not reached. Those are listed in the
 * report as limits, not skipped silently.
 */
import { build } from 'esbuild';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const SRC = join(ROOT, 'src');

/** Lab ids and their modules, read from the registry rows (`id: '...'` ... `import('@/features/...')`). */
export function readLabs() {
  const registry = readFileSync('src/features/labs/registry.ts', 'utf8');
  const labs = [...registry.matchAll(/id: '([^']+)'[\s\S]*?import\('@\/(features\/[^']+)'\)/g)].map((match) => ({
    id: match[1],
    file: `src/${match[2]}.tsx`,
  }));
  // One row per `lazyWithRetry(`: a row this pattern misses would go unchecked.
  const rows = registry.split('lazyWithRetry(').length - 1;
  if (labs.length !== rows) throw new Error(`lab-diagrams: read ${labs.length} Labs from registry.ts, which has ${rows} rows`);
  return labs;
}

/** Lab focus ids per Lab id, read from the `LabFocusIds` interface. */
export function readFocusIds() {
  const types = readFileSync('src/types/index.ts', 'utf8');
  const body = types.match(/export interface LabFocusIds \{([\s\S]*?)\n\}/)?.[1] ?? '';
  const result = {};
  for (const line of body.split('\n')) {
    const match = line.match(/^\s*'([^']+)':\s*(.+);/);
    if (match) result[match[1]] = [...match[2].matchAll(/'([^']+)'/g)].map((id) => id[1]);
  }
  return result;
}

// Renames `export function Name(` to `function NameBase(` and appends a wrapper
// that calls the recorder first. Used on the real component source, so the
// markup the check reads is the markup the app renders.
const wrap = (source, name, body) =>
  `import { createElement as __sdiCreate } from 'react';\n` +
  source.replace(new RegExp(`export function ${name}([<(])`), `function ${name}Base$1`) +
  `\nexport function ${name}(props: any) {\n${body}\n}\n`;

const recorderHooks = {
  'components/architecture/ArchNode.tsx': (source) =>
    wrap(
      source,
      'ArchNode',
      `  const index = (globalThis as any).__sdiRecorder?.node(props) ?? -1;
  const base = __sdiCreate(ArchNodeBase, props);
  return index >= 0 ? __sdiCreate('sdi-node', { 'data-i': index }, base) : base;`,
    ),
  'components/architecture/DiagramCanvas.tsx': (source) =>
    wrap(
      source,
      'DiagramCanvas',
      `  (globalThis as any).__sdiRecorder?.canvas(props);
  return __sdiCreate(DiagramCanvasBase, props);`,
    ),
  ...Object.fromEntries(
    ['Slider', 'Stepper', 'Toggle', 'SegmentedControl', 'Select'].map((name) => [
      `components/ui/${name}.tsx`,
      (source) =>
        wrap(
          source,
          name,
          `  (globalThis as any).__sdiRecorder?.control('${name}', props);
  return __sdiCreate(${name}Base, props);`,
        ),
    ]),
  ),
};

const REACT_SHIM = `
import * as React from 'react';
export * from 'react';
export default React;
export function useState(initial) {
  const hook = globalThis.__sdiRecorder?.useState;
  return hook ? hook(React.useState, initial) : React.useState(initial);
}
export function useRef(initial) {
  const hook = globalThis.__sdiRecorder?.useRef;
  return hook ? hook(React.useRef, initial) : React.useRef(initial);
}
`;

const labPlugin = {
  name: 'sdi-lab-recorder',
  setup(builder) {
    // The concept index is generated by a Vite plugin; Labs do not need its rows.
    builder.onResolve({ filter: /^virtual:/ }, (args) => ({ path: args.path, namespace: 'sdi-virtual' }));
    builder.onLoad({ filter: /.*/, namespace: 'sdi-virtual' }, () => ({ contents: 'export default []', loader: 'js' }));

    // Only app code gets the useState and useRef hooks; React and react-dom keep the real ones.
    builder.onResolve({ filter: /^react$/ }, (args) =>
      args.importer.startsWith(SRC) ? { path: 'react-shim', namespace: 'sdi-react' } : undefined,
    );
    builder.onLoad({ filter: /.*/, namespace: 'sdi-react' }, () => ({ contents: REACT_SHIM, loader: 'js', resolveDir: ROOT }));

    builder.onLoad({ filter: /\.tsx$/ }, (args) => {
      const key = Object.keys(recorderHooks).find((suffix) => args.path === join(SRC, suffix));
      if (!key) return undefined;
      return { contents: recorderHooks[key](readFileSync(args.path, 'utf8')), loader: 'tsx' };
    });
  },
};

/** Bundles every Lab with the recorder hooks into `dir` and imports the result. */
export async function bundleLabs(labs, dir) {
  const entry = join(dir, 'labs-entry.tsx');
  writeFileSync(
    entry,
    [
      ...labs.map((lab, index) => `import Lab${index} from ${JSON.stringify(resolve(lab.file))};`),
      `export const LAB_COMPONENTS = [${labs.map((_, index) => `Lab${index}`).join(', ')}];`,
      `export { ThemeProvider } from ${JSON.stringify(join(SRC, 'app/providers/ThemeProvider.tsx'))};`,
      `export { renderToStaticMarkup } from 'react-dom/server';`,
      `export { MemoryRouter } from 'react-router-dom';`,
      `export { createElement } from 'react';`,
    ].join('\n'),
  );
  const outfile = join(dir, 'labs.mjs');
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile,
    jsx: 'automatic',
    tsconfig: join(ROOT, 'tsconfig.app.json'),
    nodePaths: [join(ROOT, 'node_modules')],
    loader: { '.svg': 'text', '.css': 'empty' },
    define: { 'import.meta.env': '{"DEV":false,"PROD":true}', 'process.env.NODE_ENV': '"production"' },
    // react-dom/server is CommonJS and requires Node built-ins.
    banner: { js: "import { createRequire as __sdiRequire } from 'node:module'; const require = __sdiRequire(import.meta.url);" },
    plugins: [labPlugin],
    logLevel: 'error',
  });
  return import(pathToFileURL(outfile).href);
}

/** The value a range input settles on for `target`: clamped, then snapped to `step` from `min`. */
const onStep = (props, target) => {
  const step = props.step ?? 1;
  const min = props.min ?? 1;
  const max = props.max ?? 10;
  return Math.min(max, min + Math.round((Math.min(max, Math.max(min, target)) - min) / step) * step);
};

function createRecorder(overrides, carried) {
  const recorder = {
    canvases: [],
    controls: [],
    values: [],
    refs: [],
    // How many refs the Lab component made before its first Diagram rendered: those
    // are its own (simulation state, tickers); later ones belong to child components,
    // whose order can change between two renders.
    ownRefs: null,
    calls: null,
    hook: 0,
    refHook: 0,
    canvas(props) {
      recorder.ownRefs ??= recorder.refHook;
      recorder.canvases.push({
        width: props.width ?? 960,
        height: props.height ?? 520,
        layout: props.layout ?? {},
        edges: props.edges ?? [],
        nodes: [],
      });
    },
    node(props) {
      const canvas = recorder.canvases.at(-1);
      if (!props.placed || !canvas) return -1;
      const id =
        Object.keys(canvas.layout).find((key) => canvas.layout[key] === props.placed) ??
        Object.keys(canvas.layout).find((key) => {
          const box = canvas.layout[key];
          return box.x === props.placed.x && box.y === props.placed.y && box.w === props.placed.w && box.h === props.placed.h;
        });
      canvas.nodes.push({ id, kind: props.kind, placed: { ...props.placed }, compact: Boolean(props.compact) });
      return (recorder.canvases.length - 1) * 1000 + canvas.nodes.length - 1;
    },
    control(kind, props) {
      if (!props.disabled) recorder.controls.push({ kind, props });
    },
    useState(useState, initial) {
      const index = recorder.hook;
      recorder.hook += 1;
      const [value, set] = useState(overrides.has(index) ? overrides.get(index) : initial);
      recorder.values[index] = value;
      const setter = (next) => {
        if (recorder.calls) recorder.calls.push({ index, next });
        else set(next);
      };
      return [value, setter];
    },
    useRef(useRef, initial) {
      const index = recorder.refHook;
      recorder.refHook += 1;
      const ref = useRef(initial);
      const own = carried && index < (carried.ownRefs ?? 0);
      recorder.refs[index] = own ? carried.refs[index] : ref;
      return recorder.refs[index];
    },
  };
  return recorder;
}

/**
 * Renders one Lab with the given state overrides, and the Lab's own refs from the
 * `carried` render before it. Returns the recorder
 * (Diagrams, controls, state) and the markup, or the error it threw.
 */
function renderLab(mod, Lab, focus, overrides, carried) {
  const recorder = createRecorder(overrides, carried);
  globalThis.__sdiRecorder = recorder;
  // Some Labs start from random numbers; the same seed on every render keeps the
  // check's result the same from one run to the next.
  const random = Math.random;
  let seed = 1;
  Math.random = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
  try {
    const html = mod.renderToStaticMarkup(
      // A Lab may link to a Concept, and a link needs a router.
      mod.createElement(
        mod.MemoryRouter,
        null,
        mod.createElement(mod.ThemeProvider, null, mod.createElement(Lab, focus ? { focus } : {})),
      ),
    );
    return { recorder, html };
  } catch (error) {
    return { recorder, error };
  } finally {
    globalThis.__sdiRecorder = undefined;
    Math.random = random;
  }
}

/**
 * Calls `onChange(value)` the way the control would, and folds the state updates it
 * makes into a new overrides map. Updater functions get the current value, so two
 * controls writing into one Setup object (useLabSetup) compose.
 */
function drive(recorder, overrides, control, value) {
  const next = new Map(overrides);
  recorder.calls = [];
  try {
    control.props.onChange(value);
  } catch {
    // A handler that touches the DOM or a timer; whatever it set before that still counts.
  }
  for (const { index, next: update } of recorder.calls) {
    const current = next.has(index) ? next.get(index) : recorder.values[index];
    next.set(index, typeof update === 'function' ? update(current) : update);
  }
  recorder.calls = null;
  return next;
}

const isChoice = (control) => control.kind === 'SegmentedControl' || control.kind === 'Select';
const isRange = (control) => control.kind === 'Slider' || control.kind === 'Stepper';

const isDriven = (control) => isRange(control) || control.kind === 'Toggle';

/**
 * Steps that move each range control to its end and turn each toggle on (`max`) or
 * off (`min`), one control per step: a handler often rebuilds the simulation from
 * the setup it closed over, so each change needs the render before it, as in the app.
 * `count` is how many controls to try; a step past the last control does nothing.
 */
const toEnd = (end, count) =>
  Array.from({ length: count }, (_, index) => (recorder, overrides) => {
    const control = recorder.controls.filter(isDriven)[index];
    if (!control) return null;
    const value = isRange(control) ? onStep(control.props, end === 'max' ? Infinity : -Infinity) : end === 'max';
    return drive(recorder, overrides, control, value);
  });

/** Picks option `value` on the `index`-th choice control. */
const choose = (index, value) => (recorder, overrides) => {
  const control = recorder.controls.filter(isChoice)[index];
  return control ? drive(recorder, overrides, control, value) : overrides;
};

/**
 * Every setting of one Lab the check looks at, rendered. Each one starts from a
 * fresh render of the Lab (with no focus or one Lab focus) and applies its steps
 * in order, one render per step, like a learner moving the controls. Settings that
 * draw the same thing are kept once, with every name that reached them.
 */
export function renderLabSettings(mod, Lab, focusIds) {
  const settings = [];
  const errors = [];
  const seen = new Map();
  let usesButtons = false;

  const run = (name, focus, steps) => {
    let result = renderLab(mod, Lab, focus, new Map(), null);
    let overrides = new Map();
    for (const step of steps) {
      if (result.error) break;
      const next = step(result.recorder, overrides);
      if (!next) continue;
      overrides = next;
      result = renderLab(mod, Lab, focus, overrides, result.recorder);
    }
    if (result.error) {
      errors.push(`${name}: ${String(result.error).split('\n')[0]}`);
      return null;
    }
    if (/aria-pressed=/.test(result.html)) usesButtons = true;
    const known = seen.get(result.html);
    if (known) known.names.push(name);
    else {
      const setting = { names: [name], canvases: result.recorder.canvases, html: result.html };
      seen.set(result.html, setting);
      settings.push(setting);
    }
    return result.recorder;
  };

  for (const focus of [undefined, ...focusIds]) {
    const start = focus ? `focus ${focus}` : 'no focus';
    const opened = run(`${start}, as it opens`, focus, []);
    if (!opened) continue;
    // A choice can show more controls than the Lab opens with.
    const count = opened.controls.filter(isDriven).length + 3;
    run(`${start}, controls at min`, focus, toEnd('min', count));
    run(`${start}, controls at max`, focus, toEnd('max', count));

    opened.controls.filter(isChoice).forEach((control, index) => {
      for (const option of control.props.options ?? []) {
        if (option.value === control.props.value) continue;
        const label = `${start}, ${control.kind} "${option.label}"`;
        run(label, focus, [choose(index, option.value)]);
        run(`${label}, controls at min`, focus, [choose(index, option.value), ...toEnd('min', count)]);
        run(`${label}, controls at max`, focus, [choose(index, option.value), ...toEnd('max', count)]);
      }
    });
  }

  return { settings, errors, usesButtons };
}
