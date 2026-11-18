'use strict';
/*
 | WHICH PROJECT, AND WHOSE CLI - injected, never discovered twice.
 |
 | The host adapters below used to read vsa-cli's own lib/project.js singleton.
 | This package has two consumers - vsa-cli on a developer's machine and
 | `php artisan vsa:deploy` on a server, where no CLI exists - so the project
 | context is passed IN instead:
 |
 |   require('@vsa/asset-build').configure({ ROOT, config, CLI_DIR })
 |
 | ROOT     the project folder (the one holding vsa.json)
 | config   that vsa.json, with the consumer's defaults already merged. The
 |          build itself reads almost nothing from it; the host surface exposes
 |          `config.env` and `config.modules` for the consumer's other commands.
 | CLI_DIR  where the CONSUMER keeps its data files (known-globals.json). Only
 |          vsa-cli's checks read it; the build never does, so the standalone
 |          entry point passes this package's own folder.
 |
 | It is set once, before any host call. Reading it unset is a programming
 | error, not a user error, so it throws rather than guessing a folder - a build
 | that silently chose the wrong ROOT would write chunks into the wrong project.
 */
let ctx = null;

function configure(c) {
    if (!c || !c.ROOT) throw new Error('asset-build: configure({ ROOT, config }) needs a project ROOT');
    ctx = { ROOT: c.ROOT, config: c.config || {}, CLI_DIR: c.CLI_DIR || require('path').resolve(__dirname, '..') };
    return module.exports;
}

const need = () => {
    if (!ctx) throw new Error('asset-build: configure({ ROOT, config }) was never called');
    return ctx;
};

module.exports = {
    configure,
    get ROOT() { return need().ROOT; },
    get config() { return need().config; },
    get CLI_DIR() { return need().CLI_DIR; },
};
