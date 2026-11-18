'use strict';
/* Findings collector + terminal output. A check pushes findings; the runner
   prints them grouped and decides the exit code: any error → 1. */
const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const C = {
    red: (s) => tty ? `\x1b[31m${s}\x1b[0m` : s,
    yellow: (s) => tty ? `\x1b[33m${s}\x1b[0m` : s,
    green: (s) => tty ? `\x1b[32m${s}\x1b[0m` : s,
    dim: (s) => tty ? `\x1b[2m${s}\x1b[0m` : s,
    bold: (s) => tty ? `\x1b[1m${s}\x1b[0m` : s,
    cyan: (s) => tty ? `\x1b[36m${s}\x1b[0m` : s,
};

class Report {
    constructor({ strict = false } = {}) { this.checks = []; this.strict = strict; }
    start(id, title) {
        const check = { id, title, findings: [], skipped: null };
        this.checks.push(check);
        const api = {
            error: (file, line, msg) => check.findings.push({ level: 'error', file, line, msg }),
            warn: (file, line, msg) => check.findings.push({ level: this.strict ? 'error' : 'warn', file, line, msg }),
            info: (file, line, msg) => check.findings.push({ level: 'info', file, line, msg }),
            skip: (why) => { check.skipped = why; },
        };
        return api;
    }
    count(level) { return this.checks.reduce((n, c) => n + c.findings.filter((f) => f.level === level).length, 0); }
    get failed() { return this.count('error') > 0; }
    /* errorsOnly: the summary still counts the warnings, so they are never
       hidden - only their lines are. `vsa release` uses it: a wall of known
       warnings buries the one line that decides whether the deploy goes. */
    print({ quiet = false, errorsOnly = false } = {}) {
        for (const c of this.checks) {
            const errs = c.findings.filter((f) => f.level === 'error').length;
            const warns = c.findings.filter((f) => f.level === 'warn').length;
            const badge = c.skipped ? C.dim('skip') : errs ? C.red('FAIL') : warns ? C.yellow('warn') : C.green(' ok ');
            if (errorsOnly && !errs) continue;
            if (quiet && !errs && !warns) continue;
            console.log(`${badge}  ${C.bold(c.id)} ${C.dim(c.title)}`);
            if (c.skipped) { console.log(`       ${C.dim(c.skipped)}`); continue; }
            for (const f of c.findings) {
                if (errorsOnly && f.level !== 'error') continue;
                if (quiet && f.level === 'info') continue;
                const tag = f.level === 'error' ? C.red('E') : f.level === 'warn' ? C.yellow('W') : C.dim('i');
                const where = f.file ? C.cyan(f.file + (f.line ? ':' + f.line : '')) + '  ' : '';
                console.log(`   ${tag}  ${where}${f.msg}`);
            }
        }
        const e = this.count('error'), w = this.count('warn');
        console.log('');
        console.log(`${e ? C.red(e + ' error' + (e === 1 ? '' : 's')) : C.green('0 errors')}   ${w ? C.yellow(w + ' warning' + (w === 1 ? '' : 's')) : C.dim('0 warnings')}   ${C.dim(this.checks.length + ' checks')}`);
    }
    toJSON() { return { checks: this.checks, errors: this.count('error'), warnings: this.count('warn') }; }
}

module.exports = { Report, C };
