import type { DocumentHandle, Session, Snapshot } from './types';

export type SyncDirection = 'pull' | 'push';
export interface ProjectCloud { documentId:string; url:string; }
export interface ReviewProject {
  id:string; name:string; localPath:string; defaultDirection:SyncDirection;
  cloud?:ProjectCloud; createdAt:string;
}
export interface ProjectList { projects:ReviewProject[]; activeProjectId?:string; cloudAvailable:boolean; }
export interface ProjectSession extends Session { project?:ReviewProject; }
export interface CreateProjectInput {
  name:string;
  local:{kind:'existing'|'new';path:string};
  cloud:{kind:'none'}|{kind:'existing';url:string}|{kind:'new';title:string;parentToken?:string};
  defaultDirection:SyncDirection;
}
export interface BindProjectInput {
  revision:string;
  cloud:{kind:'existing';url:string}|{kind:'new';title:string;parentToken?:string};
  defaultDirection:SyncDirection;
}
export interface ProjectOpenResult { session:ProjectSession; snapshot:Snapshot; projects:ReviewProject[]; warning?:string; }
export interface ContentPreview {
  id:string; projectId:string; direction:SyncDirection; status:'equal'|'ready'|'conflict';
  action?:'refresh-local';
  localXML:string; cloudXML:string; warnings:string[]; summary:string; expiresAt:string;
}
export interface ContentSyncResult { snapshot:Snapshot; project:ReviewProject; summary:string; warnings:string[]; }
export interface ContentRestorePreview {
  id:string; localPath:string; snapshotPath:string; createdAt:string;
  localXML:string; snapshotXML:string; warnings:string[]; expiresAt:string;
}
export interface ContentRestoreResult { snapshot:Snapshot; summary:string; warnings:string[]; }
export interface ContentSyncState {
  version:1; documentId:string; localXML:string; cloudXML:string; cloudRevision:number; syncedAt:string;
  localAssets?:Record<string,string>;
  pending?:{id:string;direction:SyncDirection|'create';startedAt:string;sourceXML:string;cloudRevision?:number};
}
export type ProjectHandle = DocumentHandle;
