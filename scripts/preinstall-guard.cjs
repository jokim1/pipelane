#!/usr/bin/env node
/*
 * Preinstall guard: refuses `npm install` / `npm ci` in a worktree where
 * `node_modules` is a symlink. Pipelane symlinks each task worktree's
 * `node_modules` into the shared repo's, and npm's reify step can wipe the
 * shared target as a side effect. Aborting in `preinstall` runs before reify
 * touches anything.
 *
 * Standalone CommonJS with no imports beyond node:fs / node:path so it works
 * even if pipelane itself isn't loaded yet. The consumer's package.json
 * preinstall script gracefully no-ops when this file isn't on disk
 * (first-install bootstrap), so this guard only activates once pipelane is
 * present — which is exactly when the symlink risk also exists.
 *
 * Warning text duplicates SHARED_NODE_MODULES_NPMCI_WARNING from
 * src/operator/task-workspaces.ts. A test asserts the two stay in sync.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const WARNING =
  'node_modules in this worktree is a symlink into the shared repo\'s ' +
  'node_modules. Do NOT run `npm ci` or `npm install` in this worktree ' +
  'without breaking the symlink first — npm may wipe the shared ' +
  'node_modules as a side effect. To safely reinstall deps here: ' +
  '`rm node_modules && npm install` (the `rm` only removes the symlink, ' +
  'not its target).';

const target = path.join(process.cwd(), 'node_modules');
let stat;
try {
  stat = fs.lstatSync(target);
} catch {
  process.exit(0);
}

if (stat.isSymbolicLink()) {
  process.stderr.write(`[pipelane preinstall-guard] ${WARNING}\n`);
  process.exit(1);
}

process.exit(0);
