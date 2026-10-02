import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { RunnerError } from '../src/domain/contracts.js';
import {
  GIT_ERROR_CODES, classifyPushPorcelain, parseCommitInput, parseIdempotencyInput, parsePushInput, parseStartInput,
  threadBranchName, validGitBranchName,
} from '../src/domain/git-sync.js';
import { isBranchList, isCheckoutStatus, isCommitResult, isGitErrorBody, isGitOperation, isThreadGitStatus } from '../src/domain/git-sync-wire.js';

type Example = Readonly<{ name: string; value: unknown }>;
type Section = Readonly<{ accepted: readonly Example[]; rejected: readonly Example[] }>;
type Fixture = Readonly<{ schemaVersion: number; capability: string; errorCodes: readonly string[]; sections: Readonly<Record<string, Section>> }>;
const fixture = JSON.parse(readFileSync(new URL('../../test/fixtures/remote-git-sync-wire.json', import.meta.url), 'utf8')) as Fixture;

const parsers: Readonly<Record<string, (value: unknown) => unknown>> = {
  startBody: parseStartInput,
  fetchOrUpdateBody: parseIdempotencyInput,
  commitBody: parseCommitInput,
  pushBody: parsePushInput,
};
const responses: Readonly<Record<string, (value: unknown) => boolean>> = {
  branchList: isBranchList,
  checkoutStatus: isCheckoutStatus,
  threadGitStatus: isThreadGitStatus,
  commitResult: isCommitResult,
  gitOperation: isGitOperation,
  errorBody: isGitErrorBody,
};
const editorOnly = new Set(['editorGitRequest']);

test('git sync fixture covers every runner-facing section and the closed error code set', () => {
  assert.equal(fixture.schemaVersion, 1);
  assert.equal(fixture.capability, 'gitSync');
  assert.deepEqual([...fixture.errorCodes], [...GIT_ERROR_CODES]);
  for (const name of Object.keys(fixture.sections))
    assert.ok(editorOnly.has(name) || name in parsers || name in responses, `unconsumed section ${name}`);
  for (const name of [...Object.keys(parsers), ...Object.keys(responses)]) assert.ok(fixture.sections[name], name);
});

test('runner request parsers accept and reject exactly the shared fixture bodies', () => {
  for (const [section, parse] of Object.entries(parsers)) {
    const { accepted, rejected } = fixture.sections[section]!;
    for (const example of accepted) assert.doesNotThrow(() => parse(example.value), `${section}.${example.name}`);
    for (const example of rejected)
      assert.throws(() => parse(example.value), (error: unknown) => error instanceof RunnerError && error.code === 'invalid_input', `${section}.${example.name}`);
  }
});

test('runner response validators accept and reject exactly the shared fixture payloads', () => {
  for (const [section, check] of Object.entries(responses)) {
    const { accepted, rejected } = fixture.sections[section]!;
    for (const example of accepted) assert.equal(check(example.value), true, `${section}.${example.name}`);
    for (const example of rejected) assert.equal(check(example.value), false, `${section}.${example.name}`);
  }
});

test('thread branches and push porcelain stay inside the closed grammar', () => {
  assert.equal(threadBranchName('7389088c-1d2e-4c5d-9e6f-7a8b9c0d1e2f'), 'codevo/7389088c');
  assert.equal(threadBranchName('7389088c-1d2e-4c5d-9e6f-7a8b9c0d1e2f', true), 'codevo/7389088c1d2e4c5d9e6f7a8b9c0d1e2f');
  assert.throws(() => threadBranchName('../main'), /invalid_input/);
  for (const name of ['HEAD', '+main', 'a:b', 'refs/*', '-x', 'é'.repeat(128)]) assert.equal(validGitBranchName(name), false, name);
  const sha = '3f786850e387550fdab836ed7e6dc881de23001b';
  const ref = 'refs/heads/codevo/7389088c';
  assert.deepEqual(classifyPushPorcelain(`To x\n*\t${sha}:${ref}\t[new branch]\nDone\n`, ref), { status: 'created' });
  assert.deepEqual(classifyPushPorcelain(`=\t${sha}:${ref}\t[up to date]\n`, ref), { status: 'unchanged' });
  assert.deepEqual(classifyPushPorcelain(`!\t${sha}:${ref}\t[rejected] (non-fast-forward)\n`, ref), { status: 'rejected', error: 'git_rejected_non_fast_forward' });
  assert.deepEqual(classifyPushPorcelain(`!\t${sha}:${ref}\t[remote rejected] (protected branch)\n`, ref), { status: 'rejected', error: 'git_rejected' });
  assert.equal(classifyPushPorcelain(`*\t${sha}:refs/heads/other\t[new branch]\n`, ref), undefined);
});
