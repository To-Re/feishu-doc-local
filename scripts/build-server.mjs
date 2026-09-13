import { build } from 'esbuild';
await build({entryPoints:['src/server/start.ts'],outfile:'dist/server/start.js',bundle:true,platform:'node',format:'esm',target:'node22'});
