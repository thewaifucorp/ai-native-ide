#!/usr/bin/env node
/*
 * patch-drivelist.js
 *
 * Why: on this host (Node 22 / Linux, project path contains spaces + non-ASCII,
 * "Área de trabalho") the `drivelist` native addon fails to build and its
 * prebuilt binary 404s. Even when compiled in a space-free path, the resulting
 * drivelist.node segfaults on dlopen here. drivelist is only used by
 * @theia/core's env-variables-server to enumerate physical drives, which a
 * browser IDE does not need to boot.
 *
 * This replaces node_modules/drivelist/js/index.js with a pure-JS stub whose
 * `list()` returns []. Re-run after every `yarn install` / `npm install`,
 * because the installer re-extracts drivelist and overwrites the stub.
 */
const fs = require('fs');
const path = require('path');

const target = path.resolve(__dirname, '..', 'node_modules', 'drivelist', 'js', 'index.js');
const stub = `"use strict";
// SPIKE STUB (ide-theia-spike): native drivelist.node segfaults on dlopen on
// this host. drivelist only enumerates physical drives (unused by a browser IDE).
Object.defineProperty(exports, "__esModule", { value: true });
exports.list = list;
function list() {
    return Promise.resolve([]);
}
`;

if (!fs.existsSync(target)) {
  console.error('[patch-drivelist] drivelist not installed at', target);
  process.exit(0);
}
fs.writeFileSync(target, stub);
console.log('[patch-drivelist] stubbed', target);
