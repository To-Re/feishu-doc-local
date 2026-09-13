import { defineConfig } from 'vitest/config';
export default defineConfig({plugins:[{name:'test-obsidian-runtime',enforce:'pre',resolveId(id){if(id==='obsidian')return id;}}],test:{environment:'jsdom',include:['tests/**/*.test.ts','tests/**/*.test.tsx'],testTimeout:15000}});
