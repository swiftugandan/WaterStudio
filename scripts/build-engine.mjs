#!/usr/bin/env node
// Builds the WebAssembly engine and copies it to packages/engine-client/wasm/.
// With --copy-only, copies an existing build (CI downloads it as an artifact).
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const built = join(root, 'engine/target/wasm32-unknown-unknown/release/ws_wasm.wasm');
const dest = join(root, 'packages/engine-client/wasm/ws_wasm.wasm');

if (!process.argv.includes('--copy-only')) {
  execFileSync('cargo', ['build', '--release', '--target', 'wasm32-unknown-unknown', '-p', 'ws-wasm'], {
    cwd: join(root, 'engine'),
    stdio: 'inherit',
  });
}
if (!existsSync(built)) {
  console.error(`missing ${built}`);
  process.exit(1);
}
mkdirSync(dirname(dest), { recursive: true });
copyFileSync(built, dest);
console.log(`copied the engine to ${dest}`);
