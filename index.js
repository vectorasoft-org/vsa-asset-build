'use strict';
/*
 | vsd/asset-build - THE VSA asset builder, once, for two consumers:
 |
 |   vsa-cli          `vsa build` on a developer's machine, which configures
 |                    this package with its own project singleton.
 |   a VSA app        `php artisan vsa:deploy` on a server, through
 |                    vendor/vsd/asset-build - no vsa-cli, no global tooling.
 |                    See bin/build.js and src/AssetBuild.php.
 |
 | The template forks none of this: there is one builder, and a project gets it
 | as a dependency.
 |
 |   const ab = require('vsa-asset-build');
 |   ab.configure({ ROOT, config });     // the project folder and its vsa.json
 |   ab.publish(['dms']);                // build, then publish on success
 |   ab.build(['dms', '--out=/tmp/x']);  // build only, no publish
 */
const context = require('./lib/context');

module.exports = {
    configure: context.configure,
    get host() { return require('./lib/host'); },
    /** Build and, only on success, publish into public/dist (what a deploy wants). */
    publish: (args = [], opts = {}) => require('./lib/swap').run(args, opts),
    /** The build alone, writing wherever it is told (what `vsa build` has always done). */
    build: (args = [], opts = {}) => require('./lib/build').run(args, opts),
    HASHED: require('./lib/build').HASHED,
    version: require('./package.json').version,
};
