/**
 * Geometry and wiring check for every diagram in the app.
 *
 * Specs in src/data/visuals and the stage layouts in src/features/evolution are
 * plain data, and ArchNode grows to fit its content, so a box that is too small
 * silently truncates its label or overlaps the node below. This asserts that
 * cannot happen, and that the wiring says something true: identical replicas
 * must have identical connections unless the diagram declares otherwise.
 *
 * The Labs build their Diagrams in JSX, often from their controls, so they are
 * rendered instead (lab-diagrams.mjs): as they open, with every Lab focus, and
 * with their controls at both ends. Each card's real height comes from its markup
 * (node-box.mjs), and the same geometry checks run on what was drawn. What the
 * Lab check cannot reach is printed after the result, never skipped silently.
 * Run with `npm run check:visuals`; `LABS=cdn,proxy npm run check:visuals` checks
 * only those Labs.
 */
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundleLabs, readFocusIds, readLabs, renderLabSettings } from './lab-diagrams.mjs';
import { cardBox, cardHeight, cardText, findAll, minCardWidth, parseMarkup } from './node-box.mjs';

// Title widths, card chrome and card heights live in node-box.mjs, shared with
// the Lab check below; they were measured in headless Chromium.
const minWidth = (node) => minCardWidth({ label: node.label, sub: node.sub, badge: node.badge ? 'new' : undefined });
// Concept Diagrams and evolution stages draw compact cards with at most one stat row;
// evolution marks a new part with a "new" badge on the title row.
const minHeight = (node) => Math.ceil(cardHeight({ sub: Boolean(node.sub), badge: Boolean(node.badge), statRows: node.stat ? 1 : 0 }));

const overlaps = (a, b) =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

/**
 * Two nodes are peers when they are the same kind of component and their labels
 * differ only by a trailing number: "API 1"/"API 2", "api-1"/"api-2".
 * Letters are deliberately NOT stripped, so "Service A" and "Service B" stay
 * distinct - those name roles in a chain, not replicas of each other.
 */
const peerKey = (node) => {
  const base = node.label
    .trim()
    .replace(/[\s#_-]*\d+$/, '')
    .toLowerCase();
  return `${node.kind}|${base}`;
};

const dir = mkdtempSync(join(tmpdir(), 'sdi-visuals-'));

try {
  await build({
    entryPoints: {
      visuals: 'src/data/visuals/index.ts',
      stages: 'src/features/evolution/stages.ts',
      geometry: 'src/components/architecture/geometry.ts',
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    outdir: dir,
    outExtension: { '.js': '.mjs' },
    logLevel: 'error',
  });

  const { VISUALS, HERO_VISUAL } = await import(pathToFileURL(join(dir, 'visuals.mjs')).href);
  const { STAGES } = await import(pathToFileURL(join(dir, 'stages.mjs')).href);
  const { curveBetween, pointOnCurve, midpoint, edgeLabelBox } = await import(
    pathToFileURL(join(dir, 'geometry.mjs')).href
  );

  // The evolution stages use a different shape (title + placed box) and a taller
  // canvas, so normalise both sources into one list before checking.
  const specs = [
    // Concept Diagrams show a Walkthrough; the home hero does not.
    ...[
      ...Object.entries(VISUALS).map(([slug, spec]) => [slug, spec, true]),
      ['home hero', HERO_VISUAL, false],
    ].map(([slug, spec, walkthrough]) => ({
      name: slug,
      width: spec.width ?? 760,
      height: spec.height ?? 320,
      nodes: spec.nodes,
      edges: spec.edges,
      steps: spec.steps ?? [],
      asymmetric: spec.asymmetric,
      walkthrough,
    })),
    ...STAGES.map((stage) => ({
      name: `evolution ${stage.id}`,
      width: 960,
      height: 540,
      nodes: stage.nodes.map((node) => ({
        id: node.id,
        kind: node.kind,
        label: node.title,
        sub: node.subtitle,
        badge: node.isNew,
        ...node.placed,
      })),
      edges: stage.edges,
      steps: [],
      asymmetric: stage.asymmetric,
    })),
  ];

  // Edge labels are drawn on the wiring layer, underneath the node cards, so
  // a label that lands on a box is simply invisible. `layout` places the wires,
  // `boxes` are the cards as drawn. With no `name`, messages carry no prefix.
  const edgeLabelProblems = (name, edges, layout, boxes, width) => {
    const found = [];
    for (const edge of edges) {
      if (!edge.label) continue;
      const from = layout[edge.from];
      const to = layout[edge.to];
      if (!from || !to) continue;

      const curve = curveBetween(from, to, edge.curvature);
      const point = edge.labelT === undefined ? midpoint(curve) : pointOnCurve(curve, edge.labelT);
      // The same chip DiagramCanvas draws, so the check and the page agree.
      const labelBox = { id: `label "${edge.label}"`, ...edgeLabelBox(point, edge.label) };
      const prefix = name ? `${name}: ` : '';

      const hiddenBy = boxes.find((box) => overlaps(labelBox, box));
      if (hiddenBy) {
        found.push(
          `${prefix}label "${edge.label}" on ${edge.from} -> ${edge.to} is hidden behind ${hiddenBy.id}` +
            ' (move it with labelT, shorten it, or drop it)',
        );
      }
      if (labelBox.x < 0 || labelBox.x + labelBox.w > width || labelBox.y < 0) {
        found.push(`${prefix}label "${edge.label}" on ${edge.from} -> ${edge.to} falls outside the canvas`);
      }
    }
    return found;
  };

  const problems = [];

  for (const spec of specs) {
    const { name, width, height } = spec;
    const ids = new Set(spec.nodes.map((node) => node.id));
    const boxes = spec.nodes.map((node) => ({
      id: node.id,
      x: node.x,
      y: node.y,
      w: node.w ?? 150,
      h: node.h ?? 74,
    }));

    for (const edge of spec.edges) {
      if (!ids.has(edge.from) || !ids.has(edge.to)) {
        problems.push(`${name}: edge ${edge.from} -> ${edge.to} references a node that does not exist`);
      }
    }

    for (const step of spec.steps) {
      if (!ids.has(step.from) || !ids.has(step.to)) {
        problems.push(`${name}: step ${step.from} -> ${step.to} references a node that does not exist`);
      }
      if (step.label.split(' ').length > 6) {
        problems.push(`${name}: step caption longer than six words - "${step.label}"`);
      }
      // The Walkthrough is read as the story of the drawn system, so a step may
      // only travel a wire the Diagram draws (either way: a response goes back).
      // A step from a part to itself is work inside that part and travels no wire.
      const drawn = step.from === step.to || spec.edges.some(
        (edge) => (edge.from === step.from && edge.to === step.to) || (edge.from === step.to && edge.to === step.from),
      );
      if (!drawn) problems.push(`${name}: step ${step.from} -> ${step.to} follows no drawn edge`);
    }

    // Every concept Diagram carries a Walkthrough, and the Walkthrough visits every
    // node: a box the story never reaches is a part the learner is never told about.
    // A part that is deliberately not reached gets a `skipped` step, not a request.
    if (spec.walkthrough && spec.steps.length < 2) {
      problems.push(`${name}: needs a Walkthrough of at least 2 steps`);
    } else if (spec.walkthrough) {
      const visited = new Set(spec.steps.flatMap((step) => [step.from, step.to]));
      for (const node of spec.nodes) {
        if (!visited.has(node.id)) problems.push(`${name}: ${node.id} ("${node.label}") is never visited by a step`);
      }
    }

    // A node nobody connects to is either a forgotten edge or a forgotten node.
    const wired = new Set(spec.edges.flatMap((edge) => [edge.from, edge.to]));
    for (const node of spec.nodes) {
      if (!wired.has(node.id)) problems.push(`${name}: ${node.id} has no edges - it is drawn but not wired`);
    }

    for (const node of spec.nodes) {
      const w = node.w ?? 150;
      const h = node.h ?? 74;
      if (w < minWidth(node)) {
        problems.push(`${name}: ${node.id} is ${w}px wide, needs ${minWidth(node)}px for "${node.label}"`);
      }
      if (h < minHeight(node)) {
        problems.push(`${name}: ${node.id} is ${h}px tall, needs ${minHeight(node)}px for its content`);
      }
      if (node.x < 0 || node.y < 0) problems.push(`${name}: ${node.id} has a negative position`);
      if (node.x + w > width) problems.push(`${name}: ${node.id} runs ${node.x + w - width}px past the canvas width`);
      if (node.y + h > height) problems.push(`${name}: ${node.id} runs ${node.y + h - height}px past the canvas height`);
    }

    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        if (overlaps(boxes[i], boxes[j])) {
          problems.push(`${name}: ${boxes[i].id} overlaps ${boxes[j].id}`);
        }
      }
    }

    // Identical replicas must have identical wiring. "API 1 talks to Redis but
    // API 2 does not" is drawn for visual balance and read as architecture - it
    // teaches a system where instances are not interchangeable, which is the
    // opposite of the lesson. A diagram that is asymmetric on purpose (a failed
    // node, one partition holding the key) says so with `asymmetric`.
    if (!spec.asymmetric) {
      const groups = new Map();
      for (const node of spec.nodes) {
        const key = peerKey(node);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(node);
      }

      for (const [key, members] of groups) {
        if (members.length < 2) continue;
        const memberIds = new Set(members.map((member) => member.id));
        const neighbours = new Map(members.map((member) => [member.id, new Set()]));

        for (const edge of spec.edges) {
          // Edges between the peers themselves describe their relationship to
          // each other (leader to follower), not a shared dependency.
          if (memberIds.has(edge.from) && !memberIds.has(edge.to)) neighbours.get(edge.from).add(`-> ${edge.to}`);
          if (memberIds.has(edge.to) && !memberIds.has(edge.from)) neighbours.get(edge.to).add(`<- ${edge.from}`);
        }

        const everyNeighbour = new Set([...neighbours.values()].flatMap((set) => [...set]));
        for (const neighbour of everyNeighbour) {
          const missing = members.filter((member) => !neighbours.get(member.id).has(neighbour));
          if (missing.length) {
            problems.push(
              `${name}: ${key.split('|')[1] || key} replicas are wired differently - ` +
                `${neighbour} is missing on ${missing.map((member) => member.id).join(', ')} ` +
                '(wire every replica the same, or set `asymmetric` with the reason)',
            );
          }
        }
      }
    }

    const byId = Object.fromEntries(boxes.map((box) => [box.id, box]));
    problems.push(...edgeLabelProblems(name, spec.edges, byId, boxes, width));
  }

  // Lab Diagrams. Each distinct Diagram a Lab draws in any checked setting is
  // checked like a spec, with each card at the height the browser will give it.
  // A problem found in several settings is reported once, with the first setting.
  // LABS=load-balancer,cdn checks only those Labs (the rest of the diagrams still run).
  const only = process.env.LABS?.split(',');
  const labs = readLabs().filter((lab) => !only || only.includes(lab.id));
  const focusIds = readFocusIds();
  const labModule = await bundleLabs(labs, dir);
  const labProblems = new Map();
  const limits = { errors: [], buttons: [], unread: new Map() };
  let labDiagrams = 0;
  let labSettings = 0;

  labs.forEach((lab, index) => {
    const { settings, errors, usesButtons } = renderLabSettings(labModule, labModule.LAB_COMPONENTS[index], focusIds[lab.id] ?? []);
    limits.errors.push(...errors.map((error) => `${lab.id}: ${error}`));
    if (usesButtons) limits.buttons.push(lab.id);
    if (!settings.length) limits.errors.push(`${lab.id}: no setting rendered`);
    labSettings += settings.reduce((sum, setting) => sum + setting.names.length, 0);

    const seen = new Set();
    for (const setting of settings) {
      const cards = findAll(parseMarkup(setting.html), (element) => element.tag === 'sdi-node');
      const cardAt = new Map(cards.map((wrapper) => [Number(wrapper.attrs['data-i']), wrapper.children.find((child) => child.tag !== '#text')]));

      setting.canvases.forEach((canvas, canvasIndex) => {
        const nodes = canvas.nodes.map((node, nodeIndex) => {
          const card = cardAt.get(canvasIndex * 1000 + nodeIndex);
          const text = cardText(card);
          const { contentHeight, problems: unread } = cardBox(card);
          for (const reason of unread) limits.unread.set(`${lab.id}: "${text.label}" (${reason})`, true);
          return { ...node, ...text, id: node.id ?? `"${text.label}"`, rendered: Math.ceil(contentHeight) };
        });
        const key = JSON.stringify([canvas.width, canvas.height, canvas.layout, canvas.edges, nodes]);
        if (seen.has(key)) return;
        seen.add(key);
        labDiagrams += 1;

        const found = [];
        const { width, height } = canvas;
        const boxes = nodes.map((node) => ({ id: node.id, ...node.placed, h: Math.max(node.placed.h, node.rendered) }));
        for (const node of nodes) {
          const { x, y, w, h } = node.placed;
          if (node.rendered > h) found.push(`${node.id} renders ${node.rendered}px tall, placed ${h}px`);
          if (w < minCardWidth(node)) found.push(`${node.id} is ${w}px wide, needs ${minCardWidth(node)}px for "${node.label}"${node.sub ? ` / "${node.sub}"` : ''}`);
          const bottom = y + Math.max(h, node.rendered);
          if (x < 0 || y < 0) found.push(`${node.id} has a negative position`);
          if (x + w > width) found.push(`${node.id} runs ${x + w - width}px past the canvas width`);
          if (bottom > height) found.push(`${node.id} runs ${bottom - height}px past the canvas height (${height}px)`);
        }
        for (let i = 0; i < boxes.length; i += 1) {
          for (let j = i + 1; j < boxes.length; j += 1) {
            if (overlaps(boxes[i], boxes[j])) found.push(`${boxes[i].id} overlaps ${boxes[j].id}`);
          }
        }
        // Wires run between placed boxes (DiagramCanvas curves from the layout), labels
        // hide behind the cards as rendered.
        found.push(...edgeLabelProblems(null, canvas.edges, canvas.layout, boxes, width));

        const where = setting.names[0] + (canvasIndex ? `, diagram ${canvasIndex + 1}` : '');
        for (const problem of found) {
          const message = `lab ${lab.id}: ${problem}`;
          if (!labProblems.has(message)) labProblems.set(message, new Set());
          labProblems.get(message).add(where);
        }
      });
    }
  });

  for (const [message, where] of labProblems) {
    const [first] = where;
    problems.push(`${message} (${first}${where.size > 1 ? ` and ${where.size - 1} more setting(s)` : ''})`);
  }

  // What the Lab check cannot see, said every run so it is never mistaken for a pass.
  const notes = [
    'Lab check limits:',
    '- Each setting is the first frame after the controls move: parts the simulation adds, removes or',
    '  relabels while it runs (auto-scaled servers, a failed node) are not reached.',
    '- Only ArchNode cards are measured; other HTML placed on a Diagram (zones, panels) is not.',
  ];
  if (limits.buttons.length) {
    notes.push(`- Choices made with plain buttons are not clicked, only Slider, Stepper, Toggle, SegmentedControl and Select: ${limits.buttons.join(', ')}.`);
  }
  if (limits.errors.length) notes.push('- Settings that failed to render, not checked:', ...limits.errors.map((line) => `  ${line}`));
  if (limits.unread.size) {
    notes.push('- Cards whose content node-box.mjs cannot read, height not checked:', ...[...limits.unread.keys()].map((line) => `  ${line}`));
  }

  const summary =
    `${specs.length + labDiagrams} diagrams checked (${specs.length} concept, hero and evolution; ` +
    `${labDiagrams} from ${labSettings} settings of ${labs.length} Labs)`;

  if (problems.length) {
    console.error(problems.join('\n'));
    console.error(`\n${notes.join('\n')}`);
    console.error(`\n${problems.length} problem(s) - ${summary}`);
    process.exit(1);
  }

  console.log(notes.join('\n'));
  console.log(`\n${summary} - geometry and wiring consistent`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
