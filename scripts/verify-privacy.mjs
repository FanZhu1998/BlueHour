// Local-only audit. Output is counts and fixed categories, never matched values.
// The working tree, exact index blobs and reachable history are independent.
import { readFile, readdir, lstat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { createRequire } from 'node:module';
import { parseEnv } from 'node:util';

const root = process.cwd();
const failures = new Set();
const counts = { workingFiles: 0, indexBlobs: 0, historyBlobs: 0, commits: 0, builtFiles: 0 };
const secrets = new Set();
const fail = (category) => failures.add(category);
const git = (args, encoding = 'utf8') =>
  execFileSync('git', args, {
    cwd: root,
    encoding,
    maxBuffer: 128 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
const splitZero = (value) => value.split('\0').filter(Boolean);

// Only code reads private values. Never print raw exceptions or Git output.
for (const entry of await readdir(root, { withFileTypes: true })) {
  if (entry.isFile() && /^\.env(?:\.|$)/i.test(entry.name) && entry.name !== '.env.example') {
    try {
      const values = parseEnv(await readFile(path.join(root, entry.name), 'utf8'));
      for (const value of Object.values(values)) if (value.length >= 8) secrets.add(value);
    } catch {
      fail('private-configuration-unreadable');
    }
  }
}
for (const [name, value] of Object.entries(process.env)) {
  if (/(?:API_?KEY|ACCESS_?TOKEN|AUTH_?TOKEN|PASSWORD|PRIVATE_?KEY|CLIENT_?SECRET)$/i.test(name)) {
    if (value && value.length >= 8) secrets.add(value);
  }
}
const patterns = [
  ...new Set(
    [...secrets].flatMap((value) => [
      value,
      encodeURIComponent(value),
      JSON.stringify(value).slice(1, -1),
      Buffer.from(value).toString('base64'),
    ]),
  ),
].flatMap((value) => [Buffer.from(value), Buffer.from(value, 'utf16le')]);

function privatePath(filename) {
  const parts = filename.replaceAll('\\', '/').split('/');
  const name = parts.at(-1).toLowerCase();
  return (
    (/(?:^\.|\.)env(?:\.|$)/i.test(name) && name !== '.env.example') ||
    name === '.envrc' ||
    /^(?:secret\.bin(?:\.pending)?|credentials(?:\.[^.]+)?|id_rsa|id_ed25519)$/i.test(name) ||
    /\.(?:secret|pem|p12|pfx|key|sqlite(?:3)?(?:-[a-z]+)?|db(?:-[a-z]+)?|log)$/i.test(name) ||
    parts.some((part) =>
      [
        'node_modules',
        'release',
        'artifacts',
        '.test-data',
        'test-results',
        'playwright-report',
      ].includes(part),
    )
  );
}
function entropy(value) {
  const frequencies = new Map();
  for (const character of value) frequencies.set(character, (frequencies.get(character) ?? 0) + 1);
  return [...frequencies.values()].reduce((result, count) => {
    const p = count / value.length;
    return result - p * Math.log2(p);
  }, 0);
}
function testFixture(value) {
  return value === 'DEMO_KEY' || /^(?:BLUE_HOUR_)?FAKE_[A-Z0-9_]+$/.test(value);
}
function inspect(bytes, { generic = true, example = false } = {}) {
  if (patterns.some((pattern) => bytes.includes(pattern))) fail('known-private-value');
  // Binary assets still undergo exact known-value comparisons.
  if (!generic || bytes.subarray(0, 8192).includes(0)) return;
  const source = bytes.toString('utf8');
  if (/-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/.test(source))
    fail('private-key-material');
  if (
    /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|xox[baprs]-[A-Za-z0-9-]{20,}|AKIA[0-9A-Z]{16}|AIza[A-Za-z0-9_-]{30,}|sk-(?:proj-|ant-)?[A-Za-z0-9_-]{24,})\b/.test(
      source,
    )
  )
    fail('recognized-credential-format');
  for (const match of source.matchAll(
    /\b(?:NASA_API_KEY|[A-Z0-9_]*(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|CLIENT_SECRET|PASSWORD)|apiKey|accessToken|clientSecret)\s*["']?\s*[:=]\s*["']?([A-Za-z0-9_+/.=-]{16,160})/g,
  )) {
    const value = match[1];
    if (
      !testFixture(value) &&
      /[a-z]/.test(value) &&
      /[A-Z0-9]/.test(value) &&
      entropy(value) >= 3.5
    )
      fail('credential-like-assignment');
  }
  // NASA keys commonly use 40 unprefixed alphanumeric characters; hexadecimal
  // Git identifiers are excluded. A match requires manual review before push.
  for (const match of source.matchAll(/(?:^|["'`\s=:])([A-Za-z0-9]{40})(?=$|["'`\s,;])/g)) {
    const value = match[1];
    if (
      !/^[a-f\d]+$/i.test(value) &&
      /[A-Z]/.test(value) &&
      /[a-z]/.test(value) &&
      /\d/.test(value) &&
      entropy(value) >= 4
    )
      fail('unprefixed-credential-format');
  }
  if (example) {
    try {
      if (Object.values(parseEnv(source)).some((value) => value !== '' && value !== 'DEMO_KEY'))
        fail('nonempty-environment-example');
    } catch {
      fail('invalid-environment-example');
    }
  }
}
const isText = (filename) =>
  !/\.(?:png|jpe?g|webp|gif|ico|woff2?|ttf|eot|pdf|exe|dll|zip|asar)$/i.test(filename);
const inspectFile = (bytes, filename) =>
  inspect(bytes, {
    generic: isText(filename),
    example: path.basename(filename) === '.env.example',
  });

try {
  const publishable = new Set(
    splitZero(git(['ls-files', '--cached', '--others', '--exclude-standard', '-z'])),
  );
  for (const filename of publishable) {
    if (privatePath(filename)) fail('private-path-in-publishable-files');
    const absolute = path.resolve(root, filename);
    if (!absolute.startsWith(`${root}${path.sep}`)) {
      fail('unexpected-publishable-path');
      continue;
    }
    if (!existsSync(absolute)) continue; // Deleted files remain audited in index/history.
    const info = await lstat(absolute);
    if (!info.isFile()) {
      fail('nonregular-publishable-file');
      continue;
    }
    inspectFile(await readFile(absolute), filename);
    counts.workingFiles++;
  }
  for (const entry of splitZero(git(['ls-files', '--stage', '-z']))) {
    const match = /^(\d+) ([a-f\d]+) (\d)\t([\s\S]+)$/.exec(entry);
    if (!match || !['100644', '100755'].includes(match[1]) || match[3] !== '0') {
      fail('unsupported-or-unmerged-index-entry');
      continue;
    }
    const filename = match[4];
    if (privatePath(filename)) fail('private-path-in-index');
    inspectFile(git(['cat-file', 'blob', match[2]], null), filename);
    counts.indexBlobs++;
  }
  const seenBlobs = new Set();
  const commits = git(['rev-list', '--all']).trim().split(/\r?\n/).filter(Boolean);
  for (const commit of commits) {
    inspect(git(['cat-file', 'commit', commit], null));
    counts.commits++;
    for (const entry of splitZero(git(['ls-tree', '-rz', '--full-tree', commit]))) {
      const match = /^(\d+) (blob|commit) ([a-f\d]+)\t([\s\S]+)$/.exec(entry);
      if (!match || match[2] !== 'blob' || !['100644', '100755'].includes(match[1])) {
        fail('unsupported-history-entry');
        continue;
      }
      const filename = match[4];
      if (privatePath(filename)) fail('private-path-in-history');
      const identity = `${match[3]}:${isText(filename)}:${path.basename(filename) === '.env.example'}`;
      if (seenBlobs.has(identity)) continue;
      seenBlobs.add(identity);
      inspectFile(git(['cat-file', 'blob', match[3]], null), filename);
      counts.historyBlobs++;
    }
  }
  async function walkBuilt(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) await walkBuilt(filename);
      else if (entry.isFile()) {
        if (privatePath(filename)) fail('private-path-in-build');
        inspectFile(await readFile(filename), filename);
        counts.builtFiles++;
      } else fail('nonregular-build-file');
    }
  }
  if (existsSync(path.join(root, 'dist'))) await walkBuilt(path.join(root, 'dist'));
} catch {
  fail('audit-could-not-complete');
}

const asarPath = path.join(root, 'release', 'win-unpacked', 'resources', 'app.asar');
let packagedArchiveChecked = false;
if (existsSync(asarPath)) {
  try {
    const require = createRequire(import.meta.url);
    const asar = require('@electron/asar');
    // Dependencies are expected inside ASAR, unlike source-control publication.
    for (const filename of asar.listPackage(asarPath)) {
      if (
        privatePath(
          filename.replaceAll('\\', '/').replace(/(^|\/)node_modules(?=\/|$)/g, '$1dependencies'),
        )
      )
        fail('private-path-in-package');
    }
    inspect(await readFile(asarPath), { generic: false });
    packagedArchiveChecked = true;
  } catch {
    fail('package-audit-could-not-complete');
  }
}
console.log(
  JSON.stringify({
    passed: failures.size === 0,
    ...counts,
    privateValuesComparedLocally: secrets.size > 0,
    packagedArchiveChecked,
    valuesPrinted: false,
    failures: [...failures].sort(),
  }),
);
process.exitCode = failures.size ? 1 : 0;
