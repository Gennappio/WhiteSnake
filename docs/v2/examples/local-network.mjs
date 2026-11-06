#!/usr/bin/env node
// Executable local-network documentation. Uses only the deterministic test fixture, never a model.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const cli = join(repo, 'dist/src/cli.js');
if (!existsSync(cli)) throw new Error('Run npm run build from the repository root first.');
const requested = process.argv[2];
if (requested && existsSync(resolve(requested))) throw new Error('Choose a new output directory; existing paths are never overwritten.');
const lab = requested ? resolve(requested) : mkdtempSync(join(tmpdir(), 'whitesnake-v2-local-'));
mkdirSync(lab, { recursive: true });
const parent = join(lab, 'parent');
const child = join(lab, 'child');
const env = {
  ...process.env,
  GIT_AUTHOR_NAME: 'WhiteSnake documentation demo',
  GIT_AUTHOR_EMAIL: 'demo@example.invalid',
  GIT_COMMITTER_NAME: 'WhiteSnake documentation demo',
  GIT_COMMITTER_EMAIL: 'demo@example.invalid',
  WHITESNAKE_STUB_SCRIPT: join(repo, 'test/fixtures/stub-agent.sh'),
  PATH: join(repo, 'bin') + ':' + (process.env.PATH ?? ''),
};
function run(cwd, args, input) {
  const stdout = execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', cli, '--json', ...args],
    { cwd, env, input, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (args[0] === 'hooks') return stdout;
  return stdout.trim() ? JSON.parse(stdout) : null;
}
function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { env, encoding: 'utf8' }).trim();
}
const session = '11111111-2222-3333-4444-555555555555';
function startTurn(prompt) {
  run(parent, ['hooks', 'run', 'UserPromptSubmit'], JSON.stringify({
    cwd: parent, session_id: session, hook_event_name: 'UserPromptSubmit', prompt,
  }));
}

// The parent is a new node. The child is a seeded research fixture with an existing procedure.
run(lab, ['init', parent, '--id', 'demo-parent', '--name', 'Documentation parent', '--no-hooks',
  '--mandate', 'Use the toy child to demonstrate local delegation and feedback.']);
cpSync(join(repo, 'examples/toy-store'), child, { recursive: true });
git(child, 'init', '-q', '-b', 'main');
git(child, 'add', '-A');
git(child, 'commit', '-q', '-m', 'Seed the documentation child');
const cfgPath = join(parent, 'whitesnake.yaml');
const cfg = YAML.parse(readFileSync(cfgPath, 'utf8'));
cfg.stores = { toy: child };
writeFileSync(cfgPath, YAML.stringify(cfg));
git(parent, 'add', 'whitesnake.yaml');
git(parent, 'commit', '-q', '-m', 'Register the local child');
const mainBefore = git(child, 'rev-parse', 'main');
startTurn('Demonstrate local delegation of P02 to the toy child.');
const delegated = run(parent, ['delegate', '--child', 'toy', '--question', 'Count P02 randomised participants.', '--harness', 'stub']);
assert.equal(delegated.output.status, 'completed');
const remoteId = delegated.output.decision_ids[0];
const childRevision = git(delegated.worktree, 'rev-parse', 'HEAD');
const local = run(parent, ['add', 'decision', '--json-in', JSON.stringify({
  title: 'P02 count returned by toy', kind: 'annotation', status: 'active',
  claim: 'The toy child returned 84 randomised participants.',
  qualifier: { confidence: 0.9, scope: 'Synthetic documentation fixture' }, fragility: 'mechanical',
  target: { unit: 'P02', field: 'n_randomized_total', value: 84 },
  data: [delegated.parent_evidence], warrant: [],
  depends_on: [{ store: 'toy', id: remoteId, commit: childRevision }],
})]);
run(parent, ['shown', local.id]);
const shownDelivery = run(parent, ['sync']);
assert.equal(shownDelivery.delivered.length, 1);
assert.equal(shownDelivery.pending.length, 0);
assert.equal(run(delegated.worktree, ['get', 'proc_tablecount01']).state, 'trusted');

// This is a synthetic correction of the child's same cell, not a scientific claim about the fixture.
startTurn('Demonstrate returning a correction to the same child cell.');
run(parent, ['correct', local.id, '--reason', 'Synthetic correction for the documentation feedback exercise.', '--value', '86']);
const correctedDelivery = run(parent, ['sync']);
assert.equal(correctedDelivery.delivered.length, 1);
assert.equal(correctedDelivery.pending.length, 0);
assert.equal(run(delegated.worktree, ['get', 'proc_tablecount01']).state, 'suspended');
assert.equal(git(child, 'rev-parse', 'main'), mainBefore);
assert.equal(run(child, ['get', 'proc_tablecount01']).state, 'provisional');
assert.deepEqual(run(parent, ['sync']), { delivered: [], pending: [] });
for (const dir of [parent, child, delegated.worktree]) run(dir, ['validate']);
const branches = run(child, ['branch', 'status']);
assert.ok(branches.some(b => b.questions.includes(correctedDelivery.delivered[0].question)));

const result = {
  lab, parent, child, worktree: delegated.worktree,
  parent_decision: local.id, child_decision: remoteId, child_revision: childRevision,
  feedback_question: correctedDelivery.delivered[0].question,
  checks: { local_delegation: true, shown_feedback: true, correction_feedback: true,
    retry_deduplicated: true, child_main_unchanged: true, three_stores_valid: true },
  note: 'Local fixture only. No HTTP transport, mode enforcement, authentication or real simulation is exercised.',
};
writeFileSync(join(lab, 'demo-result.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));

