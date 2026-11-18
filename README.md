# @vsa/asset-build — the VSA asset builder

One builder, installed **once per host**, used by every VSA app on it.

```
npm install -g git+ssh://git@github.com/<org>/lib-asset-build.git     ONCE, by hand

vsa-asset-build                directly, in any app root
php artisan vsa:deploy         a SERVER - it locates the binary on PATH
vsa build                      a developer's machine, through vsa-cli
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

So the server builds. Developers only ever `git add . && git commit && git push`.

That means the builder has to reach a box that has **no vsa-cli and never
will** — which is what this package is for. The template forks none of this
code: both consumers run this one builder, so a fix to the build reaches every
project.

## Why it is installed globally, and not per app

Because of what `esbuild` is: a **platform-native binary**, which can only be
installed on the machine that runs it. Copying `node_modules` from a Mac to a
Linux box produces a build failure that reads like broken source, not a wrong
binary. So the install happens on the box — and then it may as well happen
**once** on the box rather than once per app:

* a deploy needs **no credentials at all**. The private-repo access happens once,
  by hand, at install time — not inside `php artisan vsa:deploy`, which is why
  there is no npm registry token, no `auth.json` entry and no `insteadOf` token
  rewrite in `~/.gitconfig` on any VPS.
* a deploy has **no npm step**: nothing to install, nothing to go stale, no
  network needed. An app has no `package.json`, no lockfile and no
  `node_modules`.
* four apps on one box share one copy of esbuild instead of four.

**The price, and the two things that pay it.** An app can meet a builder that is
not the one it was developed against, and the directions are not symmetrical:

* **older than the app declares → the deploy REFUSES.** Every app declares a
  minimum builder version; `php artisan vsa:deploy` names the installed version,
  the required one and the upgrade command. An old builder can produce a subtly
  wrong or incomplete bundle while exiting 0, and a warning during a deploy is
  read by nobody. `vsa-asset-build --version` exists for this check, and must
  keep answering without a project, a config file or esbuild present.
* **newer than the app declares → it WARNS and carries on.** A floor cannot
  protect this direction, and refusing would be worse than the risk: one app's
  upgrade would block every other app on the host from deploying until each had
  been bumped in lockstep, which is the coordination this model deletes.

And every build **stamps its own provenance into the manifest**, so the question
a shared tool raises - what is this box actually serving, app by app? - is
answered on the box:

```json
{
  "generated": "2026-11-18T12:22:03.592Z",
  "builder": { "name": "vsa-asset-build", "version": "1.0.0" },
  "scripts": { "kge-base": { "built": "...", "by": "1.0.0", "parts": [ ... ] } }
}
```

`builder` is the build that wrote the manifest; `by` on each entry is the version
that produced THAT bundle, which survives a single-app rebuild merging into an
older manifest. Neither gates anything. Both are safe to add because every
reader does a keyed lookup (`manifest['scripts'][$bundle]`,
`manifest['pages']["$app/$name"]`) and nothing iterates the manifest root, so a
new top-level key can never be mistaken for a bundle.

## Installing it

```bash
# a server, or any machine: straight from the repo
npm install -g git+ssh://git@github.com/<org>/lib-asset-build.git

# from a local checkout - note the flag
npm install -g --install-links .
```

**`--install-links` is not optional for a folder install.** Without it npm
installs this package and *none of its dependencies* ("added 1 package"), so the
binary lands on PATH, answers `--version`, and then fails on the first build
with esbuild missing. Verify an install, always:

```bash
vsa-asset-build --version                   # the version apps check against
vsa-asset-build --root=/srv/app --no-publish  # a real build that writes nothing
```

## Requirements on the box

* **Node >= 18** (npm ships inside it)
* **PHP** — the bundle lists are PHP files, read as data (`php -r 'echo json_encode(require ...)'`)
* **artisan**, which must boot: the build re-projects the per-page cluster
  configs first (`php artisan vsa:pages:sync`). Those configs are build output,
  gitignored, so a failure there is **fatal** — a build that cannot regenerate
  them has nothing to fall back on.

## Use

```bash
vsa-asset-build                                 # build and publish, from the app root
vsa-asset-build --root=/srv/app                 # what php artisan vsa:deploy runs
vsa-asset-build --root=/srv/app --no-publish    # would it build? writes nothing
vsa-asset-build --version                       # the version an app's floor is checked against
```

```js
const ab = require('@vsa/asset-build');
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

## What is NOT here

The structural rules (`vsa check`, `checks/`) are a developer's concern and stay
in vsa-cli. A consumer that wants them passes a runner in as `opts.onCheck`.

There is no PHP side. An earlier design shipped this as a composer package
(`vsd/asset-build`) with an `AssetBuild.php` helper, installed per app into
`vendor/`; the global install replaced it, so a VSA app's `composer.json`
mentions the builder nowhere.

## Layout

```
index.js            configure / build / publish
bin/build.js        the vsa-asset-build binary
lib/context.js      the project context, injected (never discovered twice)
lib/build.js        the build itself
lib/swap.js         build elsewhere, publish only on success
lib/host/           the project layout; laravel.js reads the PHP config as data
lib/report.js       colours  ) copies on purpose: this package must stand alone,
lib/codes.js        normCode )  installed globally with no CLI present
```

## Consuming it from vsa-cli

vsa-cli resolves it three ways, so no machine can end up with a CLI that cannot
find it (`lib/asset-build.js`): `node_modules`, then `vendor/asset-build` bundled
into the published CLI by `scripts/build-dist.js`, then a `../lib-asset-build`
sibling checkout. A developer's Mac may therefore get its builder from vsa-cli
rather than from a global install — but `php artisan vsa:deploy` never does: its
path to the builder must not depend on vsa-cli being present at all.
