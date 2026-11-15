'use strict';
// Syntax-checks every .js file in services/, shared/, tests/, scripts/ (and frontend vite config)
// with `node --check`. Exits non-zero on the first failure.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const roots = ['shared', 'services', 'tests', 'scripts', 'mock-psp-check'];
const files = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p);
    else if (entry.name.endsWith('.js')) files.push(p);
  }
}
for (const r of roots) {
  const abs = path.join(__dirname, '..', r);
  if (fs.existsSync(abs)) walk(abs);
}

let failures = 0;
for (const f of files) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
    console.log(`ok   ${path.relative(process.cwd(), f)}`);
  } catch (e) {
    failures++;
    console.error(`FAIL ${path.relative(process.cwd(), f)}\n${e.stderr?.toString() || e.message}`);
  }
}
if (failures) { console.error(`\n${failures} file(s) failed syntax check`); process.exit(1); }
console.log(`\n${files.length} files OK`);
