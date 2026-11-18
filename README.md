# vsa-asset-build — the VSA asset builder

One builder, **pinned per project**, exactly as a Next.js app pins `next`.

```jsonc
// a VSA app's package.json
"dependencies": {
  "vsa-asset-build": "https://github.com/vectorasoft-org/vsa-asset-build/archive/refs/tags/v1.0.0.tar.gz"
}
```

```
php artisan vsa:deploy    a SERVER: npm ci, then node_modules/.bin/vsa-asset-build
vsa-asset-build           by hand, in any app root
vsa build                 a developer's machine, through vsa-cli
```

It turns every bundle in `config/script_bundles.php`, every app's stylesheet and
every page's script and stylesheet into **content-hashed, minified chunks** under
`public/dist`, plus a `manifest.json` the app shell reads. CDN urls are recorded
where they stand and never downloaded.

## Why it is a package of its own

`public/dist` used to be **committed**, built on a developer's Mac by
`vsa release`. The day someone pushed source without running it, the server
served the previous release's JS against the new PHP — and every command exited
0. It is invisible locally, because a developer's `.env` is `ASSET_BUILD=raw` and
serves the sources directly.

So the server builds. Developers only ever `git add . && git commit && git push`,
and the builder has to reach a box that has **no vsa-cli and never will**. The
template forks none of this code: both consumers run this one builder, so a fix
to the build reaches every project.

## This package is PUBLIC, and that is what makes the model simple

It is a bundler: no secrets, no business logic, no customer data. Being public
means a deploying box fetches it over plain https with **no credential at all** —
no SSH key, no registry token, no composer `auth.json`, nothing to rotate.

**Pin it as an https tarball url, not `github:<org>/<repo>#tag`.** npm resolves
that shorthand over `ssh://git@github.com`, which would put an SSH key back on
every box for a package that needs none. The tarball form is plain https, needs
no git on the machine, and `package-lock.json` records an **integrity hash** — so
a moved tag fails loudly instead of quietly changing a build.

A per-project pin also means **esbuild is not the app's dependency**: it arrives
through this package and is pinned in the app's own lockfile all the same.
Listing it twice would let two copies at different versions sit in
`node_modules`.

An earlier design installed one builder per HOST, shared by every app on it. That
needed a minimum-version floor, a skew warning, an install by hand on every box
and a "redeploy every app after upgrading" procedure — machinery that existed
only because the apps shared one tool. Pinning per project deleted all of it.

## Requirements on the box

* **Node >= 18** (npm ships inside it)
* **PHP** — the bundle lists are PHP files, read as data (`php -r 'echo json_encode(require ...)'`)
* **artisan**, which must boot: the build re-projects the per-page cluster
  configs first (`php artisan vsa:pages:sync`). Those configs are build output,
  gitignored, so a failure there is **fatal** — a build that cannot regenerate
  them has nothing to fall back on.

`esbuild` is a **platform-native binary**, so `node_modules` is installed on the
machine that runs it and never copied from a Mac (`darwin-arm64` cannot run on
Linux, and the failure reads as a broken build rather than a wrong binary).

## Use

```bash
vsa-asset-build                                 # build and publish, from the app root
vsa-asset-build --root=/srv/app                 # what php artisan vsa:deploy runs
vsa-asset-build --root=/srv/app --no-publish    # would it build? writes nothing
vsa-asset-build --version
```

```js
const ab = require('vsa-asset-build');
ab.configure({ ROOT, config });   // the project folder and its vsa.json
ab.publish(['dms']);              // build elsewhere, move into public/dist on success
ab.build(['dms']);                // build only, straight to where it is told
```

`publish()` is the atomic one, and a deploy always wants it: `public/dist` is
gitignored now, so a half-written build would leave the box with **no** assets,
which is far worse than stale ones. It builds into a temp directory, copies in
only on complete success, writes `manifest.json` **last**, and only then prunes
the chunks the new manifest no longer references — by this build's own naming
(`<stem>.<10 hex>.js`) and nothing else, because `public/dist` is not the
build's private directory (some projects keep hand-written files there).

## Provenance in the manifest

Every build records which builder produced what, so the question can be answered
on the box, without a checkout:

```json
{
  "generated": "2026-11-18T12:22:03.592Z",
  "builder": { "name": "vsa-asset-build", "version": "1.0.0" },
  "scripts": { "kge-base": { "built": "...", "by": "1.0.0", "parts": [ ... ] } }
}
```

`builder` is the build that wrote the manifest; `by` on each entry is the version
that produced THAT bundle, which survives a single-app rebuild merging into an
older manifest. Neither gates anything. Both are safe to add because every reader
does a keyed lookup (`manifest['scripts'][$bundle]`,
`manifest['pages']["$app/$name"]`) and nothing iterates the manifest root, so a
new top-level key can never be mistaken for a bundle.

## What is NOT here

The structural rules (`vsa check`, `checks/`) are a developer's concern and stay
in vsa-cli. A consumer that wants them passes a runner in as `opts.onCheck`.

There is no PHP side: an earlier design shipped this as a composer package
(`vsd/asset-build`) with an `AssetBuild.php` helper. The composer channel is
closed, so a VSA app's `composer.json` mentions the builder nowhere.

## Layout

```
index.js            configure / build / publish
bin/build.js        the vsa-asset-build binary
lib/context.js      the project context, injected (never discovered twice)
lib/build.js        the build itself
lib/swap.js         build elsewhere, publish only on success
lib/host/           the project layout; laravel.js reads the PHP config as data
lib/report.js       colours  ) copies on purpose: this package must stand alone
lib/codes.js        normCode )  in a project's node_modules, with no CLI present
```

## Releasing a new version

1. bump `version` in `package.json` (it is what the manifest stamps), commit;
2. tag it `vX.Y.Z` and push the tag — the tag is what apps pin;
3. in each app that wants it: edit the url in `package.json`, `npm install`,
   commit the lockfile, deploy. One app at a time, visibly, in git.

## Consuming it from vsa-cli

vsa-cli resolves it four ways (`lib/asset-build.js`), in this order: the
**project's** `node_modules` first — what the project pins and what its server
will build with — then the CLI's own dependency, then `vendor/asset-build`
bundled into the published CLI by `scripts/build-dist.js` (`~/.vsa/cli` is a git
clone with no `npm install` behind it), then a `../vsa-asset-build` sibling
checkout (or `../lib-asset-build`, the folder name from before the repository was
renamed). `php artisan vsa:deploy` uses none of that: it runs the project's own
pinned binary, and must never depend on vsa-cli being present.
