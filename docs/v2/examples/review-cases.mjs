// Focused review reproductions for bb85513. Uses temporary toy stores and no model.
// Exit 1 means at least one documented defect remains; this is not the npm test suite.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempToy, runCli, REPO_ROOT, FIXTURES } from '../../../dist/test/helpers.js';
import { loadStore } from '../../../dist/src/store/files.js';
import { deriveProcedure } from '../../../dist/src/lifecycle/derive.js';
const git = (dir, ...args) => execFileSync('git', ['-C', dir, '-c', 'user.name=Review', '-c', 'user.email=review@example.invalid', ...args], { encoding: 'utf8' }).trim();
const init = dir => {
    git(dir, 'init', '-q', '-b', 'main');
    // CLI-created commits inherit this temporary repository's identity.
    git(dir, 'config', 'user.name', 'Review');
    git(dir, 'config', 'user.email', 'review@example.invalid');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'fixture');
};
const commit = dir => { git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'review fixture'); };
const cli = (dir, args, opts = {}) => { const r = runCli(['--json', ...args], { cwd: dir, ...opts }); assert.equal(r.status, 0, r.stdout + r.stderr); return r.json; };
const turn = (dir, prompt) => cli(dir, ['hooks', 'run', 'UserPromptSubmit'], { input: JSON.stringify({ cwd: dir, session_id: '99999999-aaaa-bbbb-cccc-dddddddddddd', prompt }) });
const annotation = (field, value, data = [], depends_on = []) => ({ title: 'Review fixture', kind: 'annotation', status: 'active', claim: String(value), qualifier: { confidence: 1, scope: 'review' }, fragility: 'mechanical', target: { unit: 'P02', field, value }, data, warrant: ['dec_crit0random2'], depends_on });
const results = [];
{
    const parent = tempToy(), child = tempToy();
    try {
        const cfg = join(parent.dir, 'whitesnake.yaml');
        writeFileSync(cfg, readFileSync(cfg, 'utf8').replace(/^id: toy$/m, 'id: parent-lab').replace('stores: {}', 'stores:\n  toy: ' + child.dir));
        init(parent.dir);
        init(child.dir);
        turn(parent.dir, 'Run child');
        const d = cli(parent.dir, ['delegate', '--child', 'toy', '--question', 'P02', '--harness', 'stub'], { env: { WHITESNAKE_STUB_SCRIPT: join(FIXTURES, 'stub-agent.sh'), PATH: join(REPO_ROOT, 'bin') + ':' + process.env.PATH } });
        const id = d.output.decision_ids[0];
        const l = cli(parent.dir, ['add', 'decision', '--json-in', JSON.stringify(annotation('twice_randomized', 170, [d.parent_evidence], [{ store: 'toy', id, commit: git(d.worktree, 'rev-parse', 'HEAD') }]))]);
        turn(parent.dir, 'Fix my multiplication, source 84 was correct');
        cli(parent.dir, ['correct', l.id, '--reason', 'The parent multiplied 84 incorrectly; the child value is correct', '--value', '168']);
        const sync = cli(parent.dir, ['sync']);
        const target = cli(d.worktree, ['get', id]);
        const proc = cli(d.worktree, ['get', 'proc_tablecount01']);
        results.push({ case: 'parent_only_error', parent_corrected_field: 'twice_randomized', child_field: target.target.field, child_value: target.target.value, child_status: target.status, child_procedure: proc.state, delivered: sync.delivered.length, expected: 'child result remains active; no attribution to its procedure' });
    }
    finally {
        parent.cleanup();
        child.cleanup();
    }
}
{
    const t = tempToy();
    try {
        const s = loadStore(t.dir);
        s.config.promotion.shown_uses_to_trust = 2;
        const d = s.nodes.get('dec_p01nrand0000');
        const early = { turn: 'turn_claude_toyseed0001_0001', at: '2026-11-06T10:00:00.000Z' }, late = { turn: 'turn_claude_toyseed0001_0002', at: '2026-11-06T12:00:00.000Z' };
        d.corrections = [{ event: 'review-order', turn: early.turn, at: '2026-11-06T11:00:00.000Z', actor: 'human:researcher', reason: 'review' }];
        const derive = events => { d.shown_at = events; const x = deriveProcedure(s, 'proc_tablecount01', { branch: 'main', owner: 'human:researcher' }); return { state: x.state, counters: x.counters, history: x.history.map(h => h.to) }; };
        results.push({ case: 'shown_delivery_order', chronological: derive([early, late]), reversed: derive([late, early]), expected: 'identical derived counters/history for the same events' });
    }
    finally {
        t.cleanup();
    }
}
{
    const t = tempToy();
    try {
        init(t.dir);
        const b = cli(t.dir, ['branch', 'open', '--parent', 'parent-lab']);
        cli(b.worktree, ['add', 'decision', '--json-in', JSON.stringify(annotation('n_randomized_total', 84))]);
        cli(b.worktree, ['validate']);
        commit(b.worktree);
        cli(t.dir, ['add', 'decision', '--json-in', JSON.stringify(annotation('n_randomized_total', 86))]);
        cli(t.dir, ['validate']);
        commit(t.dir);
        const reopened = runCli(['--json', 'branch', 'open', '--parent', 'parent-lab'], { cwd: t.dir });
        const validation = runCli(['--json', 'validate'], { cwd: b.worktree });
        results.push({ case: 'invalid_rebase', reopen_exit: reopened.status, validation_exit: validation.status, duplicate_active: validation.stdout.includes('E_DUPLICATE_ACTIVE'), expected: 'rebase rejected or reconciled before success' });
    }
    finally {
        t.cleanup();
    }
}
for (const result of results) {
    if (result.case === 'parent_only_error')
        result.passed = result.child_status === 'active' && result.child_procedure !== 'suspended';
    else if (result.case === 'shown_delivery_order')
        result.passed = JSON.stringify(result.chronological) === JSON.stringify(result.reversed);
    else if (result.case === 'invalid_rebase')
        result.passed = result.validation_exit === 0;
}
console.log(JSON.stringify(results, null, 2));
process.exitCode = results.every(result => result.passed) ? 0 : 1;
