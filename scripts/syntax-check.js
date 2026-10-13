'use strict';

/**
 * Syntax check for every JavaScript file in the project.
 *
 * Runs `node --check` against each file, which parses without executing, so a
 * typo in a rarely used command is caught before deployment. Exits non-zero on
 * the first batch of failures so it can gate a deploy step.
 *
 * Usage: npm run check
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TARGETS = ['src', 'scripts', 'cloudflare/worker/src'];
const IGNORED_DIRS = new Set(['node_modules', '.git', '.wrangler', 'logs']);

/** Collect .js and .mjs files under a directory. */
function collect(directory, output) {
  if (!fs.existsSync(directory)) return output;

  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (IGNORED_DIRS.has(entry.name)) continue;
    const full = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      collect(full, output);
      continue;
    }
    if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs') || entry.name.endsWith('.cjs')) {
      output.push(full);
    }
  }
  return output;
}

function main() {
  const files = [];
  for (const target of TARGETS) collect(path.join(ROOT, target), files);

  let failures = 0;
  const problems = [];

  for (const file of files) {
    try {
      execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    } catch (error) {
      failures += 1;
      const details = (error.stderr || Buffer.from('')).toString().split('\n').slice(0, 4).join('\n');
      problems.push(`${path.relative(ROOT, file)}\n${details}`);
    }
  }

  if (failures > 0) {
    console.error(`Syntax check failed for ${failures} of ${files.length} files:\n`);
    for (const problem of problems) console.error(problem);
    process.exit(1);
  }

  console.log(`Syntax check passed for ${files.length} files.`);
}

main();
