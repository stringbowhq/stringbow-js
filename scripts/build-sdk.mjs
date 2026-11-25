#!/usr/bin/env node
// Builds publishable bundles of the two SDKs into packages/*/dist (ESM, CommonJS and type declarations).
// The shared core is private. Only its SDK entry (packages/core/src/sdk.ts) is bundled into each SDK, and the
// types of that entry are shipped next to them as core.d.ts. The rest of the core never reaches a package.
// Real dependencies stay external. Usage: npm run build:sdk
import { spawnSync } from 'node:child_process';
import { copyFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tsup = join(root, 'node_modules', '.bin', 'tsup');
const run = (args, cwd) => { const r = spawnSync(tsup, args, { cwd, stdio: 'inherit' }); if (r.status !== 0) process.exit(r.status ?? 1); };

// The types of the core's SDK entry, once.
const tmp = join(root, '.sdk-tmp');
run(['src/sdk.ts', '--dts-only', '--format', 'esm', '--out-dir', tmp, '--tsconfig', join(root, 'tsconfig.sdk.json'), '--silent'], join(root, 'packages', 'core'));

for (const dir of ['packages/browser', 'packages/node']) {
  console.log(`[build:sdk] ${dir}`);
  const cwd = join(root, dir);
  run(['--silent'], cwd);
  for (const [decl, core] of [['index.d.ts', 'core.d.ts'], ['index.d.cts', 'core.d.cts']]) {
    copyFileSync(join(tmp, 'sdk.d.ts'), join(cwd, 'dist', core));
    const file = join(cwd, 'dist', decl);
    writeFileSync(file, readFileSync(file, 'utf8').replaceAll("'@stringbow/core/sdk'", core === 'core.d.ts' ? "'./core.js'" : "'./core.cjs'"));
  }
}
rmSync(tmp, { recursive: true, force: true });
console.log('[build:sdk] done');
