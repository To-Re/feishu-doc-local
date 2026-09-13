export interface CloudReply {
  id: string; body: string; author: string; createdAt: string;
  raw?: unknown;
}
export interface CloudComment {
  id: string; body: string; author: string; createdAt: string;
  status: 'open'|'resolved'; quote: string;
  blockId?: string; boardToken?: string; whole?: boolean;
  replies: CloudReply[]; raw?: unknown;
}
/** All document/comment/reply pages must be complete, otherwise read rejects. */
export interface CloudSnapshot { documentId: string; xml: string; comments: CloudComment[]; }
export interface CloudTransport {
  read(): Promise<CloudSnapshot>;
  create(blockId: string|undefined, body: string): Promise<{id:string}>;
  reply(commentId: string, body: string): Promise<{id:string}>;
  resolve(commentId: string, solved: boolean): Promise<void>;
}
export interface CloudCLIOptions { command: string; args: string[]; documentId: string; url: string; }
export interface CloudLink {
  localId: string; cloudId: string; body: string; cloudBody: string;
  status: 'open'|'resolved';
  replies: Record<string,{cloudId:string;body:string}>;
  remote: CloudComment;
}
export interface CloudIntent {
  id:string; kind:'create'|'reply'|'status'; localId:string; startedAt:string;
  localReplyId?:string; cloudId?:string; body?:string; status?:'open'|'resolved';
}
export interface CloudSyncState {
  version:1; documentId:string; url:string; links:CloudLink[];
  lastSyncedAt?:string; pending?:CloudIntent;
}
export interface CloudSyncReport {
  imported:number; created:number; replies:number; resolved:number;
  issues:string[]; syncedAt:string;
}
