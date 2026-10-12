import { execFileSync } from 'node:child_process';

// Build is an explicit prerequisite (pack:check and CI). Avoid a second build
// here, and parse the actual npm manifest rather than grepping mixed log output.
const packed = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'],
}));
const paths = new Set(packed[0].files.map(file => file.path));
const required = ['dist/index.js', 'dist/setup-entry.js', 'openclaw.plugin.json',
  'docs/ppt-contract.md', 'docs/doc-task-content-policy.md'];
const missing = required.filter(path => !paths.has(path));
if (missing.length) throw new Error('Package missing required files: ' + missing.join(', '));
console.log('Package verified: runtime entries, manifest, receipt contract and content policy.');
