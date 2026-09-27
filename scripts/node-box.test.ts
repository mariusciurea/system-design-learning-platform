import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardBox, cardHeight, cardText, minCardWidth, parseMarkup } from './node-box.mjs';

// The markup ArchNode renders (react-dom/server), trimmed to what sizes the card.
const card = ({ compact = true, sub = '', rows = 0, badge = '', extra = '' }) =>
  parseMarkup(
    `<div style="position:absolute;left:0px;top:0px;width:200px;min-height:60px" class="arch-node z-10 flex flex-col rounded-xl border ${compact ? 'gap-1 p-2' : 'gap-1.5 p-3'}">` +
      '<div class="flex items-start gap-2"><span class="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg">' +
      '<svg width="24" height="24" class="lucide h-4 w-4"><path d="M0 0"></path></svg></span>' +
      '<div class="min-w-0 flex-1"><div class="flex items-center gap-1.5"><span class="truncate text-xs font-semibold">Redis</span>' +
      (badge ? `<span class="chip border-brand/30">${badge}</span>` : '') +
      '</div>' +
      (sub ? `<div class="truncate text-[11px] text-faint">${sub}</div>` : '') +
      '</div></div>' +
      (rows || extra
        ? '<div class="space-y-1.5">' +
          '<div class="flex items-baseline justify-between gap-2 text-[11px]"><span class="truncate text-faint">Hit rate</span><span class="font-mono font-semibold tabular-nums">42%</span></div>'.repeat(rows) +
          extra +
          '</div>'
        : '') +
      '<span class="inline-flex items-center gap-1.5 text-[11px] font-medium mt-auto pt-0.5"><span class="relative flex h-2 w-2"></span>Healthy</span>' +
      '</div>',
  ).children[0];

test('a compact card with a subtitle and 2 stat rows is 116px, as Chromium renders it', () => {
  assert.equal(cardBox(card({ sub: 'cache', rows: 2 })).contentHeight, 116);
});

test('the markup model and the card table agree', () => {
  for (const compact of [true, false])
    for (const sub of ['', 'cache'])
      for (const badge of ['', 'new'])
        for (const rows of [0, 1, 2, 3]) {
          const modelled = cardBox(card({ compact, sub, badge, rows })).contentHeight;
          assert.equal(modelled, cardHeight({ compact, sub: Boolean(sub), badge: Boolean(badge), statRows: rows }), `${compact} ${sub} ${badge} ${rows}`);
        }
});

test('a badge makes the card taller only when there is a subtitle', () => {
  assert.equal(cardHeight({ badge: true }), cardHeight({}));
  assert.equal(cardHeight({ sub: true, badge: true }) - cardHeight({ sub: true }), 10);
});

test('a class the model does not know is reported, not guessed', () => {
  const { problems } = cardBox(card({ extra: '<div class="h-7 leading-loose">x</div>' }));
  assert.deepEqual(problems, ['class leading-loose']);
});

test('title, subtitle and badge are read from the markup', () => {
  const text = cardText(card({ sub: 'cache', badge: 'new' }));
  assert.deepEqual(text, { label: 'Redis', sub: 'cache', badge: 'new', compact: true });
  assert.ok(minCardWidth(text) > minCardWidth({ ...text, badge: undefined }));
});
