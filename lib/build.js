'use strict';
/*
 | THE BUILD, in one place, for two consumers: `vsa build` on a developer's
 | machine and `php artisan vsa:deploy` on a server, which reaches it through
 | the composer package vsd/asset-build and never has the CLI installed. The
 | template forks none of this - there is one builder.
 |
 | every bundle in config/script_bundles.php becomes minified chunks under
 | public/dist, plus a manifest listing each bundle's parts in page order.
 | Source files are only read, never modified. Minified, not obfuscated.
 |
 | Reliability rules:
 |   - esbuild does the minifying (JS and CSS). No PHP minifier, no fallback:
 |     a file esbuild cannot parse fails the WHOLE bundle, and a failed bundle
 |     is never written - the previous output stays in place.
 |   - top-level names are preserved (esbuild's transform API never renames
 |     top-level symbols in a plain script), so `window.PickupCenterComponent`
 |     survives exactly as the router expects.
 |   - target es2022: class fields stay native. Lowering them (es2017) made
 |     esbuild emit minified top-level helpers (`const C=class C`) that
 |     collided across files on the shared page scope. The app's chunks are
 |     parsed together before the manifest is written, so a clash fails the
 |     build instead of the page.
 |   - CSS url() references are rebased to absolute paths before concatenation,
 |     so fonts and images keep resolving from /dist/css.
 |   - CDN entries are NEVER downloaded or inlined: they are version-pinned,
 |     immutable and shared across every Vectorasoft app a browser has opened.
 |     A url ends the current chunk and is recorded in the manifest where it
 |     stands, so the shell renders it as its own tag, in order.
 |   - chunks are named by the hash of their own bytes (app-components.<sha>.js),
 |     so a file never changes under a name a browser cached: serve them
 |     `immutable, max-age=1y` and no version number needs bumping by hand.
 |   - each chunk carries a source-map INDEX MAP ({sections}) composed from the
 |     per-file maps esbuild returns - the spec's own answer to concatenation.
 |     --no-sourcemap turns it off.
 |   - every file's leading "use strict" is stripped: joined files share one
 |     prologue, so the first file would otherwise switch the WHOLE chunk to
 |     strict mode and break sloppy code after it. Strict-authored code runs
 |     unchanged in sloppy mode; the reverse is not true.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createRequire } = require('module');
const h = require('./host');
const { C } = require('./report');

/* A chunk this build named: <stem>.<10 hex>.js|css (+ .map). lib/swap.js prunes
   by the same rule, so it must stay the build's own naming, exported once. */
const HASHED = /\.[0-9a-f]{10}\.(js|css)(\.map)?$/;

const stripStrict = (code) => code.replace(/^((?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*\n)*)(["'])use strict\2;?/, '$1');

/*
 | ESBUILD COMES WITH THIS TOOL, PINNED BY ITS OWN LOCKFILE.
 |
 | It is a platform-native binary (darwin-arm64, linux-x64, ...), so it can only
 | be INSTALLED on the machine that runs it - never copied from a Mac to a
 | server, which is the failure that reads as a broken build rather than a wrong
 | binary. `npm install -g` on the box fetches the right one, once per host:
 |
 |   1. THIS PACKAGE'S OWN dependency - the normal case, whether the tool was
 |      installed globally on a server or pulled in as vsa-cli's dependency on a
 |      developer's machine. An app installs nothing. Resolved by plain require,
 |      from here, because npm HOISTS: a global install puts esbuild beside this
 |      package in lib/node_modules, not inside it, and only node's own walk up
 |      the ancestor node_modules finds it either way.
 |   2. the PROJECT's node_modules, for a project that still pins its own copy.
 */
function loadEsbuild() {
    const tried = [];
    const fromProject = () => {
        const anchor = path.join(h.ROOT, 'package.json');
        if (!fs.existsSync(anchor)) return null;
        return createRequire(anchor)('esbuild');
    };
    for (const attempt of [() => require('esbuild'), fromProject]) {
        try { const m = attempt(); if (m) return m; } catch (e) { tried.push(e.message); }
    }
    throw new Error(
        'esbuild is missing from this asset-build install, so nothing can be minified.\n'
        + '  Reinstall the builder on THIS machine (it is a platform-native binary,\n'
        + '  so it is never copied from another):\n'
        + '      npm install -g <the lib-asset-build repo or checkout>'
    );
}

function rebaseCssUrls(css, srcRel) {
    const dir = path.posix.dirname('/' + srcRel.replace(/^public\//, ''));
    return css.replace(/url\(\s*(['"]?)(?!data:|https?:|\/\/|\/|#)([^'")]+)\1\s*\)/g, (m, q, p) => `url(${q}${path.posix.normalize(path.posix.join(dir, p))}${q})`);
}

function run(args = [], opts = {}) {
    let app = null, check = false, minify = true, outRoot = null, sourcemap = true;
    for (const a of args) {
        if (a === '--check') check = true;
        else if (a === '--no-minify') minify = false;
        else if (a === '--no-sourcemap') sourcemap = false;
        else if (a.startsWith('--out=')) outRoot = a.slice(6);
        else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
        else app = a;
    }
    /*
     | --check is the CONSUMER's: the structural rules live in vsa-cli
     | (commands/check.js + checks/), which a server has no use for and this
     | package deliberately does not carry. A consumer that offers --check
     | passes its own runner in as `onCheck`.
     */
    if (check) {
        if (typeof opts.onCheck !== 'function') throw new Error('--check needs a checker: this package carries none (pass opts.onCheck)');
        const code = opts.onCheck();
        if (code !== 0) { console.error(C.red('\nbuild aborted: the structural checks reported errors')); return code; }
        console.log('');
    }
    const esbuild = minify ? loadEsbuild() : null;
    const apps = h.apps();
    // Only bundles an app file's shell renders: the shell is the one reader of
    // the manifest (App\Support\AssetBundles). Landing, login, report and
    // pdfmake bundles are rendered raw by their own views, so building them
    // would only commit dead weight (pdfmake alone is 3.5 MB).
    const used = { scripts: new Set(), styles: new Set() };
    for (const [key, af] of Object.entries(h.appFiles())) {
        if (app && key !== app) continue;
        const shell = (af.cfg && af.cfg.shell) || {};
        Object.keys(shell.scripts || {}).forEach((b) => used.scripts.add(b));
        Object.keys(shell.styles || {}).forEach((b) => used.styles.add(b));
    }
    const belongs = (kind, name) => used[kind].has(name);

    const manifest = { generated: new Date().toISOString(), minify, scripts: {}, styles: {}, pages: {}, pageStyles: {}, cdn: {} };

    const written_files = new Set();
    let failed = 0, written = 0;

    const transform = (code, loader, label) => {
        if (!esbuild) return { code, map: null };
        const r = esbuild.transformSync(code, {
            loader, minify: true, target: 'es2022', legalComments: 'none', logLevel: 'silent',
            // A source map per file, composed into one index map per chunk below.
            // sourcesContent is left out on purpose: every source is a real file
            // under public/, which the browser can fetch itself - embedding it
            // again would double the map for nothing.
            sourcemap: sourcemap, sourcesContent: false, sourcefile: label,
        });
        return { code: r.code, map: r.map || null };
    };

    /*
     | A bundle is an ORDERED list of local files and CDN urls, interleaved
     | (main-components: local, cdn, local...). `defer` scripts run and
     | stylesheets cascade in document order, so the build never reorders.
     |
     | CDN URLS ARE NOT INLINED. They are version-pinned and immutable, served
     | from the edge and already in the cache of anyone who has opened another
     | Vectorasoft app - copying them into this project's dist would trade a
     | shared, permanently cached asset for a private one that every project
     | re-downloads and that one component bump invalidates whole. It would
     | also put the published VSEL builds in a customer's public directory.
     |
     | So a url ends the current run and is recorded in the manifest where it
     | stands; the local files around it are joined into chunks. The shell
     | renders the parts back in this order, urls as their own tags.
     */
    const emit = (kind, name, bundle, entries, quiet = false) => {
        /* 'styles' is an app's joined bundles, 'pageStyles' one page's own
           stylesheet - both are CSS, and everything below that asks "is this
           CSS?" asks this, not the kind's name. */
        const css = kind === 'styles' || kind === 'pageStyles';
        const out = String(bundle.output_file || '').split('?')[0];
        if (!out) { console.log(`  ${C.dim('skip')}  ${name}  ${C.dim('no output_file')}`); return; }
        const errors = [], runs = [], seq = [];
        let run = null;
        for (const e of entries) {
            if (e.url) {
                // Straight through: recorded in place, never downloaded.
                manifest.cdn[e.url] = true;
                seq.push({ url: e.url });
                run = null;                       // the local files after it start a new chunk
                continue;
            }
            const label = e.rel.replace(/^public\//, '/');
            if (!h.exists(e.rel)) { errors.push(`${e.rel}: missing`); continue; }
            try {
                let code = css ? rebaseCssUrls(fs.readFileSync(h.abs(e.rel), 'utf8'), e.rel) : fs.readFileSync(h.abs(e.rel), 'utf8');
                let map = null;
                if (!e.noMinify) ({ code, map } = transform(code, css ? 'css' : 'js', label));
                if (!css) code = stripStrict(code);
                if (!run) { run = { parts: [], files: [] }; runs.push(run); seq.push({ run }); }
                run.parts.push({ label, code, map });
                run.files.push(label);
            } catch (err) {
                const msg = err.errors && err.errors[0] ? `${err.errors[0].text} (line ${err.errors[0].location && err.errors[0].location.line})` : err.message;
                errors.push(`${label}: ${msg}`);
            }
        }
        if (errors.length) {
            failed++;
            console.log(`  ${C.red('FAIL')}  ${name}  ${C.dim('not written')}`);
            errors.forEach((x) => console.log(`        ${C.red(x)}`));
            return;
        }
        const ext = path.posix.extname(out);
        const parts = [];
        let bytes = 0;
        const lines = (str) => { let n = 0; for (let i = 0; i < str.length; i++) if (str[i] === '\n') n++; return n; };

        seq.forEach((s) => {
            if (s.url) { parts.push({ url: s.url }); return; }

            /*
             | Join, counting lines as we go, so each file's own map can be
             | placed by offset. That is a source map INDEX MAP ({sections}) -
             | the form the spec defines for exactly this case, concatenated
             | output - so no mapping arithmetic is needed and a file's map is
             | used verbatim.
             */
            const sections = [];
            let body = '', line = 0;
            for (const part of s.run.parts) {
                if (body) { body += css ? '\n' : '\n;\n'; line += css ? 1 : 2; }
                body += `/* ${part.label.replace(/^\//, '')} */\n`; line += 1;
                if (part.map) sections.push({ offset: { line, column: 0 }, map: JSON.parse(part.map) });
                body += part.code; line += lines(part.code);
            }
            body += '\n';

            // @import only counts at the top of a stylesheet; one met mid-file is
            // silently ignored. Joining files puts most of them mid-file, so hoist
            // every @import (in order) and drop @charset (UTF-8 is the default).
            // This moves lines, so the stylesheet's map is dropped with it.
            if (css) {
                const imports = [];
                const hoisted = body.replace(/@charset\s*("[^"]*"|'[^']*')\s*;/g, '')
                    .replace(/@import\s*(?:url\([^)]*\)|"[^"]*"|'[^']*')[^;]*;/g, (m) => { imports.push(m); return ''; });
                if (imports.length) { body = imports.join('\n') + '\n' + hoisted; sections.length = 0; }
                else body = hoisted;
            }

            /*
             | The chunk is named by the hash of its own bytes, so a deployed
             | file never changes under a name a browser has cached: it can be
             | served `immutable, max-age=1y`, and nobody has to remember to
             | bump a version number in the app file.
             */
            const n = runs.indexOf(s.run) + 1;
            const stem = out.slice(0, -ext.length) + (runs.length > 1 ? '.' + n : '');
            const hash = crypto.createHash('sha256').update(body).digest('hex').slice(0, 10);
            const file = `${stem}.${hash}${ext}`;

            const write = (rel, content) => {
                const outRel = (outRoot ? outRoot.replace(/\/$/, '') : 'public') + rel;
                const outAbs = path.isAbsolute(outRel) ? outRel : h.abs(outRel);
                fs.mkdirSync(path.dirname(outAbs), { recursive: true });
                fs.writeFileSync(outAbs, content);
                written_files.add(path.resolve(outAbs));
            };

            if (sections.length) {
                write(`${file}.map`, JSON.stringify({ version: 3, sections }) + '\n');
                body += `${css ? '/*# sourceMappingURL=' : '//# sourceMappingURL='}${path.posix.basename(file)}.map${css ? ' */' : ''}\n`;
            }
            write(file, body);
            bytes += Buffer.byteLength(body);
            parts.push({ file, hash, files: s.run.files, map: sections.length ? `${file}.map` : null });
        });
        manifest[kind][name] = { attr: bundle.attr || '', built: manifest.generated, parts };
        written++;
        const fromCdn = entries.filter((e) => e.url).length;
        if (!quiet) console.log(`  ${C.green(' ok ')}  ${name.padEnd(18)} ${String(runs.length).padStart(2)} chunk(s)  ${C.dim((bytes / 1024).toFixed(1) + ' KB' + (fromCdn ? `  + ${fromCdn} from the CDN (not inlined)` : ''))}`);
        return bytes;
    };

    console.log(C.bold('scripts'));
    for (const [name, b] of Object.entries(h.bundles() || {})) {
        if (!belongs('scripts', name)) continue;
        // `files` only, in order - exactly what the raw (debug) shell renders.
        // A bundle's `no-minify` list is not rendered in raw mode either, so
        // building it would ship code production has never run.
        const entries = (b.files || []).map((f) => ({ ...h.bundleEntries({ files: [f] })[0], noMinify: b.minify === 0 }));
        emit('scripts', name, b, entries);
    }
    /*
     | Styles: ONE stylesheet per app - its shell's style bundles joined in the
     | order the shell lists them. Keyed by app, with the bundle list it was
     | built from; AssetBundles::appStyles() serves it only while the shell
     | still asks for exactly those bundles, and renders them raw otherwise.
     */
    console.log(C.bold('styles'));
    const styleBundles = h.styles() || {};
    for (const [appKey, af] of Object.entries(h.appFiles())) {
        if (app && appKey !== app) continue;
        const names = Object.keys((af.cfg && af.cfg.shell && af.cfg.shell.styles) || {});
        if (!names.length) continue;
        const missing = names.filter((n) => !styleBundles[n]);
        if (missing.length) { failed++; console.log(`  ${C.red('FAIL')}  ${appKey}  unknown style bundle(s): ${missing.join(', ')}`); continue; }
        const entries = names.flatMap((n) => (styleBundles[n].files || []).map((f) => {
            const u = String(f).split('?')[0];
            return h.isUrl(u) ? { url: u } : { rel: 'public/' + u.replace(/^\/+/, '') };
        }));
        emit('styles', appKey, { output_file: `/dist/css/${appKey}.css` }, entries);
        if (manifest.styles[appKey]) manifest.styles[appKey].bundles = names;
    }
    /*
     | Page scripts, ONE BUILT FILE PER PAGE.
     |
     | They are not bundles: the shell renders one <script> per declared page,
     | and with lazy_pages a single page is fetched on its own. So they cannot
     | be joined - but there was no reason to leave them unminified, and on a
     | large app they are the biggest part of the payload (edv-wis: 79 files,
     | more than every bundle together). Each becomes its own minified,
     | content-hashed file; Navigation::pageScripts() and lazyPages() read the
     | manifest in built mode and serve the raw path with ?v= otherwise.
     */
    console.log(C.bold('pages'));
    /*
     | SENSE first: regenerate config/{script,style}_bundles_pages.php from disk,
     | so a build can never ship a stale cluster.
     |
     | IT IS NOT BEST-EFFORT ANY MORE. It used to warn and carry on, building
     | from the committed copies of those two files - but they are build OUTPUT
     | now, gitignored like public/dist, and this command is the only thing that
     | produces them. Falling back to them would be falling back to files that
     | are not there: the build would succeed with no page clusters at all, and
     | ship a manifest that is silently missing every page's script. So a
     | failure here STOPS the build, before anything is published, and the app
     | keeps serving the build it was serving.
     */
    const sync = h.syncPages();
    if (!sync.ok) {
        console.log(`  ${C.red('FAIL')}  php artisan vsa:pages:sync did not run - the page clusters cannot be regenerated`);
        console.log(`        ${C.dim(String(sync.error || sync.output || '').split('\n')[0])}`);
        console.log('');
        console.log('  config/script_bundles_pages.php and config/style_bundles_pages.php are build');
        console.log('  output, and this is what writes them - so a build without it would ship a');
        console.log('  manifest with no page scripts in it at all.');
        console.log('');
        console.log('  The app has to be able to boot for this one step. Usually that is .env, the');
        console.log('  database it names, or vendor/ (composer install).');
        return 1;
    }
    const clusters = h.pageClusters();

    /*
     | A page's cluster is [ uses..., folder deps..., entry ]. The folder deps
     | and the entry are PRIVATE to the page, so they are concatenated into the
     | page's own chunk. A `uses` file (the shared-lazy pool, /js/dialogs/lazy/)
     | is shared by several pages, so it becomes its OWN content-hashed chunk,
     | built once and referenced from each page that uses it - never folded into
     | a page chunk, or the same top-level `var` would land in two chunks and
     | clash when an app's scripts are parsed together (and the bytes would ship
     | twice). loadScript() dedupes the shared chunk's URL at runtime.
     */
    const SHARED = (p) => /^\/js\/dialogs\/lazy\//.test(p);
    const sharedChunks = {};                 // repo path -> manifest parts, built once
    const buildShared = (p) => {
        if (p in sharedChunks) return sharedChunks[p];
        if (!h.exists('public' + p)) return (sharedChunks[p] = null);
        const key = `__shared__${p}`;
        emit('pages', key, { output_file: `/dist${p}` }, [{ rel: 'public' + p }], true);
        const parts = (manifest.pages[key] && manifest.pages[key].parts) || null;
        delete manifest.pages[key];          // not a page: referenced via the pages that use it
        return (sharedChunks[p] = parts);
    };

    for (const [appKey, af] of Object.entries(h.appFiles())) {
        if (app && appKey !== app) continue;
        /*
         | A page file the app's own script bundles already list ships inside
         | that bundle (older projects, e.g. dmsdev, load pages that way). Built
         | again on its own, the load-together check below sees every name twice.
         */
        const allBundles = h.bundles() || {};
        const inBundles = new Set(Object.keys((af.cfg && af.cfg.shell && af.cfg.shell.scripts) || {})
            .flatMap((b) => ((allBundles[b] && allBundles[b].files) || []))
            .filter((f) => !h.isUrl(String(f)))
            .map((f) => '/' + String(f).split('?')[0].replace(/^\/+/, '')));
        const appClusters = (clusters.scripts && clusters.scripts[appKey]) || {};
        let n = 0, kb = 0, bundled = 0;
        for (const [name, page] of Object.entries((af.cfg && af.cfg.pages) || {})) {
            const entryFile = '/' + String((page && page.file) || `/js/pages/${appKey}/${name}.js`).replace(/^\/+/, '');
            if (inBundles.has(entryFile)) { bundled++; continue; }

            // The sensed cluster, or just the entry when the page was not sensed.
            const cluster = appClusters[name] && appClusters[name].length ? appClusters[name] : [entryFile];
            const missing = cluster.filter((p) => !h.exists('public' + p));
            if (missing.length) { console.log(`  ${C.dim('skip')}  ${appKey}/${name}  ${C.dim(`${missing[0]} is missing`)}`); continue; }

            // Shared-lazy deps -> their own chunks (once); folder deps + entry ->
            // this page's chunk. `uses` come first, so prepend their parts.
            let sharedParts = [], ok = true;
            for (const s of cluster.filter(SHARED)) { const pr = buildShared(s); if (!pr) { ok = false; break; } sharedParts = sharedParts.concat(pr); }
            if (!ok) { console.log(`  ${C.dim('skip')}  ${appKey}/${name}  ${C.dim('a shared-lazy dep is missing')}`); continue; }

            const own = cluster.filter((p) => !SHARED(p));
            const bytes = emit('pages', `${appKey}/${name}`, { output_file: `/dist${entryFile}` }, own.map((p) => ({ rel: 'public' + p })), true);
            const built = manifest.pages[`${appKey}/${name}`];
            if (built && sharedParts.length) built.parts = sharedParts.concat(built.parts);
            if (bytes !== undefined) { n++; kb += bytes; }
        }
        if (n) console.log(`  ${C.green(' ok ')}  ${appKey.padEnd(18)} ${String(n).padStart(2)} page(s)  ${C.dim((kb / 1024).toFixed(1) + ' KB')}`);
        if (bundled) console.log(`  ${C.dim('skip')}  ${appKey.padEnd(18)} ${String(bundled).padStart(2)} page(s)  ${C.dim('already inside a script bundle')}`);
    }

    /*
     | Page stylesheets, ONE BUILT FILE PER PAGE, for the same reason as the
     | scripts: they are not a bundle. The shell renders one <link> per eager
     | page and a lazy page's stylesheet is fetched with the page, so they
     | cannot be joined - but a 40 KB screen stylesheet has every reason to be
     | minified and content-hashed. Navigation::pageStyles() and lazyPages()
     | read this in built mode and serve the raw path with ?v= otherwise.
     |
     | A page HAS a stylesheet when the file exists: /js/pages/<app>/<Name>.js
     | -> /css/pages/<app>/<Name>.css, or the page entry's own 'css'. Nothing
     | is declared, so nothing can go stale.
     */
    console.log(C.bold('page styles'));
    for (const [appKey, af] of Object.entries(h.appFiles())) {
        if (app && appKey !== app) continue;
        /*
         | A page stylesheet an app's own style bundles already list ships
         | inside that app's joined stylesheet (older projects load screen CSS
         | that way), so building it again would send the same rules twice.
         */
        const inStyles = new Set(Object.keys((af.cfg && af.cfg.shell && af.cfg.shell.styles) || {})
            .flatMap((b) => ((styleBundles[b] && styleBundles[b].files) || []))
            .filter((f) => !h.isUrl(String(f)))
            .map((f) => '/' + String(f).split('?')[0].replace(/^\/+/, '')));
        const appStyleClusters = (clusters.styles && clusters.styles[appKey]) || {};
        let n = 0, kb = 0, bundled = 0;
        for (const [name, page] of Object.entries((af.cfg && af.cfg.pages) || {})) {
            if (page && page.css === false) continue;

            // The page's whole style cluster (folder css + the conventional one);
            // fall back to the derived single file when the page was not sensed.
            // Stylesheets have no top-level clash, so the cluster is one chunk,
            // cascade order preserved.
            let cluster = appStyleClusters[name] && appStyleClusters[name].length ? appStyleClusters[name].slice() : [];
            if (!cluster.length) {
                const derived = page && typeof page.css === 'string' && page.css
                    ? '/' + page.css.replace(/^\/+/, '')
                    : '/' + String((page && page.file) || `/js/pages/${appKey}/${name}.js`)
                        .replace(/^\/+/, '').replace(/^js\//, 'css/').replace(/\.js$/, '.css');
                if (h.exists('public' + derived)) cluster = [derived];
            }
            cluster = cluster.filter((p) => h.exists('public' + p));
            if (!cluster.length) continue;                // no stylesheet: the normal case
            if (cluster.some((p) => inStyles.has(p))) { bundled++; continue; }
            const bytes = emit('pageStyles', `${appKey}/${name}`, { output_file: `/dist${cluster[0]}` }, cluster.map((p) => ({ rel: 'public' + p })), true);
            if (bytes !== undefined) { n++; kb += bytes; }
        }
        if (n) console.log(`  ${C.green(' ok ')}  ${appKey.padEnd(18)} ${String(n).padStart(2)} page(s)  ${C.dim((kb / 1024).toFixed(1) + ' KB')}`);
        if (bundled) console.log(`  ${C.dim('skip')}  ${appKey.padEnd(18)} ${String(bundled).padStart(2)} page(s)  ${C.dim('already inside a style bundle')}`);
    }

    /*
     | Every chunk of one app shares ONE global scope in the browser (classic
     | scripts), so a top-level `const`/`class` declared twice anywhere on the
     | page is a SyntaxError that stops the rest of that script. The minifier
     | can introduce such a name (a lowered class becomes `const C=class C`),
     | so parse each app's chunks together, in page order, before publishing
     | the manifest. A clash fails the build; the old manifest stays in place.
     */
    const outBase = (outRoot ? outRoot.replace(/\/$/, '') : 'public');
    const manifestRel = outBase + '/dist/manifest.json';
    const manifestAbs = path.isAbsolute(manifestRel) ? manifestRel : h.abs(manifestRel);

    /*
     | `vsa build <app>` rebuilds ONE app: its entries replace that app's in the
     | existing manifest and every other app's stay as they were - written alone,
     | the manifest would drop the other apps, and their shells would fall back
     | to raw or break. Each entry carries its own `built` time, so vsa doctor's
     | staleness check still judges the untouched apps by their own build.
     */
    let final = manifest;
    if (app) {
        let prev = null;
        try { prev = JSON.parse(fs.readFileSync(manifestAbs, 'utf8')); } catch (e) { /* none yet, or unreadable: start fresh */ }
        if (prev && typeof prev === 'object') {
            const keep = (o) => (o && typeof o === 'object' ? o : {});
            const styles = keep(prev.styles); delete styles[app];
            const mine = (o) => Object.fromEntries(Object.entries(keep(o)).filter(([k]) => !k.startsWith(`${app}/`)));
            const pages = mine(prev.pages);
            const pageStyles = mine(prev.pageStyles);
            final = { ...manifest, scripts: { ...keep(prev.scripts), ...manifest.scripts }, styles: { ...styles, ...manifest.styles }, pages: { ...pages, ...manifest.pages }, pageStyles: { ...pageStyles, ...manifest.pageStyles }, cdn: {} };
            for (const kind of ['scripts', 'styles', 'pages', 'pageStyles']) {
                for (const entry of Object.values(final[kind])) {
                    if (!entry.built) entry.built = prev.generated || null;
                    for (const part of entry.parts || []) if (part.url) final.cdn[part.url] = true;
                }
            }
        }
    }

    const vm = require('vm');
    for (const [appKey, af] of Object.entries(h.appFiles())) {
        if (app && appKey !== app) continue;
        const list = Object.keys((af.cfg && af.cfg.shell && af.cfg.shell.scripts) || {});
        /* Dedupe by file: a shared-lazy chunk is referenced from every page
           that uses it, so it appears in several pages' parts - but it is one
           file the browser loads once (loadScript memoises its URL), so parse
           it once here too, or its top-level names would clash with themselves. */
        const chunks = [...new Map(
            list.flatMap((b) => ((final.scripts[b] && final.scripts[b].parts) || []).filter((p) => p.file))
                .concat(Object.entries(final.pages)
                    .filter(([k]) => k.startsWith(`${appKey}/`))
                    .flatMap(([, v]) => (v.parts || []).filter((p) => p.file)))
                .map((p) => [p.file, p])
        ).values()];
        if (!chunks.length) continue;
        const src = chunks.map((p) => fs.readFileSync(path.isAbsolute(outBase) ? outBase + p.file : h.abs(outBase + p.file), 'utf8')).join('\n;\n');
        try { new vm.Script(src, { filename: `${appKey} page scripts` }); }
        catch (err) {
            failed++;
            console.log(`  ${C.red('FAIL')}  ${appKey}: built scripts do not load together - ${err.message}`);
        }
    }
    if (failed) {
        console.log(`\n${written} written, ${C.red(failed + ' failed')}   manifest NOT updated`);
        return 1;
    }

    fs.mkdirSync(path.dirname(manifestAbs), { recursive: true });
    fs.writeFileSync(manifestAbs, JSON.stringify(final, null, 2) + '\n');

    /*
     | Remove chunks the manifest no longer references - a previous hash, a
     | bundle with fewer runs, a renamed output_file. After `vsa build <app>`
     | the other apps' chunks are still referenced, so they stay.
     |
     | ONLY files that carry a content hash, which is this command's own naming
     | (<stem>.<10 hex>.js). public/dist is not this build's private directory:
     | edv-wis keeps login-styles.css and report-styles.css there, written by
     | bundles the shell never renders and loaded by their own views. Deleting
     | anything merely "not written this time" took those with it.
     |
     | Only after a clean build: a failed bundle keeps its previous output, and
     | that output must stay referenced.
     */
    const OURS = HASHED;
    const referenced = new Set(written_files);
    for (const kind of ['scripts', 'styles', 'pages', 'pageStyles']) {
        for (const entry of Object.values(final[kind] || {})) {
            for (const part of entry.parts || []) {
                for (const f of [part.file, part.map]) {
                    if (f) referenced.add(path.resolve(path.isAbsolute(outBase) ? outBase + f : h.abs(outBase + f)));
                }
            }
        }
    }
    // Depth-first: page scripts live in dist/js/pages/<app>/, one file each, so a
    // flat scan left every previous hash of all 79 of them behind - and in git.
    // Real directories only: a symlink under public/ points outside this build.
    const sweep = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const abs = path.resolve(dir, e.name);
            if (e.isDirectory()) { sweep(abs); continue; }
            if (!e.isFile()) continue;
            if (OURS.test(e.name) && !referenced.has(abs)) {
                fs.unlinkSync(abs);
                console.log(`  ${C.dim('pruned')} ${path.relative(h.abs('.'), abs)}`);
            }
        }
    };
    if (!failed) {
        for (const sub of ['js', 'css']) {
            const dir = path.join(path.dirname(manifestAbs), sub);
            if (fs.existsSync(dir)) sweep(dir);
        }
    }
    console.log(`\n${written} written, ${failed ? C.red(failed + ' failed') : '0 failed'}   manifest ${manifestRel}${minify ? '' : C.yellow('   (not minified)')}`);
    return failed ? 1 : 0;
}
module.exports = { run, HASHED };
