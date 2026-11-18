# vsd/asset-build — the VSA asset builder

One builder, two consumers.

```
vsa build                     a developer's machine, through vsa-cli
php artisan vsa:deploy        a SERVER, through vendor/vsd/asset-build
```

It turns every bundle in `config/script_bundles.php`, every app's stylesheet and
every page's script and stylesheet into **content-hashed, minified chunks** under
`public/dist`, plus a `manifest.json` the app shell reads. CDN urls are recorded
where they stand and never downloaded.

## Why it is a package

`public/dist` used to be **committed**, built on a developer's Mac by
`vsa release`. The day someone pushed source without running it, the server
served the previous release's JS against the new PHP — and every command exited
0. It is invisible locally, because a developer's `.env` is `ASSET_BUILD=raw` and
serves the sources directly.

So the server builds. Developers only ever `git add . && git commit && git push`.

That means the builder has to reach a box that has **no vsa-cli and never
will** — which is what this package is for. The template forks none of this
code: a project depends on it, so a fix to the build reaches every project.

## How it gets to a server, with no new credentials

| what | private? | channel |
|---|---|---|
| this package | yes | **composer**, a `"type": "vcs"` repo beside the other `vsd/*` — the box already has the `auth.json` credential |
| esbuild | **no**, public on npm | `npm ci` in the **project root** |

No git credentials on the VPS, no private npm registry, no token in
`~/.gitconfig`.

`esbuild` is a **platform-native binary**, so it is installed on the box that
runs it — never copied from a Mac (`darwin-arm64` cannot run on Linux, and the
failure reads as a broken build rather than a wrong binary).

`node_modules` must live in the **project root**, never under `vendor/`:
`composer install` rewrites `vendor/` on every deploy and would take it along.

## Requirements on the box

* **Node >= 18** (npm ships inside it)
* **PHP** — the bundle lists are PHP files, read as data (`php -r 'echo json_encode(require ...)'`)
* **artisan**, when the app can boot: the build re-projects the per-page cluster
  configs first (`php artisan vsa:pages:sync`), so a build can never ship a stale
  cluster. Best-effort — it warns and builds from the committed files otherwise.

## Use

```js
const ab = require('@vsa/asset-build');
ab.configure({ ROOT, config });   // the project folder and its vsa.json
ab.publish(['dms']);              // build elsewhere, move into public/dist on success
ab.build(['dms']);                // build only, straight to where it is told
```

```bash
node bin/build.js --root=/srv/app              # build and publish (what a deploy runs)
node bin/build.js --root=/srv/app --no-publish  # would it build? writes nothing
```

`publish()` is the atomic one, and a deploy always wants it: `public/dist` is
gitignored now, so a half-written build would leave the box with **no** assets,
which is far worse than stale ones. It builds into a temp directory, copies in
only on complete success, writes `manifest.json` **last**, and only then prunes
the chunks the new manifest no longer references — by this build's own naming
(`<stem>.<10 hex>.js`) and nothing else, because `public/dist` is not the
build's private directory (some projects keep hand-written files there).

## What is NOT here

The structural rules (`vsa check`, `checks/`) are a developer's concern and stay
in vsa-cli. A consumer that wants them passes a runner in as `opts.onCheck`.

## Layout

```
index.js            configure / build / publish
bin/build.js        the server's entry point, run by php artisan vsa:deploy
lib/context.js      the project context, injected (never discovered twice)
lib/build.js        the build itself
lib/swap.js         build elsewhere, publish only on success
lib/host/           the project layout; laravel.js reads the PHP config as data
lib/report.js       colours  ) copies on purpose: this package must stand alone
lib/codes.js        normCode )  in vendor/, with no CLI present
src/AssetBuild.php  the PHP side: where things are, and whether this box can run them
```

## Consuming it from vsa-cli

vsa-cli resolves it three ways, so no machine can end up with a CLI that cannot
find it (`lib/asset-build.js`): `node_modules`, then `vendor/asset-build` bundled
into the published CLI by `scripts/build-dist.js`, then a `../lib-asset-build`
sibling checkout.

Once this repo is pushed, add it to vsa-cli's `package.json` as a git dependency
and commit the refreshed lockfile; the bundling above means nothing breaks in the
meantime.
