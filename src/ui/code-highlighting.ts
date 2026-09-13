import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { createLowlight } from 'lowlight';
import go from 'highlight.js/lib/languages/go';
import javascript from 'highlight.js/lib/languages/javascript';
import type { RootContent } from 'hast';

// Explicit grammars keep unknown languages readable without guessing their syntax.
const lowlight = createLowlight({ go, javascript });
type HighlightRange = { from: number; to: number; classes: string[] };

function highlightRanges(node: PMNode): HighlightRange[] {
  const language = String(node.attrs.language || '').trim().toLowerCase();
  if (!lowlight.registered(language)) return [];
  const ranges: HighlightRange[] = [];
  let offset = 0;
  function visit(children: RootContent[], inherited: string[] = []) {
    for (const child of children) {
      if (child.type === 'text') {
        // Lowlight text and ProseMirror positions both use UTF-16 code units.
        const end = offset + child.value.length;
        if (inherited.length && end > offset) ranges.push({ from: offset, to: end, classes: inherited });
        offset = end;
      } else if (child.type === 'element') {
        const classes = Array.isArray(child.properties.className)
          ? child.properties.className.filter((value): value is string => typeof value === 'string') : [];
        visit(child.children, [...inherited, ...classes]);
      }
    }
  }
  visit(lowlight.highlight(language, node.textContent).children);
  return ranges;
}

export function codeHighlightingPlugin(): Plugin<DecorationSet> {
  // Reuse unchanged immutable nodes during edits elsewhere in the document.
  const cache = new WeakMap<PMNode, HighlightRange[]>();
  function decorate(doc: PMNode): DecorationSet {
    const decorations: Decoration[] = [];
    doc.descendants((node, position) => {
      if (node.type.name !== 'codeBlock') return;
      let ranges = cache.get(node);
      if (!ranges) { ranges = highlightRanges(node); cache.set(node, ranges); }
      for (const range of ranges) {
        decorations.push(Decoration.inline(position + 1 + range.from, position + 1 + range.to, { class: range.classes.join(' ') }));
      }
      return false;
    });
    return DecorationSet.create(doc, decorations);
  }
  return new Plugin<DecorationSet>({
    key: new PluginKey('xmlCodeHighlighting'),
    state: {
      init: (_, state) => decorate(state.doc),
      apply: (transaction, previous) => transaction.docChanged ? decorate(transaction.doc) : previous,
    },
    props: { decorations(state) { return this.getState(state); } },
  });
}
