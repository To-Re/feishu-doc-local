import { SaxesParser } from 'saxes';

export type WhiteboardSource = { type: 'mermaid' | 'svg'; source: string; openEnd: number; closeStart: number };

/** Only inline source is editable. A cloud reference never becomes a local source. */
export function readWhiteboardSource(rawXML: unknown): WhiteboardSource | null {
  if (typeof rawXML !== 'string' || rawXML.length > 2_000_000) return null;
  const parser = new SaxesParser({ xmlns: false });
  let depth = 0, openEnd = 0, closeStart = 0, source = '', childStart = 0, childEnd = 0, children = 0;
  let type: WhiteboardSource['type'] | undefined;
  let unsupported = false;
  parser.on('error', error => { throw error; });
  parser.on('doctype', () => { throw new Error('不支持 XML 声明。'); });
  parser.on('processinginstruction', () => { unsupported = true; });
  parser.on('comment', () => { if (depth < 2) unsupported = true; });
  parser.on('opentag', tag => {
    if (depth >= 256) throw new Error('白板嵌套超过 256 层。');
    if (depth === 0) {
      const candidate = String(tag.attributes.type || '').trim().toLowerCase();
      if (tag.name !== 'whiteboard' || !['mermaid', 'svg'].includes(candidate) ||
        ['src', 'token', 'path'].some(attribute => Object.hasOwn(tag.attributes, attribute))) unsupported = true;
      else type = candidate as WhiteboardSource['type'];
      openEnd = parser.position;
    } else if (depth === 1) {
      children += 1;
      childStart = rawXML.lastIndexOf('<', parser.position - 1);
      if (type !== 'svg' || tag.name !== 'svg' || children > 1) unsupported = true;
    }
    depth += 1;
  });
  parser.on('closetag', tag => {
    depth -= 1;
    if (depth === 1) childEnd = parser.position;
    if (!depth) closeStart = tag.isSelfClosing ? openEnd : rawXML.lastIndexOf('</', parser.position - 1);
  });
  const text = (value: string) => { if (depth === 1) source += value; };
  parser.on('text', text); parser.on('cdata', text);
  try { parser.write(rawXML).close(); } catch { return null; }
  if (unsupported || !type || !closeStart) return null;
  if (children) {
    if (source.trim()) return null;
    source = rawXML.slice(childStart, childEnd);
  }
  if (!source.trim()) return null;
  return { type, source, openEnd, closeStart };
}

function validateSVG(source: string) {
  const parser = new SaxesParser({ xmlns: false });
  let depth = 0;
  parser.on('error', error => { throw error; });
  parser.on('doctype', () => { throw new Error('SVG 不允许 DOCTYPE 或实体声明。'); });
  parser.on('processinginstruction', () => { throw new Error('SVG 不支持处理指令。'); });
  parser.on('opentag', tag => {
    if (depth >= 256) throw new Error('SVG 嵌套超过 256 层。');
    if (!depth && tag.name !== 'svg') throw new Error('需要完整的 SVG 图形。');
    depth += 1;
  });
  parser.on('closetag', () => { depth -= 1; });
  parser.write(source).close();
}

/** Preserve the exact surrounding XML; replacing source is one intentional atomic edit. */
export function replaceWhiteboardSource(rawXML: string, source: string): string {
  const board = readWhiteboardSource(rawXML);
  if (!board) throw new Error('此白板没有可编辑的内联图源。');
  if (source === board.source) return rawXML;
  if (!source.trim()) throw new Error('白板图源不能为空。');
  if (source.length > (board.type === 'mermaid' ? 50_000 : 1_900_000)) throw new Error('白板图源超过本地编辑长度限制。');
  if (board.type === 'svg') validateSVG(source);
  // Official typed SVG boards require an actual SVG child element. Mermaid
  // remains character data; splitting CDATA terminators preserves its text.
  const body = board.type === 'svg' ? source : '<![CDATA[' + source.replace(/\]\]>/g, ']]]]><![CDATA[>') + ']]>';
  const result = rawXML.slice(0, board.openEnd) + body + rawXML.slice(board.closeStart);
  if (!readWhiteboardSource(result)) throw new Error('白板图源包含无效的 XML 字符。');
  return result;
}
