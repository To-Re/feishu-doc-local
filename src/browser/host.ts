import type { Anchor, Review, Snapshot } from '../core/types';
import type { SourceDraftSnapshot } from '../ui/source-drafts';
import type { BrowserDocument, BrowserDocumentStore } from './files';

/** Local host extension. No CLI command or executable comes from document data. */
export interface EditorRecovery {
  format:'feishu-editor-draft';version:1;path:string;xml:string;review:Review;revision:string;dirty:boolean;
  pending:Anchor|null;comment:string;replies:Record<string,string>;
  invalidSource:{value:string;error:string}|null;formula:SourceDraftSnapshot;whiteboard:SourceDraftSnapshot;
}
export interface EditorController {
  capture():EditorRecovery|null;
  flush():Promise<boolean>;
  prepareClose():Promise<void>;
  acquireSync():Promise<{release():Promise<void>}>;
}
export interface EditorHost {
  label:string;
  initial:{store:BrowserDocumentStore;document:BrowserDocument;snapshot:Snapshot;recovery?:EditorRecovery|null};
  openDocument():void;
  createDocument():void;
  openSync?():void;
  openProjects?():void;
  mountToolbar?(container:HTMLElement):()=>void;
  persistRecovery(value:EditorRecovery|null):Promise<void>;
  onReady(controller:EditorController):void;
}

/** Explicit host UI actions, bridged through Obsidian workspace events. */
export const EDITOR_ACTION_EVENT='feishu-doc-local:open-action';
export const LOCAL_EDITOR_ACTION_EVENT='feishu-doc-local:open-local';
export const EDITOR_TOOLBAR_EVENT='feishu-doc-local:mount-toolbar';
export const EDITOR_EXTENSION_CHANGED_EVENT='feishu-doc-local:extension-changed';
export interface EditorToolbarRequest {path:string;container:HTMLElement;accept(dispose:()=>void):void;}
export interface EditorActionRequest {action:'sync'|'projects';path:string;handled:boolean;}
export interface LocalEditorActionRequest {action:'open'|'create';path:string;accept(result:Promise<void>):void;}
