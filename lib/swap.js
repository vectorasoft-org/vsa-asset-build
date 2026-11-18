'use strict';
/*
 | THE ATOMIC BUILD: build somewhere else, publish only on success.
 |
 | WHY. Under the old model public/dist was committed, so a failed build on a
 | developer's Mac cost nothing - the server kept serving the last committed
 | chunks. Now the server builds, public/dist is gitignored, and there is no
 | committed copy to fall back on: a build that half-wrote public/dist would
 | leave the box with NO assets, which is far worse than stale ones. So nothing
 | touches public/dist until a build has completely succeeded.
 |
 | HOW, and why not a directory swap. public/dist is NOT the build's private
 | directory: edv-wis keeps login-styles.css and report-styles.css there,
 | written by bundles the app shell never renders and loaded by their own
 | views. Renaming a fresh directory over it would delete them. So:
 |
 |   1. build into a temp directory outside public/, with the CURRENT
 |      manifest.json seeded into it - `vsa build <app>` merges its result into
 |      the existing manifest, and without the seed every OTHER app would drop
 |      out of it and their shells would fall back to raw tags.
 |   2. on failure: delete the temp directory. public/dist was never touched,
 |      and the app still serves the build it was serving a minute ago.
 |   3. on success: copy the new files in, and write manifest.json LAST. The
 |      manifest is the only file anything reads to find a chunk, and every
 |      chunk is content-hashed, so until that write a request sees the old
 |      manifest with its chunks all still present, and after it the new
 |      manifest with its chunks all already present. There is no moment with
 |      a manifest pointing at a file that is not there.
 |   4. only then prune the chunks the new manifest no longer references, by
 |      the build's own naming rule - never anything else in public/dist.
 */
const fs = require('fs');
const path = require('path');
const h = require('./host');
const build = require('./build');
const { C } = require('./report');

const DIST = 'public/dist';

/** Every file under dir, as paths relative to it (forward slashes). */
function walk(dir, base = dir, out = []) {
    if (!fs.existsSync(dir)) return out;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) walk(abs, base, out);
        else if (e.isFile()) out.push(path.relative(base, abs).split(path.sep).join('/'));
    }
    return out;
}

/*
 | The temp directory lives in storage/, not under public/: a half-written
 | chunk under the document root is briefly reachable by a browser, and
 | storage/ is writable by the app user on every box by definition. Same
 | filesystem as public/ (both inside the project), so the copies are local.
 */
function tempRoot(root) {
    const dir = path.join(root, 'storage', 'framework', 'vsa-build', String(process.pid));
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

/**
 * Build, then publish into public/dist only if it worked.
 * args: the same arguments `vsa build` takes ([app] [--no-minify] [--no-sourcemap]).
 * Returns the build's exit code; non-zero means public/dist is untouched.
 */
function run(args = [], opts = {}) {
    const root = h.ROOT;
    const dist = path.join(root, DIST);
    const tmp = tempRoot(root);

    try {
        // Seed the current manifest so a single-app build merges into it.
        const current = path.join(dist, 'manifest.json');
        if (fs.existsSync(current)) {
            fs.mkdirSync(path.join(tmp, 'dist'), { recursive: true });
            fs.copyFileSync(current, path.join(tmp, 'dist', 'manifest.json'));
        }

        const code = build.run([...args, `--out=${tmp}`], opts);
        if (code !== 0) {
            console.log(`\n${C.yellow('nothing was published')} - public/dist is untouched, the app still serves the previous build`);
            return code;
        }

        const built = path.join(tmp, 'dist');
        const files = walk(built).filter((f) => f !== 'manifest.json');
        if (!fs.existsSync(path.join(built, 'manifest.json'))) {
            console.error(C.red('build reported success but wrote no manifest - nothing published'));
            return 1;
        }

        // 3. the chunks first, the manifest last.
        for (const rel of files) {
            const to = path.join(dist, rel);
            fs.mkdirSync(path.dirname(to), { recursive: true });
            fs.copyFileSync(path.join(built, rel), to);
        }
        const manifest = JSON.parse(fs.readFileSync(path.join(built, 'manifest.json'), 'utf8'));
        fs.mkdirSync(dist, { recursive: true });
        fs.writeFileSync(path.join(dist, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

        // 4. prune, by the build's own naming rule and nothing else.
        const referenced = new Set();
        for (const kind of ['scripts', 'styles', 'pages', 'pageStyles']) {
            for (const entry of Object.values(manifest[kind] || {})) {
                for (const part of entry.parts || []) {
                    for (const f of [part.file, part.map]) if (f) referenced.add(path.resolve(path.join(root, 'public') + f));
                }
            }
        }
        let pruned = 0;
        for (const rel of walk(dist)) {
            const abs = path.resolve(dist, rel);
            if (build.HASHED.test(path.basename(rel)) && !referenced.has(abs)) { fs.unlinkSync(abs); pruned++; }
        }

        console.log(`\n${C.green('published')}  ${files.length} file(s) into ${DIST}${pruned ? C.dim(`, ${pruned} superseded chunk(s) pruned`) : ''}`);
        return 0;
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
        // and the per-project parent, when this was the only build in it
        try { fs.rmdirSync(path.dirname(tmp)); } catch (e) { /* another build is using it */ }
    }
}

module.exports = { run };
