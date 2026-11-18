'use strict';
/*
 | The host adapter for this project's edition (VSA-CLI-NODE-STACK.md §3):
 | vsa.json "stack" - "laravel" (the default, so every existing project behaves
 | as before) or "node". A command or check never tests the stack; a difference
 | belongs in the adapters, behind the same surface.
 |
 | LAZY, because the adapters read the project context (lib/context.js) the
 | moment they load, and a consumer requires this package before it calls
 | configure(). So the adapter is chosen on first use, not on require.
 */
const project = require('../context');

let impl = null;
const pick = () => (impl || (impl = ((project.config && project.config.stack) === 'node' ? require('./node') : require('./laravel'))));

module.exports = new Proxy({}, {
    get: (_t, k) => pick()[k],
    has: (_t, k) => k in pick(),
    ownKeys: () => Reflect.ownKeys(pick()),
    getOwnPropertyDescriptor: (_t, k) => ({ ...Reflect.getOwnPropertyDescriptor(pick(), k), configurable: true }),
});
