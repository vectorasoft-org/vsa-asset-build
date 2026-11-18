#!/usr/bin/env node
'use strict';
/*
 | THE STABLE BINARY: `vsa-asset-build`. It is installed ONCE PER HOST
 |
 |   npm install -g <this repo>
 |
 | and every VSA app on that host uses it - `php artisan vsa:deploy` locates it
 | on PATH, and you can run it by hand from an app root to rebuild that app.
 | Nothing is installed per app: no composer dependency, no node_modules, no
 | npm step in a deploy. The private-repo access happens once, by hand, at
 | install time, so a deploy needs no credential of any kind.
 |
 | The price of ONE shared tool for several apps is that nothing stops an app
 | from meeting a builder older than it needs - so every app declares a minimum
 | version and `php artisan vsa:deploy` refuses below it. That is what
 | --version is for, and why it must keep working exactly as it does here.
 |
 |   vsa-asset-build [app] [options] [--root=<dir>]
 |   vsa-asset-build --version        the version the app's floor is compared to
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
 | It brings its own esbuild (pinned in this package's package-lock.json, once
 | per host instead of once per app) and needs php on the PATH, because the
 | project's bundle lists are PHP files read as data.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const args = process.argv.slice(2);

/*
 | --version first, and on its own: `php artisan vsa:deploy` runs it as its
 | version check, so it must answer without a project, without a config file
 | and without esbuild - one bare semver line on stdout, nothing else.
 */
if (args.includes('--version') || args.includes('-V')) {
    console.log(require('../package.json').version);
    process.exit(0);
}
let rootArg = null;
let publish = true;
const pass = [];
for (const a of args) {
    if (a.startsWith('--root=')) rootArg = a.slice(7);
    else if (a === '--no-publish') publish = false;
    else if (a === '-h' || a === '--help') {
        console.log('usage: vsa-asset-build [app] [--root=<dir>] [--no-publish] [--no-minify] [--no-sourcemap]');
        console.log('       vsa-asset-build --version');
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
