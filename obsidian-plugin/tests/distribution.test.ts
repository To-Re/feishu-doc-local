// @vitest-environment node
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import postcss from 'postcss';
import { expect, it } from 'vitest';

it('ships a desktop CommonJS plugin with isolated styles, bundled fonts and license files',async()=>{
  const directory=fileURLToPath(new URL('../dist/',import.meta.url));
  const manifest=JSON.parse(await readFile(directory+'manifest.json','utf8'));
  expect(manifest.id).toBe('feishu-doc-local');expect(manifest.isDesktopOnly).toBe(true);
  const main=await readFile(directory+'main.js','utf8');
  expect(main).toContain('module.exports');expect(main).toContain('require("obsidian")');
  expect(main).not.toContain('127.0.0.1:4318');expect(main).not.toContain('readWhiteboardResource');
  const styles=await readFile(directory+'styles.css','utf8');
  postcss.parse(styles).walkRules(rule=>{for(const selector of rule.selectors)expect(/^\.feishu-doc-local-view(?:\s|$)/.test(selector)).toBe(true);});
  expect(styles).toContain('data:font/');expect(styles).not.toMatch(/url\(["']?(?:https?:|fonts\/)/);
  expect(await readFile(directory+'LICENSE','utf8')).toContain('MIT License');
  expect(await readFile(directory+'THIRD_PARTY_NOTICES.md','utf8')).toMatch(/mermaid/i);
});

it('lets the ordinary XML preview scroll inside the host with overflow hidden',async()=>{
  const styles=postcss.parse(await readFile(new URL('../dist/styles.css',import.meta.url),'utf8'));
  const declarations:Record<string,string>={};
  styles.walkRules(rule=>{if(rule.selectors.includes('.feishu-doc-local-view .fdl-plain-xml'))rule.walkDecls(declaration=>{declarations[declaration.prop]=declaration.value;});});
  expect(declarations).toMatchObject({flex:'1','min-height':'0','min-width':'0',overflow:'auto'});
  expect(declarations.padding).toBeTruthy();
});
