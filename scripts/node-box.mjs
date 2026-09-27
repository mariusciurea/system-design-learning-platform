/**
 * How tall an ArchNode card renders, worked out from its markup without a browser.
 *
 * ArchNode grows to fit what it holds, so a Lab that places a card 90px tall and
 * puts two stat rows and a subtitle in it gets a 116px card that runs over the
 * one below. check-visuals renders each Lab to markup (lab-diagrams.mjs) and uses
 * this to get the height the browser will give each card.
 *
 * It is a small block and flex layout model for the Tailwind classes that node
 * cards use. It was checked against Chromium (the full browser, 1400x900, the
 * built stylesheet, the dark theme) on every card of every Lab setting
 * check-visuals renders: 9002 cards, all to within a quarter pixel. A class it does
 * not know that could change a height makes it give up on that card and say so,
 * rather than guess: add the class here and re-measure.
 *
 * Measure with the full Chromium (Playwright's `chromium` with headless: false, or
 * Chrome), not chrome-headless-shell: the shell sets the monospace value of a stat
 * row 1px lower on the sans label's baseline, so its rows are 17.5px, not 16.5.
 */

// ---------------------------------------------------------------------------
// Markup

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

const decode = (text) =>
  text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');

/** Parses react-dom/server markup (well formed, attributes always quoted) into a tree. */
export function parseMarkup(html) {
  const root = { tag: '#root', attrs: {}, children: [] };
  const stack = [root];
  const pattern = /<!--[\s\S]*?-->|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[^\s=>/]+(?:="[^"]*")?)*)\s*(\/?)>|([^<]+)/g;
  let match;
  while ((match = pattern.exec(html))) {
    const [, close, open, attrText, selfClose, text] = match;
    const parent = stack.at(-1);
    if (text !== undefined) {
      parent.children.push({ tag: '#text', text: decode(text) });
    } else if (open) {
      const attrs = {};
      for (const attr of attrText.matchAll(/([^\s=]+)(?:="([^"]*)")?/g)) attrs[attr[1]] = decode(attr[2] ?? '');
      const element = { tag: open.toLowerCase(), attrs, children: [] };
      parent.children.push(element);
      if (!selfClose && !VOID.has(element.tag)) stack.push(element);
    } else if (close) {
      while (stack.length > 1 && stack.pop().tag !== close.toLowerCase());
    }
  }
  return root;
}

export const textOf = (node) =>
  node.tag === '#text' ? node.text : node.children.map(textOf).join('');

const classesOf = (node) => (node.attrs?.class ?? '').split(/\s+/).filter(Boolean);

/** Every element under `node` (depth first) for which `test` holds. */
export function findAll(node, test, found = []) {
  for (const child of node.children ?? []) {
    if (child.tag === '#text') continue;
    if (test(child)) found.push(child);
    findAll(child, test, found);
  }
  return found;
}

// ---------------------------------------------------------------------------
// Text widths

// Advance width of each printable ASCII character, measured in headless Chromium
// with canvas measureText in the Tailwind sans stack as the browser resolves it,
// rounded up to 0.1px. Title: text-xs font-semibold (600 12px). Subtitle: text-[11px]
// weight 400 (11px is the app-wide text floor). Re-measure if the font changes.
export const TITLE_CHAR_W = {
  " ": 3.2, "!": 4.1, "\"": 6.5, "#": 7.9, "$": 7.9, "%": 12, "&": 8.8, "'": 4, "(": 5, ")": 5,
  "*": 5.8, "+": 7.9, ",": 4, "-": 5.8, ".": 4, "/": 3.9, "0": 8, "1": 6, "2": 7.6, "3": 7.9,
  "4": 8.1, "5": 7.8, "6": 8.1, "7": 7.2, "8": 8.1, "9": 8.1, ":": 4, ";": 4, "<": 7.9, "=": 7.9,
  ">": 7.9, "?": 6.6, "@": 11.1, "A": 8.6, "B": 8.2, "C": 8.8, "D": 8.9, "E": 7.4, "F": 7.1,
  "G": 9.1, "H": 9.3, "I": 3.7, "J": 7, "K": 8.4, "L": 7.1, "M": 10.8, "N": 9.2, "O": 9.4, "P": 8,
  "Q": 9.4, "R": 8.2, "S": 8, "T": 7.9, "U": 9.1, "V": 8.5, "W": 12, "X": 8.6, "Y": 8.3, "Z": 8.1,
  "[": 5, "\\": 3.9, "]": 5, "^": 7.9, "_": 7.4, "`": 6, "a": 7, "b": 7.7, "c": 7, "d": 7.7,
  "e": 7.1, "f": 4.8, "g": 7.6, "h": 7.5, "i": 3.3, "j": 3.3, "k": 7, "l": 3.4, "m": 11, "n": 7.4,
  "o": 7.4, "p": 7.7, "q": 7.7, "r": 5, "s": 6.7, "t": 4.8, "u": 7.4, "v": 6.9, "w": 9.9, "x": 6.8,
  "y": 7, "z": 6.7, "{": 5, "|": 3.5, "}": 5, "~": 7.9,
};
export const SUB_CHAR_W = {
  "0": 7, "1": 5.2, "2": 6.8, "3": 7, "4": 7.2, "5": 6.9, "6": 7.1, "7": 6.4, "8": 7.1, "9": 7.1,
  " ": 3.2, "!": 3.5, "\"": 5.4, "#": 7, "$": 7, "%": 10.3, "&": 7.9, "'": 3.4, "(": 4.3, ")": 4.3,
  "*": 5.3, "+": 7, ",": 3.4, "-": 5.3, ".": 3.4, "/": 3.5, ":": 3.4, ";": 3.4, "<": 7, "=": 7,
  ">": 7, "?": 5.8, "@": 10.2, "A": 7.5, "B": 7.3, "C": 8, "D": 8.1, "E": 6.7, "F": 6.4, "G": 8.3,
  "H": 8.3, "I": 3.1, "J": 6, "K": 7.4, "L": 6.4, "M": 9.7, "N": 8.3, "O": 8.6, "P": 7.1, "Q": 8.6,
  "R": 7.3, "S": 7.1, "T": 7.1, "U": 8.2, "V": 7.5, "W": 10.8, "X": 7.6, "Y": 7.3, "Z": 7.4,
  "[": 4.3, "\\": 3.5, "]": 4.3, "^": 7, "_": 6.5, "`": 5.6, "a": 6.2, "b": 6.9, "c": 6.3,
  "d": 6.9, "e": 6.4, "f": 4.1, "g": 6.8, "h": 6.6, "i": 2.8, "j": 2.8, "k": 6.1, "l": 2.9,
  "m": 9.7, "n": 6.5, "o": 6.6, "p": 6.8, "q": 6.8, "r": 4.3, "s": 5.9, "t": 4.1, "u": 6.5,
  "v": 6.1, "w": 8.6, "x": 5.9, "y": 6.1, "z": 6, "{": 4.3, "|": 3, "}": 4.3, "~": 7,
};
// Anything outside a table (non-ASCII) is assumed as wide as a "W".
const textWidth = (table, wide) => (label) => [...label].reduce((sum, ch) => sum + (table[ch] ?? wide), 0);
export const titleWidth = textWidth(TITLE_CHAR_W, 12);
export const subWidth = textWidth(SUB_CHAR_W, 10.8);

// ---------------------------------------------------------------------------
// Layout

// Tailwind's spacing scale: the number times 4px ('0.5' -> 2px), or [Npx].
const spacing = (value) => {
  if (value === 'px') return 1;
  const px = value.match(/^\[(\d+(?:\.\d+)?)px\]$/);
  if (px) return Number(px[1]);
  return Number.isFinite(Number(value)) ? Number(value) * 4 : null;
};

// Font size and line height of the text classes node cards use. The page sets a
// unitless line-height of 1.5 (Tailwind preflight), so text-[11px], which sets only
// a size, gets 16.5px; text-xs brings its own 16px line height, which its children
// then inherit as a length, not as a ratio.
const TEXT = {
  'text-[11px]': { size: 11 },
  'text-xs': { size: 12, line: 16 },
  'text-sm': { size: 14, line: 20 },
  'text-base': { size: 16, line: 24 },
};
const LEADING = { 'leading-none': 1, 'leading-tight': 1.25, 'leading-snug': 1.375, 'leading-normal': 1.5 };

// Classes that do not change a height or a width. Anything else found in a card
// makes the model give up on that card rather than guess.
const INERT = /^(?:(?:bg|text|border|ring|shadow|from|to|fill|stroke|accent)-(?:brand|danger|info|ink|muted|faint|ok|violet|warn|white|on-fill|cat|line|elevated|surface|canvas|glow|node|sm)(?:\/\d+)?|ring-2|rounded(?:-.+)?|font-(?:medium|semibold|mono|bold)|tabular-nums|text-left|text-right|text-center|opacity-\d+|saturate-0|select-none|z-10|transition.*|duration-\d+|ease-.+|animate-.+|lucide.*|(?:hover|active|disabled|focus-visible|group-hover):.+|cursor-.+|overflow-hidden|relative|arch-node|justify-.+|shrink-0|min-w-0|flex-1|grow|uppercase|tracking-.+|italic|underline|whitespace-nowrap)$/;

const WEIGHTS = { 'font-medium': 500, 'font-semibold': 600, 'font-bold': 700 };

function styleOf(node, inherited) {
  const classes = classesOf(node);
  const style = {
    display: node.tag === 'span' || node.tag === 'svg' || node.tag === 'button' ? 'inline' : 'block',
    direction: 'row',
    wrap: false,
    padTop: 0,
    padBottom: 0,
    padX: 0,
    border: 0,
    marginTop: 0,
    marginBottom: 0,
    gapX: 0,
    gapY: 0,
    spaceY: 0,
    height: null,
    width: null,
    columns: 0,
    absolute: false,
    nowrap: false,
    items: 'stretch',
    size: inherited.size,
    line: inherited.line,
    weight: inherited.weight,
    mono: inherited.mono,
    unknown: [],
  };
  // Button and svg elements are inline-block; the icon svg has its own size attributes.
  if (node.tag === 'svg') {
    style.height = Number(node.attrs.height) || null;
    style.width = Number(node.attrs.width) || null;
  }
  if (node.tag === 'button') style.display = 'inline-block';
  for (const name of classes) {
    let match;
    if (name === 'hidden') style.display = 'none';
    else if (name === 'block') style.display = 'block';
    else if (name === 'inline-block') style.display = 'inline-block';
    else if (name === 'flex') style.display = 'flex';
    else if (name === 'inline-flex') style.display = 'inline-flex';
    else if (name === 'grid') style.display = 'grid';
    else if (name === 'chip') {
      // .chip in index.css: inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium
      Object.assign(style, { display: 'inline-flex', items: 'center', gapX: 6, padX: 10, padTop: 4, padBottom: 4, border: 1, size: 12, line: 16, weight: 500 });
    } else if (name === 'flex-col') style.direction = 'col';
    else if (name === 'flex-wrap') style.wrap = true;
    else if (name === 'absolute') style.absolute = true;
    else if (name === 'truncate') style.nowrap = true;
    else if ((match = name.match(/^items-(start|center|end|baseline|stretch)$/))) style.items = match[1];
    else if ((match = name.match(/^grid-cols-(\d+)$/))) style.columns = Number(match[1]);
    else if (name === 'border') style.border = 1;
    else if (TEXT[name]) {
      style.size = TEXT[name].size;
      style.line = TEXT[name].line ?? { ratio: 1.5 };
    } else if (LEADING[name]) style.line = { ratio: LEADING[name] };
    else if (WEIGHTS[name]) style.weight = WEIGHTS[name];
    else if (name === 'font-mono') style.mono = true;
    else if ((match = name.match(/^(p|py|pt|pb|px|pl|pr)-(.+)$/)) && spacing(match[2]) !== null) {
      const px = spacing(match[2]);
      if (match[1] === 'p' || match[1] === 'py' || match[1] === 'pt') style.padTop = px;
      if (match[1] === 'p' || match[1] === 'py' || match[1] === 'pb') style.padBottom = px;
      if (match[1] === 'p' || match[1] === 'px') style.padX = px * 2;
      if (match[1] === 'pl' || match[1] === 'pr') style.padX += px;
    } else if ((match = name.match(/^(m|my|mt|mb|mx|ml|mr)-(.+)$/)) && (spacing(match[2]) !== null || match[2] === 'auto')) {
      const px = match[2] === 'auto' ? 0 : spacing(match[2]);
      if (match[1] === 'm' || match[1] === 'my' || match[1] === 'mt') style.marginTop = px;
      if (match[1] === 'm' || match[1] === 'my' || match[1] === 'mb') style.marginBottom = px;
    } else if ((match = name.match(/^gap-(x-|y-)?(.+)$/)) && spacing(match[2]) !== null) {
      if (match[1] !== 'y-') style.gapX = spacing(match[2]);
      if (match[1] !== 'x-') style.gapY = spacing(match[2]);
    } else if ((match = name.match(/^space-y-(.+)$/)) && spacing(match[1]) !== null) style.spaceY = spacing(match[1]);
    else if ((match = name.match(/^h-(.+)$/))) {
      style.height = match[1] === 'full' ? 'full' : spacing(match[1]);
      if (style.height === null) style.unknown.push(name);
    } else if ((match = name.match(/^w-(.+)$/))) {
      style.width = match[1] === 'full' ? 'full' : spacing(match[1]);
      if (style.width === null) style.unknown.push(name);
    } else if (!INERT.test(name)) style.unknown.push(name);
  }
  return style;
}

const lineHeightOf = (style) => (typeof style.line === 'number' ? style.line : style.line.ratio * style.size);

// Text width in a font: the measured tables for the two fonts cards use most,
// scaled for other sizes; monospace digits and letters are 0.6em wide.
function measureText(text, style) {
  if (style.mono) return text.length * style.size * 0.6;
  const base = style.weight >= 600 ? titleWidth(text) / 12 : subWidth(text) / 11;
  return base * style.size;
}

const isInline = (style) => style.display === 'inline' || style.display === 'inline-block' || style.display === 'inline-flex';

/**
 * Lays out `node` in `width` px of available width and returns its border-box
 * height and the width its content asks for (for flex rows and wrapping).
 */
function layout(node, inherited, width, problems) {
  if (node.tag === '#text') {
    const text = node.text.replace(/\s+/g, ' ');
    if (!text.trim()) return { h: 0, w: 0, inline: true, text: 0 };
    const w = measureText(text, inherited);
    return { h: lineHeightOf(inherited), w, inline: true, text: w };
  }
  const style = styleOf(node, inherited);
  if (style.unknown.length) problems.push(...style.unknown.map((name) => `class ${name}`));
  if (style.display === 'none' || style.absolute) return { h: 0, w: 0, inline: false, skip: true };

  const fixedW = typeof style.width === 'number' ? style.width : null;
  const outerW = fixedW ?? width;
  const inner = Math.max(0, outerW - style.padX - style.border * 2);
  const chrome = style.padTop + style.padBottom + style.border * 2;
  const kids = node.children;

  let contentH = 0;
  let contentW = 0;
  const flex = style.display === 'flex' || style.display === 'inline-flex';

  if (node.tag === 'svg') {
    // Sized by its attributes or classes; what it draws does not take space.
  } else if (flex && style.direction === 'row') {
    const items = kids
      .map((child) => ({ child, box: layout(child, style, inner, problems) }))
      .filter(({ box, child }) => !box.skip && !(child.tag === '#text' && !box.w));
    const gaps = style.gapX * Math.max(0, items.length - 1);
    const natural = items.reduce((sum, { box }) => sum + box.w, 0) + gaps;
    contentW = natural;
    if (style.wrap) {
      // Items flow into rows of the available width.
      let rows = [[]];
      let used = 0;
      for (const item of items) {
        const w = item.box.w;
        if (rows.at(-1).length && used + style.gapX + w > inner + 0.01) {
          rows.push([]);
          used = 0;
        }
        used += (rows.at(-1).length ? style.gapX : 0) + w;
        rows.at(-1).push(item);
      }
      rows = rows.filter((row) => row.length);
      contentH = rows.reduce((sum, row) => sum + Math.max(...row.map(({ box }) => box.h + (box.mt ?? 0) + (box.mb ?? 0))), 0) +
        style.gapY * Math.max(0, rows.length - 1);
    } else {
      // A text item that does not fit wraps inside its share of the row.
      const fixed = items.filter(({ box }) => !box.text || box.nowrap).reduce((sum, { box }) => sum + box.w, 0);
      const flexible = items.filter(({ box }) => box.text && !box.nowrap);
      const heights = items.map((item) => {
        const { child, box } = item;
        if (flexible.includes(item) && natural > inner + 0.5) {
          const share = Math.max(1, inner - fixed - gaps);
          return layout(child, style, share, problems).h + (box.mt ?? 0) + (box.mb ?? 0);
        }
        return box.h + (box.mt ?? 0) + (box.mb ?? 0);
      });
      contentH = heights.length ? Math.max(...heights) : 0;
    }
  } else {
    // Block, flex column and grid: children stack. Runs of inline children form lines.
    const columns = style.display === 'grid' ? Math.max(1, style.columns || 1) : 1;
    const gapY = flex || style.display === 'grid' ? style.gapY : 0;
    const blocks = [];
    let run = null;
    const flush = () => {
      if (run) blocks.push(run);
      run = null;
    };
    for (const child of kids) {
      const colWidth = columns > 1 ? (inner - style.gapX * (columns - 1)) / columns : inner;
      const box = layout(child, style, colWidth, problems);
      if (box.skip) continue;
      if (!flex && style.display !== 'grid' && box.inline) {
        if (!run) run = { inline: true, parts: [] };
        run.parts.push({ child, box });
        continue;
      }
      flush();
      blocks.push({ box });
    }
    flush();

    const heights = blocks.map((block) => {
      if (!block.inline) return { h: block.box.h, mt: block.box.mt ?? 0, mb: block.box.mb ?? 0, w: block.box.w };
      const parts = block.parts.filter(({ box }) => box.w > 0 || box.h > 0);
      if (!parts.length) return null;
      const lineH = lineHeightOf(style);
      const textW = parts.reduce((sum, { box }) => sum + box.w, 0);
      const nowrap = style.nowrap || parts.every(({ box }) => box.nowrap);
      const lines = nowrap ? 1 : Math.max(1, Math.ceil((textW - 0.5) / Math.max(1, inner)));
      const tallest = Math.max(lineH, ...parts.map(({ box }) => box.h));
      return { h: tallest + (lines - 1) * lineH, mt: 0, mb: 0, w: textW };
    }).filter(Boolean);

    if (columns > 1) {
      let sum = 0;
      for (let row = 0; row < heights.length; row += columns) {
        sum += Math.max(...heights.slice(row, row + columns).map((item) => item.h));
      }
      contentH = sum + gapY * Math.max(0, Math.ceil(heights.length / columns) - 1);
    } else {
      contentH = heights.reduce((sum, item, index) => sum + item.h + item.mt + item.mb + (index ? style.spaceY + gapY : 0), 0);
    }
    contentW = Math.max(0, ...heights.map((item) => item.w));
  }

  // h-full only ever sits inside a parent with its own height, which wins.
  const h = style.height === 'full' ? contentH + chrome : style.height ?? contentH + chrome;
  const w = fixedW ?? contentW + style.padX + style.border * 2;
  const textOnly = node.children.length > 0 && node.children.every((child) => child.tag === '#text');
  return {
    h,
    w,
    mt: style.marginTop,
    mb: style.marginBottom,
    inline: isInline(style),
    text: textOnly ? w : 0,
    nowrap: style.nowrap,
  };
}

/**
 * The height an ArchNode card's content needs (the browser gives the card the larger
 * of that and its placed height). `problems` lists what the model could not read.
 */
export function cardBox(card) {
  const problems = [];
  const style = card.attrs.style ?? '';
  const width = Number(style.match(/width:(\d+(?:\.\d+)?)px/)?.[1] ?? 150);
  const inherited = { size: 16, line: { ratio: 1.5 }, weight: 400, mono: false };
  const box = layout(card, inherited, width, problems);
  return { contentHeight: box.h, problems: [...new Set(problems)] };
}

// ---------------------------------------------------------------------------
// Widths

// Card chrome left of the title: padding (p-2 = 8px a side, p-3 = 12px) + 2 border
// + 28 icon (w-7) + 8 gap (gap-2). The border was once left out, and "WHERE
// created_at >= Sep" passed at 210px while the browser clipped it by a fraction of a pixel.
export const CHROME_X = { compact: 54, regular: 62 };
// A badge (the .chip in index.css) sits on the title row and pushes the title into
// its truncation: 6 gap + 2 border + 20 padding + its text (text-xs font-medium).
// Without this, a node with a "new" badge renders as "Replic..." instead of "Replica 1".
export const BADGE_CHROME_X = 28;

/**
 * The narrowest a card can be without cutting its title or subtitle, from their
 * text: the chrome plus the wider of the title (and badge) and the subtitle.
 */
export const minCardWidth = ({ label, sub, badge, compact = true }) =>
  Math.ceil(
    CHROME_X[compact ? 'compact' : 'regular'] +
      Math.max(titleWidth(label) + (badge ? BADGE_CHROME_X + titleWidth(badge) : 0), sub ? subWidth(sub) : 0),
  );

/** Title, subtitle and badge text of an ArchNode card, read from its markup. */
export function cardText(card) {
  const header = card.children.find((child) => child.tag !== '#text');
  const textBlock = header?.children.filter((child) => child.tag !== '#text')[1];
  const [titleRow, subtitle] = textBlock?.children.filter((child) => child.tag !== '#text') ?? [];
  const [title, badge] = titleRow?.children.filter((child) => child.tag !== '#text') ?? [];
  return {
    label: title ? textOf(title) : '',
    sub: subtitle ? textOf(subtitle) : undefined,
    badge: badge ? textOf(badge) : undefined,
    compact: classesOf(card).includes('p-2'),
  };
}

// ---------------------------------------------------------------------------
// Heights of plain cards

// Rendered heights of an ArchNode card, measured in Chromium with the built
// stylesheet. A compact card (p-2, gap-1) with a title and the status line:
// 16 padding + 2 border + 28 icon row + 4 gap + 18.5 status line = 68.5; a regular
// card (p-3, gap-1.5) is 78.5. An 11px subtitle under the title makes the title block
// 32.5px, 4.5 taller than the icon; a badge on the title row is a 26px chip, so with
// a subtitle the block is 42.5 (without one the 28px icon still wins). A stat row
// (NodeStatRow) is one 16.5px line; rows stack 6px apart (space-y-1.5), and the block
// of rows takes one more card gap.
// So a compact card with a subtitle and 2 stat rows is 73 + 4 + 16.5 + 6 + 16.5 = 116.
export const CARD = {
  compact: { chrome: 18, gap: 4 },
  regular: { chrome: 26, gap: 6 },
  icon: 28,
  subtitle: 32.5,
  subtitleAndBadge: 42.5,
  status: 18.5,
  statRow: 16.5,
  rowGap: 6,
};

/** Height of a card that holds only a title, maybe a subtitle and badge, and `statRows` stat rows. */
export function cardHeight({ compact = true, sub = false, badge = false, statRows = 0 }) {
  const { chrome, gap } = CARD[compact ? 'compact' : 'regular'];
  const title = sub ? (badge ? CARD.subtitleAndBadge : CARD.subtitle) : CARD.icon;
  const rows = statRows ? gap + statRows * CARD.statRow + (statRows - 1) * CARD.rowGap : 0;
  return chrome + title + rows + gap + CARD.status;
}
