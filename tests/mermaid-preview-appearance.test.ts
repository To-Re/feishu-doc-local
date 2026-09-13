// @vitest-environment jsdom
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, waitFor } from '@testing-library/dom';
import { attachWhiteboardPreview } from '../src/ui/whiteboard-preview';

const box = Object.getOwnPropertyDescriptor(SVGElement.prototype, 'getBBox');
const length = Object.getOwnPropertyDescriptor(SVGElement.prototype, 'getComputedTextLength');
let detach: (() => void) | undefined;
beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto);
  // Supply only geometry that JSDOM does not implement; use the installed
  // Mermaid parser, layout, styling and sanitizer for the actual preview.
  Object.defineProperty(SVGElement.prototype, 'getBBox', { configurable: true, value() {
    return { x: 0, y: 0, width: Math.max(40, (this.textContent || '').length * 8), height: 20 };
  }});
  Object.defineProperty(SVGElement.prototype, 'getComputedTextLength', { configurable: true, value() {
    return Math.max(40, (this.textContent || '').length * 8);
  }});
});
afterEach(() => {
  detach?.(); detach = undefined;
  document.body.replaceChildren();
  for (const [name, descriptor] of [['getBBox', box], ['getComputedTextLength', length]] as const) {
    if (descriptor) Object.defineProperty(SVGElement.prototype, name, descriptor);
    else delete (SVGElement.prototype as unknown as Record<string, unknown>)[name];
  }
  vi.unstubAllGlobals();
});

it('uses compact flat nodes while retaining author colors, edges and comment identities', async () => {
  const source = '<whiteboard id="local-source" type="mermaid"><![CDATA[flowchart LR\n' +
    'A[本地初稿] --> B{人类评审}\nB -->|需要调整| C[AI 修订]\nC --> B\nB -->|确认| D[发布飞书]\n' +
    'style A fill:#e8f0fe,stroke:#6687c5\nclassDef accepted fill:#e7f4e4,stroke:#689369\nclass D accepted\n]]></whiteboard>';
  const container = document.createElement('div'); document.body.append(container);
  const select = vi.fn();
  detach = attachWhiteboardPreview(container, source, undefined, { onComponentSelect: select });
  await waitFor(() => expect(container.querySelectorAll('[data-review-component-id]')).toHaveLength(4), { timeout: 10000 });
  const node = (id: string) => container.querySelector(`[data-review-component-id="${id}"]`)!;
  const drawing=container.querySelector('svg')!;
  expect(drawing.getAttribute('width')).toBe(drawing.getAttribute('viewBox')!.split(/\s+/)[2]);
  expect(drawing.style.maxWidth).toBe('100%');
  expect(container.querySelectorAll('.flowchart-link')).toHaveLength(4);
  expect(container.textContent).toContain('需要调整');
  expect(container.querySelector('[data-look="neo"],foreignObject,image,a')).toBeNull();
  expect(node('A').querySelector('rect')?.getAttribute('style')).toContain('fill:#e8f0fe');
  expect(node('D').querySelector('rect')?.getAttribute('style')).toContain('fill:#e7f4e4');
  // Short labels must no longer inherit Mermaid 12's 120px minimum label
  // area. Explicit source shapes (including the decision) remain intact.
  expect(Number(node('C').querySelector('rect')?.getAttribute('width'))).toBeLessThan(120);
  expect(node('B').querySelector('polygon')).not.toBeNull();
  for (const shape of container.querySelectorAll('.node rect,.node polygon')) {
    expect(shape.getAttribute('filter')).toBeNull();
    expect(shape.getAttribute('style') || '').not.toContain('filter:');
  }
  fireEvent.click(node('B'));
  expect(select).toHaveBeenCalledWith({ kind: 'whiteboard-component', board: 'id:local-source', id: 'B', label: '人类评审' });
}, 15000);
