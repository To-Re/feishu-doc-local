import { build } from 'esbuild';
import postcss from 'postcss';
import { cp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here=dirname(fileURLToPath(import.meta.url)),root=resolve(here,'..'),out=resolve(here,'dist');
await mkdir(out,{recursive:true});
const bundle=await build({absWorkingDir:here,entryPoints:['src/main.ts'],outfile:'dist/main.js',bundle:true,format:'cjs',platform:'browser',target:'es2022',
  external:['obsidian','electron'],loader:{'.woff':'dataurl','.woff2':'dataurl','.ttf':'dataurl'},minify:true,metafile:true,legalComments:'eof',logLevel:'info',define:{'process.env.NODE_ENV':'"production"'}});
await writeFile(resolve(out,'build-meta.json'),JSON.stringify(bundle.metafile,null,2));
const article=postcss.parse(await readFile(resolve(out,'main.css'),'utf8'));
article.walkRules(rule=>{
  if(rule.parent?.type==='atrule'&&rule.parent.name.endsWith('keyframes'))return;
  rule.selectors=rule.selectors.map(selector=>{
    const replaced=selector.replace(/:root|(?<![\w-])(?:html|body)(?![\w-])|#root/g,'.feishu-doc-local-view');
    return replaced.startsWith('.feishu-doc-local-view')?replaced:'.feishu-doc-local-view '+replaced;
  });
});
article.walkAtRules(rule=>{if(!rule.nodes?.length)rule.remove();});
await writeFile(resolve(out,'styles.css'),article.toString()+'\n'+await readFile(resolve(here,'src/styles.css'),'utf8'));
await rm(resolve(out,'main.css'),{force:true});
for(const name of ['manifest.json','README.md'])await cp(resolve(here,name),resolve(out,name));
for(const name of ['LICENSE','THIRD_PARTY_NOTICES.md','licenses'])await cp(resolve(root,name),resolve(out,name),{recursive:true});
console.log('Plugin ready: obsidian-plugin/dist/ (main.js, manifest.json, styles.css, licenses)');
