import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, readdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest, type Server } from 'node:http';
import { once } from 'node:events';
import { createLocalServer } from '../src/server/server';
import * as fileService from '../src/server/files';
import { validateReview, type FileHooks } from '../src/server/files';
import { createReview, type Review, type Session, type Snapshot } from '../src/core/types';

const initialXML = '<title>样稿</title>\n<p>原文</p>\n';
const revisedXML = '<title>样稿</title>\n<p>人类改稿</p>\n';
const externalXML = '<title>样稿</title>\n<p>AI 的外部修订</p>\n';
const opened: Server[] = [];
const folders: string[] = [];
afterEach(async () => {
  for (const server of opened.splice(0)) if (server.listening) await new Promise<void>((done,error) => server.close(e => e ? error(e) : done()));
  for (const folder of folders.splice(0)) await rm(folder,{recursive:true,force:true});
});
async function fixture(fileHooks?: FileHooks, picker?: () => Promise<string | null>) {
  const root = await realpath(await mkdtemp(join(tmpdir(),'lark-review-server-'))); folders.push(root);
  const site = join(root,'site'); const documents = join(root,'documents');
  await mkdir(site); await mkdir(documents);
  await writeFile(join(site,'index.html'),'<main>本地编辑器</main>');
  const file = join(documents,'article.xml'); const sidecar = join(documents,'article.review.json');
  await writeFile(file,initialXML);
  const server = await createLocalServer(site,file,{fileHooks,picker}); opened.push(server);
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  const url = `http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const session = await (await fetch(url+'/api/session')).json() as Session;
  const endpoint = '/api/document?id='+session.document.id;
  const headers = {'Content-Type':'application/json','X-CSRF-Token':session.csrf};
  const get = async () => await (await fetch(url+endpoint)).json() as Snapshot;
  const put = (snapshot: Snapshot, xml = snapshot.xml, review = {...snapshot.review!,document:{...snapshot.review!.document,xml}}) => fetch(url+endpoint,{method:'PUT',headers,body:JSON.stringify({xml,review,revision:snapshot.revision})});
  return {root,site,documents,file,sidecar,url,server,session,endpoint,headers,get,put};
}
function withComment(review: Review, id: string): Review {
  return {...review,comments:[...review.comments,{id,author:'我',body:'意见 '+id,createdAt:new Date().toISOString(),status:'open',anchor:{from:1,to:3,quote:'原文',state:'attached'},replies:[]}]};
}

describe('local XML file service',() => {
  it('returns explicit text resources as inert JSON under the existing local capability and origin checks',async()=>{
    const f=await fixture();
    await writeFile(f.file,'<p>稿件</p><source path="@note.txt"/>');
    const text='<script>alert("plain text")</script>\n中文';
    await writeFile(join(f.documents,'note.txt'),text);
    const url=f.url+'/api/resource?'+new URLSearchParams({id:f.session.document.id,path:'note.txt'});
    const response=await fetch(url);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await response.json()).toEqual({path:'note.txt',text});
    expect((await fetch(url,{headers:{Origin:'https://example.com'}})).status).toBe(403);
    expect((await fetch(f.url+'/api/resource?id=unknown&path=note.txt')).status).toBe(404);
    expect((await fetch(url,{method:'PUT',headers:f.headers,body:'{}'})).status).toBe(404);
    expect(await readFile(join(f.documents,'note.txt'),'utf8')).toBe(text);
  });
  it('validates exact resource mappings and preserves them through comment-only saves', async () => {
    const f = await fixture(); const before = await f.get();
    const entry = {tag:'img', attribute:'src', value:'same-document-image', path:'resources/image.png', representation:'original'};
    const review = {...createReview('article.xml', initialXML), resources:{version:1, items:[entry]}};
    expect(validateReview(review, 'article.xml').resources).toEqual(review.resources);
    expect((await f.put(before, initialXML, review as Review)).status).toBe(200);
    expect((await f.get()).review?.resources).toEqual(review.resources);
    for (const item of [{...entry,path:'../outside.png'}, {...entry,path:'https://example.com/a.png'}, {...entry,path:'resources/code.svg'}, {...entry,representation:'preview'}]) {
      expect(() => validateReview({...review,resources:{version:1,items:[item]}},'article.xml')).toThrow();
    }
    expect(() => validateReview({...review,resources:{version:1,items:[entry,entry]}},'article.xml')).toThrow();
  });
  it('serves an explicitly mapped cloud whiteboard SVG only as inert resource text, not as a raster asset', async () => {
    const f = await fixture(); const before = await f.get();
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 35 680 130"><script>not executed</script><rect width="40" height="20"/></svg>';
    await writeFile(join(f.documents,'cloud-board.svg'),svg);
    const entry = {tag:'whiteboard',attribute:'token',value:'example-board',path:'cloud-board.svg',representation:'preview'} as const;
    const review: Review = {...createReview('article.xml',initialXML),resources:{version:1,items:[entry]}};
    expect((await f.put(before,initialXML,review)).status).toBe(200);
    const query = new URLSearchParams({id:f.session.document.id,path:entry.path});
    const response = await fetch(f.url+'/api/resource?'+query);
    expect(response.status).toBe(200); expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(await response.json()).toEqual({path:entry.path,text:svg});
    expect((await fetch(f.url+'/api/asset?'+query)).status).toBe(403);
    expect((await f.get()).xml).toBe(initialXML); expect(await readFile(join(f.documents,entry.path),'utf8')).toBe(svg);
  });
  it('persists exact original attachment mappings in the adjacent review file', async () => {
    const f = await fixture(); const before = await f.get();
    const entry = {tag:'source',attribute:'token',value:'attachment-token',path:'resources/file.png',representation:'original'} as const;
    const review: Review = {...createReview('article.xml',initialXML),resources:{version:1,items:[entry]}};
    expect((await f.put(before,initialXML,review)).status).toBe(200);
    expect((await f.get()).review?.resources?.items).toEqual([entry]);
    expect(JSON.parse(await readFile(f.sidecar,'utf8')).resources.items).toEqual([entry]);
    for (const item of [{...entry,tag:'figure'},{...entry,attribute:'src'},{...entry,representation:'preview'},
      {...entry,path:'../file.png'}]) {
      expect(() => validateReview({...review,resources:{version:1,items:[item]}},'article.xml')).toThrow();
    }
    for (const path of ['resources/file.txt','resources/file.csv','resources/file.pdf','resources/file.html']) {
      expect(validateReview({...review,resources:{version:1,items:[{...entry,path}]}},'article.xml').resources?.items[0].path).toBe(path);
    }
  });
  it('writes original XML bytes and adjacent comments, with no regular extra files',async () => {
    const f = await fixture(); const before = await f.get();
    expect(before).toMatchObject({xml:initialXML,review:null});
    expect(f.session.document).toMatchObject({name:'article.xml',path:f.file,reviewPath:f.sidecar});
    const review = withComment(createReview('article.xml',revisedXML),'first');
    const response = await f.put(before,revisedXML,review);
    expect(response.status).toBe(200);
    const saved = await response.json() as Snapshot;
    expect(saved.xml).toBe(revisedXML);
    expect(saved.review).toEqual(review);
    expect(saved.revision).not.toBe(before.revision);
    expect(await readFile(f.file,'utf8')).toBe(revisedXML);
    expect(JSON.parse(await readFile(f.sidecar,'utf8'))).toEqual(review);
    expect(await readdir(f.documents)).toEqual(['article.review.json','article.xml']);
    expect(await f.get()).toEqual(saved);
  });

  it('permits only one concurrent save from the same XML and JSON version',async () => {
    const f = await fixture(); const before = await f.get();
    const base = createReview('article.xml',initialXML);
    const results = await Promise.all([f.put(before,initialXML,withComment(base,'A')),f.put(before,initialXML,withComment(base,'B'))]);
    expect(results.map(r => r.status).sort()).toEqual([200,409]);
    const saved = await f.get();
    expect(saved.review!.comments).toHaveLength(1);
    const merged = withComment(saved.review!,'continued');
    expect((await f.put(saved,initialXML,merged)).status).toBe(200);
    expect((await f.get()).review!.comments).toHaveLength(2);
  });

  it('preserves UTF-8 BOM, CRLF, whitespace and unknown XML attributes on comment-only saves',async () => {
    const f = await fixture();
    const original = '\uFEFF<title>样稿</title>\r\n<p future-attribute="保留">  原文  </p>\r\n';
    await writeFile(f.file,original);
    const before = await f.get();
    expect(before.xml).toBe(original);
    expect((await f.put(before,original,withComment(createReview('article.xml',original),'encoding'))).status).toBe(200);
    expect(await readFile(f.file)).toEqual(Buffer.from(original,'utf8'));
  });

  it('deduplicates simultaneous opens of one canonical document',async () => {
    const f = await fixture(); const another = join(f.documents,'another.xml'); await writeFile(another,initialXML);
    const request = () => fetch(f.url+'/api/open',{method:'POST',headers:f.headers,body:JSON.stringify({path:another})});
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>(done => { enter = done; });
    const gate = new Promise<void>(done => { release = done; });
    const originalOpen = fileService.openLocalFile;
    const opening = vi.spyOn(fileService,'openLocalFile').mockImplementation(async (...args) => {
      if (args[0] === another) { enter(); await gate; }
      return originalOpen(...args);
    });
    let finishRequests!: () => void, finished = 0;
    const received = new Promise<void>(done => { finishRequests = done; });
    f.server.on('request', incoming => {
      if (incoming.url === '/api/open') incoming.once('end', () => { if (++finished === 3) finishRequests(); });
    });
    const requests = [request()];
    try {
      await entered;
      requests.push(request(),request());
      // Keep the first open pending until all request bodies have arrived and
      // their continuations have run; an exclusive busy flag rejects followers.
      await received; await new Promise<void>(done => setImmediate(done));
      const picker = await fetch(f.url+'/api/pick',{method:'POST',headers:f.headers,body:'{}'});
      expect(picker.status).toBe(409); expect((await picker.json()).code).toBe('PROJECT_BUSY');
      release();
      const responses = await Promise.all(requests);
      expect(responses.map(response => response.status)).toEqual([200,200,200]);
      const documents = await Promise.all(responses.map(r => r.json()));
      expect(documents[0].id).toEqual(expect.any(String));
      expect(new Set(documents.map(d => d.id)).size).toBe(1);
      expect(opening).toHaveBeenCalledTimes(1);
    } finally { release(); await Promise.allSettled(requests); opening.mockRestore(); }
  });

  it('detects external XML changes and JSON-only changes without overwriting either',async () => {
    const f = await fixture(); const empty = await f.get();
    const base = createReview('article.xml',initialXML);
    const first = await (await f.put(empty,initialXML,base)).json() as Snapshot;
    await writeFile(f.file,externalXML);
    expect((await f.put(first,revisedXML,{...base,document:{...base.document,xml:revisedXML}})).status).toBe(409);
    expect(await readFile(f.file,'utf8')).toBe(externalXML);
    const external = await f.get();
    expect(external.xml).toBe(externalXML);
    expect(external.review!.document.xml).toBe(initialXML);
    await writeFile(f.sidecar,JSON.stringify(withComment(base,'external-comment')));
    expect((await f.put(external,externalXML,{...base,document:{...base.document,xml:externalXML}})).status).toBe(409);
    expect((await f.get()).review!.comments[0].id).toBe('external-comment');
  });

  for (const stage of ['afterPrepare','afterSource'] as const) {
    it(`recovers a save interrupted ${stage} without duplicating or dropping comments`,async () => {
      let fail = true;
      const f = await fixture({[stage]:async () => { if (fail) { fail = false; throw new Error('simulated interruption'); } }});
      const before = await f.get(); const review = withComment(createReview('article.xml',revisedXML),'survives');
      expect((await f.put(before,revisedXML,review)).status).toBe(500);
      expect(JSON.parse(await readFile(f.sidecar,'utf8')).pendingWrite).toBeTruthy();
      expect(await readFile(f.file,'utf8')).toBe(stage === 'afterPrepare' ? initialXML : revisedXML);
      const recovered = await f.get();
      expect(recovered).toMatchObject({xml:revisedXML,review,recovery:true});
      expect(JSON.parse(await readFile(f.sidecar,'utf8')).pendingWrite).toBeUndefined();
      expect((await f.get()).recovery).toBeUndefined();
    });
  }

  it('refuses recovery over a third external XML version',async () => {
    const f = await fixture({afterPrepare:async () => { throw new Error('interrupt'); }});
    const before = await f.get();
    await f.put(before,revisedXML,createReview('article.xml',revisedXML));
    const prepared = await readFile(f.sidecar,'utf8');
    await writeFile(f.file,externalXML);
    const response = await fetch(f.url+f.endpoint);
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('RECOVERY_CONFLICT');
    expect(await readFile(f.file,'utf8')).toBe(externalXML);
    expect(await readFile(f.sidecar,'utf8')).toBe(prepared);
  });

  it('keeps the current document on picker cancellation or an invalid new sidecar',async () => {
    const f = await fixture(undefined,async () => null);
    const cancelled = await fetch(f.url+'/api/pick',{method:'POST',headers:f.headers,body:'{}'});
    expect(cancelled.status).toBe(200); expect(await cancelled.json()).toBeNull();
    const bad = join(f.documents,'bad.xml'); const unknown = '{"format":"unrelated-system","version":10}';
    await writeFile(bad,initialXML); await writeFile(join(f.documents,'bad.review.json'),unknown);
    const response = await fetch(f.url+'/api/open',{method:'POST',headers:f.headers,body:JSON.stringify({path:bad})});
    expect(response.status).toBe(409);
    expect((await (await fetch(f.url+'/api/session')).json()).document).toEqual(f.session.document);
    expect(await readFile(join(f.documents,'bad.review.json'),'utf8')).toBe(unknown);
  });

  it('rejects foreign origins, hosts, missing CSRF, and unknown document capabilities',async () => {
    const f = await fixture(); const snapshot = await f.get();
    expect((await fetch(f.url+'/api/session',{headers:{Origin:'https://example.com'}})).status).toBe(403);
    const foreignHost = await new Promise<number>((done,error) => {
      const request = httpRequest(f.url+'/api/session',{headers:{Host:'example.com'}},response => {response.resume();done(response.statusCode!);});
      request.on('error',error);request.end();
    });
    expect(foreignHost).toBe(403);
    expect((await fetch(f.url+f.endpoint,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({xml:initialXML,review:createReview('article.xml',initialXML),revision:snapshot.revision})})).status).toBe(403);
    expect((await fetch(f.url+'/api/document?id=not-open')).status).toBe(404);
    expect(await readFile(f.file,'utf8')).toBe(initialXML);
  });

  it('serves diagram modules, stylesheet and all bundled KaTeX font formats under the local CSP',async () => {
    const f = await fixture();
    const assets = join(f.site,'assets'); await mkdir(assets);
    await writeFile(join(assets,'diagram.js'),'export const diagram = true;');
    await writeFile(join(assets,'math.css'),'@font-face { font-family: KaTeX_Main; src: url(./main.woff2) format("woff2"), url(./main.woff) format("woff"), url(./main.ttf) format("truetype"); }');
    for (const extension of ['woff2','woff','ttf']) {
      const font = await readFile(new URL(`../node_modules/katex/dist/fonts/KaTeX_Main-Regular.${extension}`,import.meta.url));
      await writeFile(join(assets,`main.${extension}`),font);
    }
    const types = {'diagram.js':'text/javascript; charset=utf-8','math.css':'text/css; charset=utf-8','main.woff2':'font/woff2','main.woff':'font/woff','main.ttf':'font/ttf'};
    for (const [name,type] of Object.entries(types)) {
      const response = await fetch(`${f.url}/assets/${name}`);
      expect(response.status,name).toBe(200);
      expect(response.headers.get('content-type'),name).toBe(type);
      expect(Buffer.from(await response.arrayBuffer()),name).toEqual(await readFile(join(assets,name)));
    }
    const page = await fetch(f.url+'/');
    const policy = new Map(page.headers.get('content-security-policy')!.split(';').map(directive => {
      const [name,...sources] = directive.trim().split(/\s+/); return [name,sources];
    }));
    expect(policy.get('script-src')).toEqual(["'self'"]);
    expect(policy.get('style-src')).toEqual(["'self'","'unsafe-inline'"]);
    expect(policy.get('font-src') || policy.get('default-src')).toEqual(["'self'"]);
    expect(policy.get('connect-src')).toEqual(["'self'"]);
    const head = await fetch(f.url+'/assets/main.ttf',{method:'HEAD'});
    expect(head.headers.get('content-type')).toBe('font/ttf');
    expect(await head.text()).toBe('');
  });

  it('limits assets by relative path, canonical directory and resolved raster type',async () => {
    const f = await fixture(); const image = Buffer.from([137,80,78,71,13,10,26,10]);
    await writeFile(join(f.documents,'safe.png'),image);
    await writeFile(join(f.root,'outside.png'),image);
    await writeFile(join(f.documents,'page.html'),'<script>alert(1)</script>');
    await symlink(join(f.root,'outside.png'),join(f.documents,'escape.png'));
    await symlink(join(f.documents,'page.html'),join(f.documents,'html.png'));
    const asset = (path: string) => fetch(f.url+'/api/asset?'+new URLSearchParams({id:f.session.document.id,path}));
    const safe = await asset('safe.png'); expect(safe.status).toBe(200); expect(Buffer.from(await safe.arrayBuffer())).toEqual(image);
    for (const path of ['../outside.png','escape.png','html.png','https://example.com/x.png',join(f.root,'outside.png'),'..\\outside.png']) {
      expect((await asset(path)).status,path).toBe(403);
    }
    await symlink(join(f.root,'outside.png'),join(f.site,'secret.png'));
    expect((await fetch(f.url+'/secret.png')).status).toBe(403);
  });

  it('does not follow a sidecar symlink or write invalid XML',async () => {
    const f = await fixture(); const before = await f.get();
    const invalid = '<p>broken</h1>';
    expect((await f.put(before,invalid,createReview('article.xml',invalid))).status).toBe(400);
    expect(await readFile(f.file,'utf8')).toBe(initialXML);
    const outside = join(f.root,'outside.json'); await writeFile(outside,'keep me'); await symlink(outside,f.sidecar);
    expect((await fetch(f.url+f.endpoint)).status).toBe(409);
    expect((await f.put(before,initialXML,createReview('article.xml',initialXML))).status).toBe(409);
    expect(await readFile(outside,'utf8')).toBe('keep me');
  });
});
