#!/usr/bin/env node
'use strict';
/*
 | THE SERVER'S WAY IN. `php artisan vsa:deploy` runs this, out of
 | vendor/vsd/asset-build, on a box that has no vsa-cli and never will:
 |
 |   node vendor/vsd/asset-build/bin/build.js [app] [options] [--root=<dir>]
 |
 |     --root=<dir>     the project (default: VSA_ROOT, else the nearest folder
 |                      upwards holding a vsa.json)
 |     --no-publish     build into a temp directory and throw it away; says
 |                      whether a build WOULD succeed without touching the app
 |     --no-minify      readable output (debugging a built page)
 |     --no-sourcemap   no .map files
 |
 | By default it PUBLISHES: builds elsewhere, and copies into public/dist only
 | after a complete success, manifest last (lib/swap.js says why).
 |
 | It needs esbuild in the PROJECT's node_modules - `npm ci` there - and php on
 | the PATH, because the project's bundle lists are PHP files read as data.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const args = process.argv.slice(2);
let rootArg = null;
let publish = true;
const pass = [];
for (const a of args) {
    if (a.startsWith('--root=')) rootArg = a.slice(7);
    else if (a === '--no-publish') publish = false;
    else if (a === '-h' || a === '--help') {
        console.log('usage: node bin/build.js [app] [--root=<dir>] [--no-publish] [--no-minify] [--no-sourcemap]');
        process.exit(2);
    } else pass.push(a);
}

function findRoot(start) {
    let dir = path.resolve(start);
    for (;;) {
        if (fs.existsSync(path.join(dir, 'vsa.json'))) return dir;
        const up = path.dirname(dir);
        if (up === dir) return null;
        dir = up;
    }
}

const ROOT = rootArg ? path.resolve(rootArg) : (process.env.VSA_ROOT ? path.resolve(process.env.VSA_ROOT) : findRoot(process.cwd()));
if (!ROOT || !fs.existsSync(path.join(ROOT, 'vsa.json'))) {
    console.error('asset-build: no vsa.json here or above - pass --root=<project folder>.');
    process.exit(1);
}

/*
 | The project's vsa.json, raw. vsa-cli merges its own defaults into this file
 | before handing it over; the build needs none of them - only "stack", so the
 | right host adapter is chosen - so a server reads it as it stands rather than
 | carrying a copy of the CLI's defaults that could drift from it.
 */
let config = {};
try { config = JSON.parse(fs.readFileSync(path.join(ROOT, 'vsa.json'), 'utf8')); }
catch (e) { console.error(`asset-build: ${ROOT}/vsa.json is not valid JSON - ${e.message}`); process.exit(1); }

const ab = require('..');
ab.configure({ ROOT, config, CLI_DIR: path.resolve(__dirname, '..') });

/* A dry run writes NOTHING into the project - not even a temp directory - so it
   is safe to ask "would this build?" on a checkout you are not deploying. */
const dry = fs.mkdtempSync(path.join(os.tmpdir(), 'vsa-build-dry-'));
let code = 1;
try {
    code = publish ? ab.publish(pass) : ab.build([...pass, `--out=${dry}`]);
} catch (e) {
    console.error('\n' + (e && e.message ? e.message : String(e)));
    code = 1;
} finally {
    fs.rmSync(dry, { recursive: true, force: true });
}
process.exit(code);
