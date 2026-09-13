export interface WhiteboardComponentTarget {
  kind: 'whiteboard-component';
  /** Stable board identity supplied by its rendered source, independent of its document position. */
  board: string;
  /** Actual node id within that board, never a generated label or text match. */
  id: string;
  label?: string;
}
export type AnchorTarget = WhiteboardComponentTarget;
export interface Anchor { from: number; to: number; quote: string; state: 'attached' | 'deleted' | 'unverified'; target?: AnchorTarget; }
export interface Reply { id: string; author: string; body: string; createdAt: string; }
export interface ReviewComment { id: string; author: string; body: string; createdAt: string; status: 'open' | 'resolved'; anchor: Anchor; replies: Reply[]; }
export interface ReviewOperation { id: string; type: string; author: string; at: string; summary: string; }
export type ResourceMapping = {
  value: string; path: string;
} & ({ tag: 'img'; attribute: 'src' | 'token'; representation: 'original' } | { tag: 'whiteboard'; attribute: 'src' | 'token' | 'path'; representation: 'preview' } |
  { tag: 'source'; attribute: 'token'; representation: 'original' });
export interface ResourceManifest { version: 1; items: ResourceMapping[]; }
export interface Review {
  format: 'lark-review'; version: 1;
  document: { name: string; baselineXML: string; xml: string; updatedAt: string; };
  comments: ReviewComment[];
  operations: ReviewOperation[];
  resources?: ResourceManifest;
  cloudSync?: import('./cloud-types').CloudSyncState;
  contentSync?: import('./projects').ContentSyncState;
  result?: { author: string; summary: string; appliedAt: string; };
}
export interface Snapshot { xml: string; review: Review | null; revision: string; recovery?: boolean; }
export interface DocumentHandle { id: string; name: string; path: string; reviewPath: string; }
export interface Session { csrf: string; document: DocumentHandle; nativePicker: boolean; homeDirectory?:string; cloud?: { url: string; documentId: string; localPath: string }; project?: import('./projects').ReviewProject; }
export const uid = () => globalThis.crypto.randomUUID();
export function createReview(name: string, xml: string): Review { return {format:'lark-review', version:1, document:{name,baselineXML:xml,xml,updatedAt:new Date().toISOString()},comments:[],operations:[]}; }
