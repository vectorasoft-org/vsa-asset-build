'use strict';
/*
 | The host adapter for the Node edition (vsa.json "stack": "node";
 | VSA-CLI-NODE-STACK.md §3, with the formats decided since: YAML app and
 | bundle files, page markup as HTML partials beside each page script).
 |
 | Same surface as laravel.js. Members that do not depend on the edition (the
 | browser half: public/js, VSApp, dialogs) are laravel.js's own; the members
 | below are the ones that differ.
 |
 | The project is asked about itself, never guessed: app files and bundles are
 | read by the project's own @vsd/vsa-node (loadAppFiles, loadBundles), as the
 | Laravel adapter asks PHP through `php -r`. A config the app would refuse at
 | boot is refused here with the same message.
 */
const path = require('path');
const { createRequire } = require('module');
const base = require('./laravel');
const { normCode } = require('../codes');

const { ROOT, abs, walk, read, exists, lineOf, apps, coreFiles, pageBundleName } = base;

const P = {
    ...base.P,
    bundles: 'config/bundles.yaml',
    styles: 'config/bundles.yaml',
    appsDir: 'config/apps',
    vsaConfig: 'config/vsa.yaml',
    views: 'views',
    pageViews: 'public/js/pages',
    menus: 'views/menus',
    layouts: 'views/layouts',
    locales: 'locales',
    server: 'src',
};

let runtimeCache = null;
/** The project's @vsd/vsa-node: the same code that reads these files at boot. */
function runtime() {
    if (runtimeCache) return runtimeCache;
    try {
        runtimeCache = createRequire(path.join(ROOT, 'package.json'))('@vsd/vsa-node');
    } catch (e) {
        throw new Error(`@vsd/vsa-node is not installed in this project (pnpm install): ${e.message.split('\n')[0]}`);
    }
    return runtimeCache;
}

let appFilesCache = null;
function appFiles() {
    if (appFilesCache) return appFilesCache;
    appFilesCache = {};
    const files = walk(P.appsDir, (r) => /\.ya?ml$/.test(r));
    if (!files.length) return appFilesCache;
    let loaded = null;
    let error = null;
    try { loaded = runtime().loadAppFiles(ROOT); } catch (e) { error = e.message.split('\n')[0]; }
    for (const rel of files) {
        const app = path.basename(rel).replace(/\.ya?ml$/, '');
        if (!loaded) { appFilesCache[app] = { file: rel, error }; continue; }
        const cfg = loaded[app];
        if (!cfg) { appFilesCache[app] = { file: rel, error: 'not loaded' }; continue; }
        /* The commands read the Laravel key `blade` (false = no markup file);
           the Node file says `markup`. Translate, never both. */
        const pages = {};
        for (const [name, page] of Object.entries(cfg.pages || {})) {
            const p = { ...(page || {}) };
            if ('markup' in p) { p.blade = p.markup; delete p.markup; }
            pages[name] = p;
        }
        appFilesCache[app] = { file: rel, cfg: { ...cfg, pages } };
    }
    return appFilesCache;
}

const bundleCache = new Map();
function bundles() {
    if (bundleCache.has('')) return bundleCache.get('');
    let result = null;
    if (exists(P.bundles)) {
        result = {};
        for (const [name, b] of Object.entries(runtime().loadBundles(ROOT).scripts || {})) result[name] = { attr: 'defer', ...b };
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

function styles() {
    if (!exists(P.styles)) return null;
    return runtime().loadBundles(ROOT).styles || {};
}

/** Page components, with their markup partial (option B) where Laravel has a blade. */
function pages(app = null) {
    return base.pages(app).map((p) => {
        const partial = p.file.replace(/\.js$/, '.html');
        return { ...p, blade: exists(partial) ? partial : null };
    });
}

/** Every server-rendered or page markup file: the page partials and views/*.html. */
function blades() {
    return [...walk(P.pages, (r) => r.endsWith('.html')), ...walk(P.views, (r) => r.endsWith('.html'))];
}

/** The shell is rendered by @vsd/vsa-node from the app file: its bundles are the app file's. */
function shells() {
    return apps().map((app) => {
        const af = appFiles()[app];
        const cfg = af && af.cfg ? af.cfg : null;
        const shell = { app, file: af ? af.file : `${P.appsDir}/${app}.yaml`, scripts: [], styles: [], inline: [], srcs: [] };
        if (cfg && cfg.shell) {
            shell.scripts = [...Object.keys(cfg.shell.scripts || {}), pageBundleName(app)];
            shell.styles = Object.keys(cfg.shell.styles || {});
        }
        return shell;
    });
}

/** No template renders bundles by name: the app files list them (shells()). */
function renderCalls() { return []; }

/** The line of `name` as a key or list item in a YAML app file, after `from` (0 when absent). */
function yamlLine(src, name, from = 0) {
    const re = new RegExp(`(^|[\\s\\[{,'"-])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=['"]?\\s*[:,\\]}]|\\s*$)`, 'm');
    const at = src.slice(from).search(re);
    return at === -1 ? 0 : lineOf(src, from + at + 1);
}

function navTargets() {
    const out = new Map();
    const add = (name, ref) => { if (!out.has(name)) out.set(name, []); out.get(name).push(ref); };
    const ALT = /alternative_route\s*:\s*\[([^\]]*)\]/g;
    for (const rel of coreFiles()) {
        const src = read(rel); let m;
        while ((m = ALT.exec(src))) for (const n of m[1].match(/[A-Za-z_]\w*/g) || []) add(n, { file: rel, line: lineOf(src, m.index), modId: null, kind: 'alternative' });
    }
    for (const [app, af] of Object.entries(appFiles())) {
        if (!af.cfg) continue;
        const src = read(af.file);
        const pagesCfg = af.cfg.pages || {};
        const navAt = Math.max(0, src.search(/^navigation\s*:/m));
        const placed = new Set();
        for (const it of base.appNavItems(af.cfg)) {
            placed.add(it.name);
            add(it.name, { file: af.file, line: yamlLine(src, it.name, navAt), modId: pagesCfg[it.name] ? (pagesCfg[it.name].module ?? null) : null, kind: 'nav', app, group: it.group });
        }
        for (const [name, page] of Object.entries(pagesCfg)) {
            if (placed.has(name)) continue;
            add(name, { file: af.file, line: yamlLine(src, name), modId: page ? (page.module ?? null) : null, kind: 'page', app });
        }
    }
    return out;
}

function navRefForApp(ref, app) {
    if (!apps().includes(app)) return true;
    const f = ref.file;
    return f.includes(`/core/${app}/`) || f === `${P.appsDir}/${app}.yaml` || f === `${P.appsDir}/${app}.yml`;
}

/**
 | Server permission checks in src/**.ts, with the routes that reach them:
 |   verifyAuth(req, 'CODE' | CONST | -1, ...)   in a controller method
 |   @ApiAuth('CODE')  (@ApiAuth() = signed in only, -1)
 | Routes from @Controller('<prefix>') + @Get/@Post/...('<path>').
 */
function serverPermissionChecks() {
    const server = [];
    const serverIds = new Set();
    for (const rel of walk(P.server, (r) => r.endsWith('.ts') && !r.endsWith('.test.ts') && !r.endsWith('.d.ts'))) {
        const src = read(rel);
        if (!/@Controller\(/.test(src)) continue;
        const ctrl = /@Controller\(\s*(?:'([^']*)'|"([^"]*)")?\s*\)\s*(?:@\w+\([^)]*\)\s*)*export\s+class\s+(\w+)/.exec(src);
        if (!ctrl) continue;
        const prefix = (ctrl[1] ?? ctrl[2] ?? '').replace(/^\/|\/$/g, '');
        const cls = ctrl[3];
        const classGuard = /@ApiAuth\(\s*(?:'([^']*)')?\s*\)\s*(?:@\w+\([^)]*\)\s*)*export\s+class/.exec(src);
        const consts = new Map([...src.matchAll(/const\s+([A-Z_][A-Z0-9_]*)\s*=\s*'([^']*)'/g)].map((m) => [m[1], m[2]]));
        const value = (arg) => {
            const a = arg.trim();
            if (/^-?\d+$/.test(a)) return Number(a);
            const lit = /^'([^']*)'$/.exec(a);
            if (lit) return normCode(lit[1]);
            if (consts.has(a)) return normCode(consts.get(a));
            const tern = /^[^?]+\?\s*(\S+)\s*:\s*(\S+)$/.exec(a);
            if (tern) return [value(tern[1]), value(tern[2])].join('|');
            return a;
        };
        const methods = [...src.matchAll(/@(Get|Post|Put|Patch|Delete|All)\(\s*(?:'([^']*)'|"([^"]*)")?\s*\)[\s\S]*?\n\s*(?:async\s+)?(\w+)\s*\(/g)]
            .map((m) => ({ name: m[4], at: m.index, uri: `/${[prefix, (m[2] ?? m[3] ?? '').replace(/^\/|\/$/g, '')].filter(Boolean).join('/')}` }));
        const methodAt = (index) => methods.filter((x) => x.at < index).pop();
        const record = (index, action) => {
            const mth = methodAt(index);
            for (const v of String(action).split('|')) if (/\./.test(v) || (/^\d+$/.test(v) && Number(v) > 0)) serverIds.add(/^\d+$/.test(v) ? Number(v) : v);
            server.push({ controller: cls, method: mth ? mth.name : '?', action, routes: mth ? [mth.uri] : [], at: `${rel}:${lineOf(src, index)}` });
        };
        for (const m of src.matchAll(/verifyAuth\(\s*\w+\s*,\s*([^,)]+)/g)) record(m.index, value(m[1]));
        for (const m of src.matchAll(/@ApiAuth\(\s*([^)]*)\)/g)) {
            if (classGuard && m.index === classGuard.index) continue;
            record(m.index, m[1].trim() ? value(m[1]) : -1);
        }
        if (classGuard) {
            /* @ApiAuth() on the class guards every route of it: sign-in at least. */
            for (const mth of methods) {
                if (server.some((s) => s.controller === cls && s.method === mth.name)) continue;
                server.push({ controller: cls, method: mth.name, action: classGuard[1] ? normCode(classGuard[1]) : -1, routes: [mth.uri], at: `${rel}:${lineOf(src, mth.at)}` });
            }
        }
    }
    return { server, serverIds };
}

/* ------------------------------------------------ what check app-file reads */

/** Locale files: locales/<lang>.json, read by @vsd/localization. */
const localeExt = '.json';
/** localization.trans('key', 'group') in src/**.ts (@vsd/localization, same syntax as PHP's). */
const serverTranslation = {
    files: () => walk(P.server, (r) => r.endsWith('.ts') && !r.endsWith('.test.ts') && !r.endsWith('.d.ts')),
    call: String.raw`\b[lL]ocalization\.trans\(`,
    needle: 'ocalization.trans(',
    variableArg: String.raw`\s*[A-Za-z_$]`,
};
/**
 * Translation keys the package-owned layout carries (@vsd/vsa-node LAYOUTS),
 * for every app's layout: [{ ref: 'group.key', file }]. The Laravel edition
 * finds the same keys by scanning its layout blades.
 */
function chromeKeys() {
    const layouts = runtime().LAYOUTS || {};
    const out = [];
    for (const af of Object.values(appFiles())) {
        const layout = (af.cfg && af.cfg.layout) || 'console';
        for (const ref of (layouts[layout] && layouts[layout].keys) || []) out.push({ ref, file: `@vsd/vsa-node (${layout} layout)` });
    }
    return out;
}
/** What a page's markup file is called in this edition (the JSON key stays `blade`). */
const markupWord = 'markup';
/** How app-file reports an app file it could not read. */
const appFileRefusal = 'refused by @vsd/vsa-node';
const appFileExt = '.yaml';
const appKeyLine = yamlLine;
function appKeyAt(src, name) { return src.search(new RegExp(`^${name}\\s*:`, 'm')); }
/** YAML has no code to run: an app file that parses is plain data. */
function appFileImpurity() { return null; }

/** The layouts are package code (@vsd/vsa-node LAYOUTS), not files the app owns. */
function layoutProblems(cfg) {
    const layouts = runtime().LAYOUTS || {};
    const layout = cfg.layout || 'console';
    if (!layouts[layout]) return [{ name: null, msg: `layout '${layout}' is not one @vsd/vsa-node renders (${Object.keys(layouts).join(', ')})` }];
    return (cfg.toolbar || []).filter((item) => !layouts[layout].toolbar.includes(item))
        .map((item) => ({ name: item, msg: `toolbar item '${item}' is not part of the ${layout} layout (${layouts[layout].toolbar.join(', ')})` }));
}

/** A view named in an app file: views/<name>.html, static HTML the app owns. */
function viewFile(name) { return `${P.views}/${String(name).replace(/\./g, '/')}.html`; }

/**
 * The page's markup partial (option B), by @vsd/vsa-node's pagePartial rule:
 * beside the script as <Name>.html, or the public path `markup:` names.
 */
function pageMarkup(app, name, page, file) {
    const named = typeof page.blade === 'string' && page.blade !== '';
    const rel = named ? `${P.public}/${page.blade.replace(/^\/+/, '')}` : file.replace(/\.js$/, '.html');
    return {
        rel,
        missing: named
            ? `${name}: markup '${page.blade}' names ${rel}, which does not exist`
            : `${name}: the shell includes ${rel}, which does not exist (declare markup: false for a page that builds its root at runtime)`,
    };
}

/** locales/<lang>.json as data, keyed by absolute path. */
function localeData() {
    const out = {};
    for (const rel of walk(P.locales, (f) => f.endsWith('.json'))) {
        try { out[abs(rel)] = JSON.parse(read(rel)); } catch (e) { throw new Error(`${rel} is not valid JSON: ${e.message}`); }
    }
    return out;
}

/**
 * Permission codes written as literals in the server code: verifyAuth(req, 'A.B'),
 * @ApiAuth('A.B'), and `const X = 'A.B'`.
 */
function permissionLiterals() {
    const out = [];
    for (const rel of walk(P.server, (r) => r.endsWith('.ts') && !r.endsWith('.test.ts') && !r.endsWith('.d.ts'))) {
        const src = read(rel);
        for (const m of src.matchAll(/(?:verifyAuth\(\s*\w+\s*,|@ApiAuth\()\s*'([A-Za-z][A-Za-z0-9_]*\.[A-Za-z][A-Za-z0-9_.-]*)'/g)) out.push({ file: rel, line: lineOf(src, m.index), code: m[1], constName: null });
        for (const m of src.matchAll(/const\s+([A-Z_][A-Z0-9_]*)\s*=\s*'([A-Za-z][A-Za-z0-9_]*\.[A-Za-z][A-Za-z0-9_.-]*)'/g)) out.push({ file: rel, line: lineOf(src, m.index), code: m[2], constName: m[1] });
    }
    return out;
}

const EPOCH = { rel: P.vsaConfig, line: /^asset_epoch\s*:\s*['"]?([^'"\s#]*)/m };

function php() { throw new Error('this project is on the Node edition: there is no PHP to ask'); }

/* Page clusters are a Laravel-edition artifact (config/*_bundles_pages.php). The
   node edition has no equivalent yet, so the build folds nothing extra - each
   page is its own entry. */
function pageClusters() { return { scripts: {}, styles: {} }; }
function syncPages() { return { ok: true, status: 0, output: '' }; }

function resetCache() {
    base.resetCache();
    appFilesCache = null; bundleCache.clear(); runtimeCache = null;
}

module.exports = {
    ...base,
    stack: 'node',
    P, php, resetCache,
    appFiles, bundles, styles, pageClusters, syncPages, pages, blades, shells, renderCalls, navTargets, navRefForApp, serverPermissionChecks,
    chromeKeys, localeExt, serverTranslation, markupWord, appFileExt, appFileRefusal, appKeyLine, appKeyAt, appFileImpurity, layoutProblems, viewFile, pageMarkup, localeData, permissionLiterals, EPOCH,
};
