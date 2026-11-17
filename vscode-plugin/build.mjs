import { build } from 'esbuild';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { copyDistributionNotices } from '../scripts/copy-distribution-notices.mjs';
const here=fileURLToPath(new URL('.',import.meta.url));
await rm(new URL('dist/',import.meta.url),{recursive:true,force:true});
await mkdir(new URL('dist/',import.meta.url),{recursive:true});
for(const [entry,outfile,platform] of [['src/extension.ts','dist/extension.cjs','node'],['src/webview.ts','dist/webview.js','browser']]){
 const result=await build({absWorkingDir:here,entryPoints:[entry],outfile,bundle:true,platform,format:platform==='node'?'cjs':'iife',target:'es2022',external:platform==='node'?['vscode']:[],minify:true,metafile:true,legalComments:'eof',loader:{'.woff':'dataurl','.woff2':'dataurl','.ttf':'dataurl'},define:{'process.env.NODE_ENV':'"production"'}});
 await writeFile(new URL(platform==='node'?'dist/host-meta.json':'dist/webview-meta.json',import.meta.url),JSON.stringify(result.metafile,null,2));
}
await copyDistributionNotices(['vscode-plugin/dist']);
