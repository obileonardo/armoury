// The matching rules and the tools.json checks, against made-up repositories. No network.
//   node --test scripts/build.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { matches, validate } from './build.mjs';

const repo = (over = {}) => ({
  name: 'me/app', short: 'app', paths: [], lang: new Set(), topics: new Set(),
  deps: new Set(), cargo: new Set(), swiftpm: new Set(), ...over,
});

test('each kind of rule matches what it should', () => {
  assert.ok(matches({ lang: ['Swift'] }, repo({ lang: new Set(['Swift']) })));
  assert.ok(matches({ deps: ['next'] }, repo({ deps: new Set(['next', 'react']) })));
  assert.ok(matches({ cargo: ['redis'] }, repo({ cargo: new Set(['redis']) })));
  assert.ok(matches({ swiftpm: ['GRDB'] }, repo({ swiftpm: new Set(['grdb']) })), 'Swift packages match case-insensitively');
  assert.ok(matches({ topics: ['mcp'] }, repo({ topics: new Set(['mcp']) })));
  assert.ok(matches({ files: ['(^|/)vercel\\.json$'] }, repo({ paths: ['site/vercel.json'] })));
  assert.ok(matches({ repoName: ['^homebrew-'] }, repo({ short: 'homebrew-app' })));
});

test('rules do not match near misses', () => {
  assert.equal(matches({ files: ['(^|/)vercel\\.json$'] }, repo({ paths: ['docs/vercel.json.md'] })), false);
  assert.equal(matches({ deps: ['next'] }, repo({ deps: new Set(['next-auth']) })), false);
  assert.equal(matches({ lang: ['Swift'] }, repo()), false);
  assert.equal(matches(undefined, repo({ lang: new Set(['Swift']) })), false, 'a tool with no rules matches nothing');
});

test('the real tools.json is valid', async () => {
  const cfg = JSON.parse(await readFile(new URL('../tools.json', import.meta.url), 'utf8'));
  assert.doesNotThrow(() => validate(cfg));
});

test('validate reports every problem', () => {
  const bad = {
    owner: 'me', kinds: ['code'], projects: [{ name: 'App' }],
    tools: [
      { name: 'A', kind: 'code', note: '' },
      { name: 'A', kind: 'cooking', note: 1, find: { colour: ['red'], files: ['('] }, also: ['Nope'] },
    ],
  };
  assert.throws(() => validate(bad), (err) => {
    for (const bit of ['duplicate name', 'kind "cooking"', 'note must be a string', 'unknown find rule "colour"', 'bad pattern', '"Nope"']) {
      assert.match(err.message, new RegExp(bit.replace(/[()]/g, '\\$&')));
    }
    return true;
  });
});
