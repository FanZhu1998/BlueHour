import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const scanner = path.resolve('scripts/verify-privacy.mjs');

async function fixture(run: (directory: string) => Promise<void>) {
  const parent = path.resolve(os.tmpdir());
  const directory = await mkdtemp(path.join(parent, 'blue-hour-privacy-test-'));
  try {
    git(directory, ['init', '--quiet']);
    await writeFile(path.join(directory, '.gitignore'), '.env\n');
    await run(directory);
  } finally {
    // Delete only this test's own freshly created directory inside the OS temp root.
    assert.equal(path.dirname(path.resolve(directory)), parent);
    assert.ok(path.basename(directory).startsWith('blue-hour-privacy-test-'));
    await rm(directory, { recursive: true, force: true });
  }
}

function git(directory: string, args: string[]) {
  return execFileSync('git', args, {
    cwd: directory,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
  });
}

function audit(directory: string, privateValue?: string) {
  const result = spawnSync(process.execPath, [scanner], { cwd: directory, encoding: 'utf8' });
  // Check privacy before any assertion might include scanner diagnostics.
  assert.ok(!privateValue || !`${result.stdout}${result.stderr}`.includes(privateValue));
  assert.equal(result.stderr, '');
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.valuesPrinted, false);
  assert.equal(result.status, summary.passed ? 0 : 1);
  return summary;
}

test('publication audit permits blank examples and explicit fake test credentials', async () => {
  await fixture(async (directory) => {
    await writeFile(path.join(directory, '.env.example'), 'NASA_API_KEY=\n');
    await writeFile(
      path.join(directory, 'example.ts'),
      "const apiKey = 'FAKE_SENTINEL_FOR_TESTS';\n",
    );
    assert.equal(audit(directory).passed, true);
  });
});

test('publication audit detects local private values without printing them', async () => {
  await fixture(async (directory) => {
    const privateValue = `synthetic_private_${randomBytes(24).toString('hex')}`;
    await writeFile(path.join(directory, '.env'), `NASA_API_KEY=${privateValue}\n`);
    await writeFile(path.join(directory, 'accidental-copy.txt'), privateValue);
    assert.ok(audit(directory, privateValue).failures.includes('known-private-value'));
  });
});

test('publication audit detects an index leak after the working file is scrubbed', async () => {
  await fixture(async (directory) => {
    const privateValue = `synthetic_private_${randomBytes(24).toString('hex')}`;
    await writeFile(path.join(directory, '.env'), `NASA_API_KEY=${privateValue}\n`);
    await writeFile(path.join(directory, 'document.txt'), privateValue);
    git(directory, ['add', 'document.txt']);
    await writeFile(path.join(directory, 'document.txt'), 'Now safe in the working tree.\n');
    const result = audit(directory, privateValue);
    assert.equal(result.indexBlobs, 1);
    assert.ok(result.failures.includes('known-private-value'));
  });
});

test('publication audit detects secrets retained only in reachable commit history', async () => {
  await fixture(async (directory) => {
    const privateValue = `synthetic_private_${randomBytes(24).toString('hex')}`;
    await writeFile(path.join(directory, '.env'), `NASA_API_KEY=${privateValue}\n`);
    await writeFile(path.join(directory, 'document.txt'), privateValue);
    git(directory, ['add', 'document.txt']);
    const commit = [
      '-c',
      'user.name=Privacy Test',
      '-c',
      'user.email=privacy-test@example.invalid',
      'commit',
      '--quiet',
      '--no-gpg-sign',
      '-m',
    ];
    git(directory, [...commit, 'Synthetic fixture']);
    await writeFile(path.join(directory, 'document.txt'), 'Scrubbed file.\n');
    git(directory, ['add', 'document.txt']);
    git(directory, [...commit, 'Scrub synthetic fixture']);
    const result = audit(directory, privateValue);
    assert.equal(result.commits, 2);
    assert.ok(result.failures.includes('known-private-value'));
  });
});

test('publication audit rejects forced private paths even if their files are empty', async () => {
  await fixture(async (directory) => {
    await writeFile(path.join(directory, '.env'), '');
    git(directory, ['add', '--force', '.env']);
    assert.ok(audit(directory).failures.includes('private-path-in-index'));
  });
});

test('publication audit detects recognized credentials without a local comparison value', async () => {
  await fixture(async (directory) => {
    const syntheticToken = ['gh', 'p_', randomBytes(24).toString('hex')].join('');
    await writeFile(path.join(directory, 'document.txt'), syntheticToken);
    assert.ok(audit(directory, syntheticToken).failures.includes('recognized-credential-format'));
  });
});
