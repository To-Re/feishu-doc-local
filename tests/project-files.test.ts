import { describe, expect, it } from 'vitest';
import { createReview } from '../src/core/types';
import { localResourcePath, projectFiles } from '../src/core/project-files';

const handle = { name:'article.xml',path:'/project/article.xml',reviewPath:'/project/article.review.json' };
describe('explicit document project files', () => {
  it('collects nested references and sidecar resources once, preserving document/review roles', () => {
    const xml='<img path="@./images/a.png"/><figure><source path="@assets/note.txt"/></figure><whiteboard path="@boards/flow.svg"/><img path="@article.xml"/><source path="@article.review.json"/>';
    const review={...createReview('article.xml',xml),resources:{version:1 as const,items:[{tag:'source' as const,attribute:'token' as const,value:'attachment',path:'./assets/note.txt',representation:'original' as const}]}};
    expect(projectFiles(handle,xml,review)).toEqual([
      {path:'article.xml',name:'article.xml',kind:'document'}, {path:'article.review.json',name:'article.review.json',kind:'review'},
      {path:'assets/note.txt',name:'note.txt',kind:'resource'}, {path:'images/a.png',name:'a.png',kind:'resource'}, {path:'boards/flow.svg',name:'flow.svg',kind:'resource'},
    ]);
  });
  it('never includes directories to scan, remote paths, parent traversal or unrelated attrs', () => {
    for (const value of ['', '/', '../secret.txt','a/../secret.txt','C:\\secret.txt','https://example.com/a.txt','\\server\\share','a\0.txt']) expect(localResourcePath(value)).toBeUndefined();
    const xml='<img src="https://example.com/a.png"/><source path="@../secret.txt"/><whiteboard path="@/private/secret.svg"/><p path="@unrelated.txt">内容</p>';
    expect(projectFiles(handle,xml,null).map(file=>file.kind)).toEqual(['document','review']);
    expect(localResourcePath('./a//b.txt')).toBe('a/b.txt');
  });
});
