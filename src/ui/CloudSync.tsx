import { RefreshCw } from 'lucide-react';
import type { CloudIntent, CloudSyncReport } from '../core/cloud-types';

interface Props {
  syncing: boolean;
  disabled: boolean;
  pending?: CloudIntent;
  report: CloudSyncReport | null;
  error: string;
  onSync(): void;
}

export function CloudSync({ syncing, disabled, pending, report, error, onSync }: Props) {
  return <section className="cloud-sync" aria-label="飞书评论同步" aria-busy={syncing}>
    <div className="cloud-sync-actions"><button className="cloud-sync-button" disabled={disabled || syncing || !!pending} onClick={onSync}>
      <RefreshCw size={14}/>{syncing ? '正在同步飞书评论…' : '同步飞书评论'}
    </button></div>
    <p className="cloud-sync-hint">同步评论、回复与处理状态。白板评论按整图同步，保留本地节点引用；正文仍由你确认后发布。</p>
    {pending && <p role="status" className="cloud-sync-warning">上次同步的发送结果尚未确认，已暂停继续发送。请通过顶部“打开飞书文档”核对目标文档与本地记录。</p>}
    {syncing && <p role="status">正在同步，暂时锁定编辑，请等结果返回。</p>}
    {error && <p role="alert" className="cloud-sync-warning">{error}</p>}
    {error && <p>可通过顶部“打开飞书文档”核对实际结果。</p>}
    {report && <div className="cloud-sync-report" role="status"><p>本次同步：本地新增 {report.imported} 条，飞书新增 {report.created} 条，回复 {report.replies} 条，状态更新 {report.resolved} 条。</p>
      {report.issues.length > 0 && <details><summary>{report.issues.length} 项需要处理</summary><ul>{report.issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul></details>}
    </div>}
  </section>;
}
