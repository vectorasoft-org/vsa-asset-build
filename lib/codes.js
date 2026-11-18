'use strict';
/** 'items.manage.Create' -> 'ITEMS.MANAGE.create' (permission upper case, action lower case), same as the engine emits. */
function normCode(code) {
    const parts = String(code).split('.');
    return parts.length >= 3 ? `${parts.slice(0, 2).join('.').toUpperCase()}.${parts.slice(2).join('.').toLowerCase()}` : code.toUpperCase();
}
module.exports = { normCode };
