import { rename } from 'node:fs/promises';
import { copyDistributionNotices } from './copy-distribution-notices.mjs';
await rename('dist/browser/browser.html','dist/browser/index.html');
await copyDistributionNotices(['dist/browser']);
