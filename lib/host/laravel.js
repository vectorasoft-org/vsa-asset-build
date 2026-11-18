'use strict';
/*
 | VSA Monolith host adapter. Everything `vsa` knows about the project layout
 | lives here, so a command never hard-codes a path and VSA Frontend can plug
 | in its own adapter with the same surface.
 |
 | Reads only: the adapter never writes. Commands that write (make:page,
 | build) do so through the paths it exposes.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const project = require('../context');
const { normCode } = require('../codes');
// The project folder (nearest vsa.json upwards, or VSA_ROOT). Outside a project it
// falls back to the current folder so commands load; bin/vsa.js refuses to run a
// project command there.
const ROOT = project.ROOT || process.cwd();
const CONFIG = project.config;
const P = {
    root: ROOT,
    bundles: 'config/script_bundles.php',
    styles: 'app/StyleManagement/StyleProvider.php',
    appsDir: 'config/apps',
    public: 'public',
    js: 'public/js',
    core: 'public/js/core',
    pages: 'public/js/pages',
    dialogs: 'public/js/dialogs',
    utils: 'public/js/utils',
    views: 'resources/views',
    pageViews: 'resources/views/pages',
    menus: 'resources/views/menus',
    layouts: 'resources/views/layouts',
    locales: 'app/Locales',
    dist: 'public/dist',
};

/*
 | Project-relative by default - almost every path in this CLI is - but an
 | ALREADY-ABSOLUTE path is returned untouched.
 |
 | path.join(ROOT, '/tmp/x') is '<project>/tmp/x', so `vsa xauth:export
 | --out=$TMPDIR/dms.manifest.json` reported "wrote /tmp/.../dms.manifest.json"
 | and wrote it inside the project instead, under a mirrored tmp/ tree nobody
 | looks in. The command looked like it worked and the file was never where the
 | user asked for it (found 2026-10-12; dmsdev/tmp/ had been collecting these
 | since 10-02).
 */
const abs = (rel) => (path.isAbsolute(rel) ? rel : path.join(ROOT, rel));
const exists = (rel) => fs.existsSync(abs(rel));

/*
 | Does core.hooksPath point at the project's .githooks? Git resolves a relative
 | value from the work-tree root and expands a leading ~, so `.githooks`,
 | `./.githooks/` and the absolute path are all the same folder - comparing the
 | text alone failed clones that were set up by hand.
 */
function hooksActive(value) {
    if (!value) return false;
    const got = path.resolve(ROOT, value.replace(/^~(?=$|[\\/])/, os.homedir()));
    const real = (p) => { try { return fs.realpathSync(p); } catch (e) { return path.resolve(p); } };
    const norm = (p) => (process.platform === 'win32' ? real(p).toLowerCase() : real(p));
    return norm(got) === norm(abs('.githooks'));
}

const fileCache = new Map();
/**
 * A file a rule was pointed at may not exist - a bundle entry left behind by a
 * rename is the common case, and bundle-paths REPORTS it. It must not also
 * crash the run: `check` is a pre-commit gate, and aborting halfway hides every
 * rule after the failure. Unreadable reads as empty, so the condition is
 * reported once and the remaining checks still run.
 */
function read(rel) {
    if (!fileCache.has(rel)) {
        try {
            fileCache.set(rel, fs.readFileSync(abs(rel), 'utf8'));
        } catch (e) {
            fileCache.set(rel, '');
        }
    }
    return fileCache.get(rel);
}

function php(code, args = []) {
    return execFileSync('php', ['-r', code, ...args], { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
}

let trackedSet = null;
/** Every path git tracks, exact case. */
function tracked() {
    if (!trackedSet) {
        const out = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
        trackedSet = new Set(out.split('\0').filter(Boolean));
    }
    return trackedSet;
}

/** Walk a directory; returns repo-relative paths with forward slashes. */
function walk(rel, filter = () => true, out = []) {
    const dir = abs(rel);
    if (!fs.existsSync(dir)) return out;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const r = rel + '/' + ent.name;
        if (ent.isDirectory()) walk(r, filter, out);
        else if (filter(r)) out.push(r);
    }
    return out.sort();
}

// ---- bundles -------------------------------------------------------------

const bundleCache = new Map();
/** The one official bundle list (config/script_bundles.php). */
function bundles() {
    if (bundleCache.has('')) return bundleCache.get('');
    let result = null;
    if (exists(P.bundles)) {
        // Plain data; env() is stubbed so a stray call cannot boot anything.
        const json = php('function env($k,$d=null){return $d;} echo json_encode(require $argv[1]);', [abs(P.bundles)]);
        result = JSON.parse(json);
    }
    // Pages are not listed in script_bundles: the shell loads every page an app
    // file declares after its bundles (Navigation::pageScripts). Expose them as
    // one synthetic bundle per app so every check sees what the browser loads.
    if (result) {
        for (const [app, af] of Object.entries(appFiles())) {
            if (!af.cfg || !af.cfg.shell) continue;
            result[pageBundleName(app)] = {
                attr: 'defer', synthetic: true,
                files: Object.entries(af.cfg.pages || {}).map(([name, page]) => (page && page.file) || `/js/pages/${app}/${name}.js`),
            };
        }
    }
    bundleCache.set('', result);
    return result;
}

/*
 | The per-page clusters `vsa:pages:sync` senses from disk:
 |   { scripts: { app: { Name: [paths] } }, styles: { app: { Name: [paths] } } }
 | Read the same way as the bundle list - plain data via `php -r require`, env()
 | stubbed so a stray call cannot boot anything. Empty when a file is absent
 | (the project has not run the sync yet); the build then falls back to each
 | page's entry alone, so a missing sync costs the deps' grouping, never a page.
 */
const clusterCache = new Map();
function pageClusters() {
    if (clusterCache.has('')) return clusterCache.get('');
    const readMap = (rel) => {
        if (!exists(rel)) return {};
        try { return JSON.parse(php('function env($k,$d=null){return $d;} echo json_encode(require $argv[1]);', [abs(rel)])) || {}; }
        catch (e) { return {}; }
    };
    const result = { scripts: readMap('config/script_bundles_pages.php'), styles: readMap('config/style_bundles_pages.php') };
    clusterCache.set('', result);
    return result;
}

/*
 | Regenerate the cluster configs from disk (SENSE), or with check=true just
 | report drift (exit 1). This is the ONE sensing implementation - it boots the
 | app (artisan), so it is best-effort for the caller: a machine that cannot
 | boot (no .env) gets {ok:false} and builds from the committed files instead.
 | status is the artisan exit code: 1 from --check means the committed files are
 | stale, anything else means it could not run.
 */
function syncPages(check = false) {
    const args = ['artisan', 'vsa:pages:sync'];
    if (check) args.push('--check');
    try {
        const output = execFileSync('php', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
        return { ok: true, status: 0, output };
    } catch (e) {
        return { ok: false, status: typeof e.status === 'number' ? e.status : null, output: (e.stdout || '') + (e.stderr || ''), error: e.message };
    }
}

const styleCache = new Map();
function styles() {
    if (styleCache.has('')) return styleCache.get('');
    let result = null;
    if (exists(P.styles)) {
        const json = php('require $argv[1]; echo json_encode(\\App\\StyleManagement\\StyleProvider::getBundles());', [abs(P.styles)]);
        result = JSON.parse(json);
    }
    styleCache.set('', result);
    return result;
}

/** Name of the synthetic bundle holding an app file's pages. */
const pageBundleName = (app) => `pages:${app}`;

const isUrl = (f) => /^https?:\/\//i.test(f);

/** CDN url -> local file map. Always empty here: VSEL loads from the CDN. */
let localSourceMap = null;
function localSources() {
    if (!localSourceMap) localSourceMap = {};
    return localSourceMap;
}
/** Entries of one bundle: [{entry, url, rel, project}] where rel is repo-relative for local files. */
function bundleEntries(bundle) {
    const list = [].concat(bundle.files || [], bundle['no-minify'] || []);
    return list.map((entry) => {
        const bare = String(entry).split('?')[0];
        if (isUrl(bare)) return { entry, url: bare, rel: null, project: false };
        const rel = 'public/' + bare.replace(/^\/+/, '');
        return { entry, url: null, rel, project: bare.startsWith('/js/') };
    });
}

// ---- apps, pages, blades ---------------------------------------------------

function apps() {
    return walk(P.core, (r) => r.endsWith('/VSApp.config.js'))
        .map((r) => path.basename(path.dirname(r)))
        .filter((a) => a !== 'core');
}

/** Page components: one per public/js/pages/<app>/*.js. `app` may be a shared dir (common, geo). */
function pages(app = null) {
    return walk(P.pages, (r) => r.endsWith('.js'))
        .filter((r) => !app || r.startsWith(P.pages + '/' + app + '/'))
        .map((r) => {
            const name = path.basename(r, '.js');
            const dir = path.basename(path.dirname(r));
            const lc = name.charAt(0).toLowerCase() + name.slice(1);
            const blade = `${P.pageViews}/${dir}/${lc}.blade.php`;
            /* The page's own stylesheet, by the same derivation the framework
               uses (/js/ -> /css/, .js -> .css). Null unless the file is there:
               a page HAS one by having the file, and most pages do not. An app
               file's 'css' override is not read here - this walks public/js, it
               has no app file - so a page that names a path of its own is
               checked only if it also keeps the conventional name. */
            const css = r.replace(new RegExp('^' + P.js + '/'), 'public/css/').replace(/\.js$/, '.css');
            // The root id the page actually queries wins over the naming
            // convention. Legacy pages hold it in `const self`; a few build the
            // selector at runtime ('#' + containerId) - those are `dynamicRoot`.
            //
            // The id is whatever the page asked for: `_main_` is this template's
            // convention, not a rule other apps followed (DMS settings pages use
            // `_sttn_`). Reading only `_main_` ids made every other prefix look
            // like a page whose root is missing from its blade.
            const src = read(r);
            const Q = "(?:outlet|VSAppContent|document)\\s*\\.\\s*querySelector\\(\\s*['\"]#([A-Za-z_][\\w-]*)['\"]";
            // Anchored on the assignment first, so a page that queries something
            // else before its root still reports the root.
            const m = new RegExp(`(?:page\\.root|\\bself|\\broot|\\bmThis)\\s*=\\s*${Q}`).exec(src)
                   || new RegExp(Q).exec(src);
            const dynamicRoot = !m && /(?:outlet|VSAppContent)\s*\.\s*querySelector\(\s*['"]#['"]\s*\+/.test(src);
            return { app: dir, name, file: r, blade: exists(blade) ? blade : null, css: exists(css) ? css : null, rootId: m ? m[1] : `_main_${lc}`, conventionalRootId: `_main_${lc}`, dynamicRoot };
        });
}

function dialogs() { return walk(P.dialogs, (r) => r.endsWith('.js')); }
function utils() { return walk(P.utils, (r) => r.endsWith('.js')); }
function coreFiles() { return walk(P.core, (r) => r.endsWith('.js')); }
function projectJs() { return walk(P.js, (r) => r.endsWith('.js')); }

function blades() {
    return walk(P.views, (r) => r.endsWith('.blade.php'));
}

/** Inline <script> bodies and local <script src> files of a blade (JSON blocks skipped). */
function bladeScripts(rel) {
    const src = read(rel);
    const inline = [], srcs = [];
    const TAG = /<script\b([^>]*)>([\s\S]*?)<\/script>/g; let m;
    while ((m = TAG.exec(src))) {
        const attrs = m[1];
        if (/type\s*=\s*["']?(application\/(ld\+)?json|text\/template|text\/x-)/i.test(attrs)) continue;
        const sm = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(attrs);
        if (sm) {
            const raw = sm[1] ?? sm[2];
            const am = /asset\(\s*['"]([^'"]+)['"]\s*\)/.exec(raw);
            const path = am ? am[1] : raw;
            if (!isUrl(path) && !/[{$]/.test(path)) srcs.push('public/' + path.replace(/^\/+/, '').split('?')[0]);
            else if (isUrl(path)) srcs.push(path);
        } else if (m[2].trim()) inline.push({ file: rel, line: lineOf(src, m.index), code: m[2] });
    }
    return { inline, srcs };
}

/**
 * The shell blade of each app: the bundles / style bundles it renders, its
 * inline scripts and <script src> files, and the chrome blades (menus,
 * layouts/<app>) whose inline scripts run in the same document.
 */
function shells() {
    const RENDER = /(ScriptManager|StyleManager)::render\(\s*['"]([^'"]+)['"]/g;
    return apps().map((app) => {
        const af = appFiles()[app];
        const cfg = af && af.cfg ? af.cfg : null;
        // Since Phase 6 the document is resources/views/shell.blade.php and the
        // bundles are the app file's shell.scripts / shell.styles. Older trees
        // (and other projects) keep one <app>.blade.php with literal render calls.
        const shared = `${P.views}/shell.blade.php`;
        const legacy = `${P.views}/${app}.blade.php`;
        const rel = cfg && cfg.shell && exists(shared) ? shared : legacy;
        const shell = { app, file: rel, scripts: [], styles: [], inline: [], srcs: [] };
        if (cfg && cfg.shell && rel === shared) {
            shell.scripts = [...Object.keys(cfg.shell.scripts || {}), pageBundleName(app)];
            shell.styles = Object.keys(cfg.shell.styles || {});
        } else if (exists(rel)) {
            let m; const src = read(rel);
            while ((m = RENDER.exec(src))) (m[1] === 'ScriptManager' ? shell.scripts : shell.styles).push(m[2]);
        }
        const layout = (cfg && cfg.layout) || null;
        const chrome = [
            ...(exists(rel) ? [rel] : []),
            ...walk(`${P.menus}`, (f) => f.endsWith(`${app}_menu.blade.php`)),
            ...walk(`${P.layouts}/${app}`, (f) => f.endsWith('.blade.php')),
            ...(layout ? walk(`${P.layouts}/${layout}`, (f) => f.endsWith('.blade.php')) : []),
        ];
        for (const b of chrome) { const sc = bladeScripts(b); shell.inline.push(...sc.inline); shell.srcs.push(...sc.srcs); }
        return shell;
    });
}

/**
 * Scripts fetched at runtime rather than through a bundle: public/js/*.js at
 * the root, and any '/<Name>.js' URL the core names (the router fetches
 * AuthManager from `auth_script_url`, for instance). Returns repo-relative
 * paths for local files and bare global names for remote ones.
 */
function runtimeLoaded() {
    const files = walk(P.js, (r) => r.endsWith('.js') && r.split('/').length === 3);
    const names = new Set();
    for (const rel of coreFiles()) {
        const RE = /['"`]([^'"`\s]+\/([A-Z][\w]*)(?:\.v\d+)?\.js)['"`]/g; let m;
        while ((m = RE.exec(read(rel)))) {
            if (isUrl(m[1])) names.add(m[2]);
            else { const local = 'public/' + m[1].replace(/^\/+/, ''); if (exists(local)) files.push(local); else names.add(m[2]); }
        }
    }
    return { files, names: [...names] };
}

/** Every render() call in every blade: [{file, line, kind, name}] */
function renderCalls() {
    const RENDER = /(ScriptManager|StyleManager)::render\(\s*['"]([^'"]+)['"]/g;
    const out = [];
    for (const rel of blades()) {
        const src = read(rel); let m;
        while ((m = RENDER.exec(src))) out.push({ file: rel, line: lineOf(src, m.index), kind: m[1], name: m[2] });
    }
    return out;
}

function lineOf(src, index) { let l = 1; for (let i = 0; i < index; i++) if (src[i] === '\n') l++; return l; }

/**
 * Navigation targets today: vs_menu_item('app/Name', modId, ...) and
 * mac_menu_item('Name', ...) in the menu blades, plus alternative_route in the
 * app configs. Phase 5 replaces the menu blades with config/apps/<app>.php;
 * this reader gains a branch for that then.
 * @returns {Map<string, Array<{file,line,modId}>>}
 */
/**
 * config/apps/<app>.php as data: { app: { file, cfg, error } }. One php call
 * for every file; a file that is not plain data comes back with `error`.
 */
let appFilesCache = null;
function appFiles() {
    if (appFilesCache) return appFilesCache;
    appFilesCache = {};
    const files = walk(P.appsDir, (r) => r.endsWith('.php'));
    if (!files.length) return appFilesCache;
    const code = 'function env($k,$d=null){return $d;} $o=[]; foreach (array_slice($argv,1) as $f) { try { $v = require $f; $o[$f] = is_array($v) ? ["cfg"=>$v] : ["error"=>"does not return an array"]; } catch (Throwable $e) { $o[$f] = ["error"=>$e->getMessage()]; } } echo json_encode($o);';
    let out = {};
    try { out = JSON.parse(php(code, files.map(abs))); }
    catch (e) { for (const rel of files) out[abs(rel)] = { error: e.message.split('\n')[0] }; }
    for (const rel of files) {
        const app = path.basename(rel, '.php');
        appFilesCache[app] = { file: rel, ...(out[abs(rel)] || { error: 'unreadable' }) };
    }
    return appFilesCache;
}

/*
 | What `check app-file` reads that differs per edition: how a key is found in
 | an app file, where the shell's chrome and views live, the page markup file,
 | the locales and the permission codes the server code names.
 */
/** Locale files: app/Locales/<lang>.php. */
const localeExt = '.php';
/**
 * Server-side translation calls, for i18n:missing: the files, the call (a
 * regex source ending at the open paren), a plain needle to skip files fast,
 * and what follows the paren when the key is a variable.
 */
const serverTranslation = {
    files: () => walk('app', (r) => r.endsWith('.php') && !r.startsWith(P.locales + '/')),
    call: String.raw`Localization::trans\(`,
    needle: 'Localization::trans(',
    variableArg: String.raw`\s*\$`,
};
/** Translation keys a package-owned layout carries: none here, the layout blades are the app's and are scanned. */
function chromeKeys() { return []; }
/** What a page's markup file is called in this edition (the JSON key stays `blade`). */
const markupWord = 'blade';
/** How app-file reports an app file it could not read. */
const appFileRefusal = 'not plain data';
const appFileExt = '.php';
/** The line of 'name' in an app file (0 when absent), searching from `from`. */
function appKeyLine(src, name, from = 0) { const i = src.indexOf(`'${name}'`, from); return i === -1 ? 0 : lineOf(src, i); }
/** Where the top-level key starts in an app file (-1 when absent). */
function appKeyAt(src, name) { return src.indexOf(`'${name}'`); }
/** Why an app file is not plain data vsa can read without Laravel, or null. */
function appFileImpurity(src) {
    return /\benv\s*\(|\bfunction\s*\(|\bfn\s*\(/.test(src.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, ''))
        ? 'uses env(), a closure or fn() - app files must be plain data so vsa can read them without Laravel' : null;
}
/** The layout and toolbar an app file names, each one a blade the app owns: [{ name, msg }]. */
function layoutProblems(cfg) {
    const out = [];
    const layout = cfg.layout || 'console';
    if (!exists(`${P.layouts}/${layout}/frame.blade.php`)) out.push({ name: null, msg: `layout '${layout}' has no ${P.layouts}/${layout}/frame.blade.php` });
    for (const item of cfg.toolbar || []) if (!exists(`${P.layouts}/${layout}/toolbar/${item}.blade.php`)) out.push({ name: item, msg: `toolbar item '${item}' has no ${P.layouts}/${layout}/toolbar/${item}.blade.php` });
    return out;
}
/** A view named in an app file ('auth.login' -> resources/views/auth/login.blade.php). */
function viewFile(name) { return `${P.views}/${String(name).replace(/\./g, '/')}.blade.php`; }
/**
 * The markup file the shell includes for a page ('blade' => 'pages.common.x'
 * names the view, one blade may hold several pages' markup - same rule as
 * Navigation::pageViews()), with the error for when it is missing.
 */
function pageMarkup(app, name, page, file) {
    const named = typeof page.blade === 'string';
    const rel = named
        ? `${P.views}/${page.blade.replace(/\./g, '/')}.blade.php`
        : `${P.pageViews}/${file.split('/').slice(-2, -1)[0]}/${name.charAt(0).toLowerCase() + name.slice(1)}.blade.php`;
    return {
        rel,
        missing: named
            ? `${name}: 'blade' => '${page.blade}' names ${rel}, which does not exist`
            : `${name}: the shell includes ${rel}, which does not exist (declare 'blade' => false for a page that builds its root at runtime)`,
    };
}
/** Every locale file as data, keyed by absolute path. Throws when they cannot be read. */
function localeData() {
    const files = walk(P.locales, (f) => f.endsWith('.php'));
    return JSON.parse(php('$o=[]; foreach (array_slice($argv,1) as $f) $o[$f] = require $f; echo json_encode($o);', files.map(abs)));
}
/**
 * Permission codes written as literals in the controllers:
 * [{ file, line, code, constName }] (constName set for `const X = 'A.B'`).
 */
function permissionLiterals() {
    const out = [];
    for (const c of walk('app/Http/Controllers', (f) => f.endsWith('.php'))) {
        const src = read(c);
        for (const m of src.matchAll(/(?:verifyAuth|allowed)\(\s*(?:\$\w+\s*,\s*)?'([A-Za-z][A-Za-z0-9_]*\.[A-Za-z][A-Za-z0-9_.-]*)'/g)) out.push({ file: c, line: lineOf(src, m.index), code: m[1], constName: null });
        for (const m of src.matchAll(/const\s+(VIEW|CREATE|UPDATE|DELETE|[A-Z_]+)\s*=\s*'([A-Za-z][A-Za-z0-9_]*\.[A-Za-z][A-Za-z0-9_.-]*)'/g)) out.push({ file: c, line: lineOf(src, m.index), code: m[2], constName: m[1] });
    }
    return out;
}
/** Where `vsa cache:bust` keeps the asset epoch, and the pattern of its line (group 1 = the value). */
const EPOCH = { rel: 'config/vsa.php', line: /'asset_epoch'\s*=>\s*'([^']*)'/ };

/** Page names placed in an app file's navigation, in order: [{name, layout, group}] */
function appNavItems(cfg) {
    const out = [];
    const walkSpec = (spec, layout, group) => {
        for (const [key, value] of Object.entries(spec || {})) {
            if (typeof value === 'string') { if (value !== '*') out.push({ name: value, layout, group }); }
            else if (Array.isArray(value) || (value && typeof value === 'object')) {
                if (value.items) walkSpec(value.items, layout, value.title || group);
                else walkSpec(value, layout, /^\d+$/.test(key) ? group : key);
            }
        }
    };
    for (const [layout, spec] of Object.entries((cfg && cfg.navigation) || {})) if (spec) walkSpec(spec, layout, null);
    return out;
}

function navTargets() {
    const out = new Map();
    const add = (name, ref) => { if (!out.has(name)) out.set(name, []); out.get(name).push(ref); };
    // Remaining hand-written menus (acc/gmt placeholders)
    const ITEM = /\b(?:vs|mac)_menu_item\(\s*['"]([^'"]+)['"]\s*(?:,\s*(\d+))?/g;
    for (const rel of walk(P.menus, (r) => r.endsWith('.blade.php'))) {
        const src = read(rel); let m;
        while ((m = ITEM.exec(src))) {
            const name = m[1].split('?')[0].split('/').filter(Boolean).pop();
            add(name, { file: rel, line: lineOf(src, m.index), modId: m[2] ? Number(m[2]) : null, kind: 'menu' });
        }
    }
    const ALT = /alternative_route\s*:\s*\[([^\]]*)\]/g;
    for (const rel of coreFiles()) {
        const src = read(rel); let m;
        while ((m = ALT.exec(src))) {
            for (const n of m[1].match(/[A-Za-z_]\w*/g) || []) add(n, { file: rel, line: lineOf(src, m.index), modId: null, kind: 'alternative' });
        }
    }
    // config/apps/<app>.php: navigation items first, then pages declared but not placed
    for (const [app, af] of Object.entries(appFiles())) {
        if (!af.cfg) continue;
        const src = read(af.file);
        const pages = af.cfg.pages || {};
        const placed = new Set();
        for (const it of appNavItems(af.cfg)) {
            placed.add(it.name);
            const at = src.indexOf(`'${it.name}'`, src.indexOf("'navigation'"));
            add(it.name, { file: af.file, line: at === -1 ? 0 : lineOf(src, at), modId: pages[it.name] ? (pages[it.name].module ?? null) : null, kind: 'nav', app, group: it.group });
        }
        for (const [name, page] of Object.entries(pages)) {
            if (placed.has(name)) continue;
            const at = src.indexOf(`'${name}'`);
            add(name, { file: af.file, line: at === -1 ? 0 : lineOf(src, at), modId: page ? (page.module ?? null) : null, kind: 'page', app });
        }
    }
    return out;
}

/** Does a navigation reference belong to this app? (acc/gmt menus are dms layouts; common/geo pages belong to every app.) */
function navRefForApp(ref, app) {
    if (!apps().includes(app)) return true;
    const f = ref.file;
    if (f.includes(`/core/${app}/`) || f.endsWith(`/${app}_menu.blade.php`) || f === `${P.appsDir}/${app}.php`) return true;
    if (app === 'dms' && /\/(acc|gmt)_menu\.blade\.php$/.test(f)) return true;
    return false;
}

// Globals each CDN file defines, recorded by `vsa check --update-globals`. Ships with
// the CLI (VSEL is the same for every project).

/**
 | Every server-side permission check and the routes that reach it:
 | AuthGate::verifyAuth($req, <action id>) in app/Http/Controllers, routes from
 | routes/*.php. Returns { server: [{controller, method, action, routes, at}], serverIds }.
 */
function serverPermissionChecks() {
    const routes = new Map();    // "Controller@method" -> [uri]
    for (const rel of walk('routes', (r) => r.endsWith('.php'))) {
        const src = read(rel);
        for (const m of src.matchAll(/Route::(get|post|put|patch|delete|any)\(\s*['"]([^'"]*)['"]\s*,\s*\[\s*([A-Za-z\\]+)::class\s*,\s*['"](\w+)['"]/g)) {
            const before = src.slice(0, m.index);
            const pm = [...before.matchAll(/prefix\(\s*['"]([^'"]+)['"]\s*\)/g)].pop();
            const open = pm ? before.lastIndexOf('group(') > before.lastIndexOf('});') : false;
            const uri = `/${rel.includes('api') ? 'api/' : ''}${open && pm ? pm[1].replace(/^\/|\/$/g, '') + '/' : ''}${m[2].replace(/^\//, '')}`;
            const key = `${m[3].split('\\').pop()}@${m[4]}`;
            if (!routes.has(key)) routes.set(key, []);
            routes.get(key).push(uri);
        }
    }
    const server = [];
    const serverIds = new Set();
    for (const rel of walk('app/Http/Controllers', (r) => r.endsWith('.php'))) {
        const src = read(rel);
        const cls = rel.split('/').pop().replace(/\.php$/, '');
        const methods = [...src.matchAll(/function\s+(\w+)\s*\(/g)].map((m) => ({ name: m[1], at: m.index }));
        // The constant's value: a number, or a quoted code normalised like the page side.
        const constValue = (name) => { const c = src.match(new RegExp(`const\\s+${name}\\s*=\\s*(-?\\d+|'[^']*')`)); return c ? c[1] : null; };
        for (const m of src.matchAll(/verifyAuth\(\s*\$\w+\s*,\s*([^;]*?)\)\s*;/g)) {
            const method = methods.filter((x) => x.at < m.index).pop();
            const arg = m[1].trim();
            const simple = /^(-?\d+|'[A-Za-z][A-Za-z0-9_.]*'|self::\w+|\$\w+)$/.test(arg);
            // `$id ? self::UPDATE : self::CREATE` and friends: every constant / literal named in the expression
            let id = simple ? arg : [...arg.matchAll(/self::(\w+)|'([A-Za-z][A-Za-z0-9_.]*)'|(?<![\w.])(-?\d+)/g)].map((t) => t[1] ? (constValue(t[1]) || `self::${t[1]}`) : t[2] ? `'${t[2]}'` : t[3]).map((v) => (/^'.*'$/.test(v) ? normCode(v.slice(1, -1)) : v)).join('|');
            if (!simple) { for (const v of id.split('|')) { if (/^-?\d+$/.test(v) && Number(v) > 0) serverIds.add(Number(v)); else if (/\./.test(v)) serverIds.add(v); } }
            if (/^self::/.test(id)) { id = constValue(id.slice(6)) || id; }
            if (/^'.*'$/.test(id)) { id = normCode(id.slice(1, -1)); serverIds.add(id); }
            if (/^\$\w+$/.test(id)) {
                // `$prn_code = $req->id ? 257 : 256;` just above: the create/update pair
                const body = src.slice(method ? method.at : 0, m.index);
                const a = [...body.matchAll(new RegExp(`\\${id}\\s*=\\s*([^;]+);`, 'g'))].pop();
                const nums = a ? (a[1].match(/-?\d+/g) || []).map(Number) : [];
                if (nums.length) { nums.filter((n) => n > 0).forEach((n) => serverIds.add(n)); id = nums.join('|'); }
            }
            if (/^-?\d+$/.test(id)) { id = Number(id); if (id > 0) serverIds.add(id); }
            server.push({ controller: cls, method: method ? method.name : '?', action: id, routes: routes.get(`${cls}@${method ? method.name : ''}`) || [], at: `${rel}:${lineOf(src, m.index)}` });
        }
    }

    return { server, serverIds };
}

const KNOWN_GLOBALS = path.join(project.CLI_DIR, 'known-globals.json');
function knownGlobals() {
    try { return JSON.parse(fs.readFileSync(KNOWN_GLOBALS, 'utf8')); } catch (e) { return {}; }
}

// ------------------------------------------------------------------ environment
// What a working checkout needs: the CLI defaults plus the project's vsa.json "env"
// (lib/project.js). doctor and setup read these.
const ENV = CONFIG.env;

/* Parses .env as data. Values are returned for the caller to TEST, never to
   print: doctor reports "set" / "empty", nothing more. */
function readEnv(rel = ENV.file) {
    if (!exists(rel)) return null;
    const out = {};
    // Uncached on purpose: setup writes .env (APP_KEY) and doctor reads it next.
    for (const line of fs.readFileSync(abs(rel), 'utf8').split(/\r?\n/)) {
        const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
        if (!m) continue;
        let v = m[2].trim();
        if (/^"/.test(v)) v = v.replace(/^"((?:[^"\\]|\\.)*)".*$/, '$1');
        else if (/^'/.test(v)) v = v.replace(/^'([^']*)'.*$/, '$1');
        else v = v.replace(/\s+#.*$/, '');
        out[m[1]] = v;
    }
    return out;
}

/* How config/apps/<app>.php names a page's XAuth module (vsa.json "modules"):
   kind 'id' = numeric module ids, 'code' = ref codes; null opens a page to every
   signed-in user; false = declared but not routable. */
const MODULES = CONFIG.modules;

/** Forget every cached read (a command that writes config files, then reads them again). */
function resetCache() {
    fileCache.clear(); bundleCache.clear(); styleCache.clear(); clusterCache.clear();
    appFilesCache = null; trackedSet = null; localSourceMap = null;
}

module.exports = {
    stack: 'laravel', serverPermissionChecks,
    CONFIG, ENV, readEnv, MODULES, pageBundleName, resetCache, KNOWN_GLOBALS,
    ROOT, P, abs, exists, hooksActive, read, php, tracked, walk, bundles, styles, pageClusters, syncPages, bundleEntries, isUrl, localSources,
    apps, pages, dialogs, utils, coreFiles, projectJs, blades, shells, bladeScripts, runtimeLoaded, renderCalls, navTargets, appFiles, appNavItems,
    knownGlobals, navRefForApp, lineOf,
    chromeKeys, localeExt, serverTranslation, markupWord, appFileExt, appFileRefusal, appKeyLine, appKeyAt, appFileImpurity, layoutProblems, viewFile, pageMarkup, localeData, permissionLiterals, EPOCH,
};
