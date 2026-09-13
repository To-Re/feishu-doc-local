import { X } from 'lucide-react';

export function ProjectCreationNotice({ message, onClose }: { message: string; onClose(): void }) {
  return <aside className="notice" aria-label="创建时提示">
    <div><strong>创建时提示</strong><p>{message}</p><p>这是创建时的记录；如果已在飞书处理，可关闭。</p></div>
    <button type="button" aria-label="关闭创建时提示" onClick={onClose}><X size={14}/></button>
  </aside>;
}
