# Contributing to openclaw-channel-octo

Thanks for your interest in contributing!

## Getting started

```bash
git clone https://github.com/Mininglamp-OSS/openclaw-channel-octo.git
cd openclaw-channel-octo
npm install
npm run type-check
npm test
```

## Development workflow

1. Create a feature branch from `main`.
2. Make your changes — keep commits focused and atomic.
3. Run `npm run type-check && npm test` before pushing.
4. Open a pull request against `main`.

## Commit message convention

This repo uses [Conventional Commits](https://www.conventionalcommits.org/) so that
the release tool (`release-please`) can auto-bump versions and generate the CHANGELOG.

PR titles (and squash-merge commit messages) must follow:

```
<type>(<optional scope>): <description>
```

| Type | Meaning | Goes into CHANGELOG? | Triggers version bump? |
|------|---------|----------------------|------------------------|
| `feat` | New feature | ✅ `### Added` | minor (or patch pre-1.0) |
| `fix` | Bug fix | ✅ `### Fixed` | patch |
| `perf` | Performance fix | ✅ `### Performance` | patch |
| `refactor` | Code restructuring, no behavior change | ✅ `### Internal` | patch |
| `revert` | Reverts a previous commit | ✅ `### Reverted` | patch |
| `chore`, `docs`, `test`, `build`, `ci` | Tooling / docs / infra | ❌ hidden | none |

Breaking change → add `!` after the type (`feat!: ...`) **or** include `BREAKING CHANGE:`
in the commit body. This triggers a major version bump.

Examples:
- `fix(inbound): set MediaPaths under Core-allowed root (#58)`
- `feat(richtext): bot adapter supports RichText=14`
- `feat!(api): rename apiUrl → baseUrl`

## Release process

Releases are PR-driven via [release-please](https://github.com/googleapis/release-please-action).
No one ever pushes a release commit directly to `main`.

### How it works

1. As conventional-commit PRs merge into `main`, the `release-please` workflow
   maintains a long-lived PR titled **`chore(release): release vX.Y.Z`**.
2. That PR contains, auto-generated from the merged commits:
   - `package.json` + `package-lock.json` version bumps
   - `src/version.ts` bump (via the `// x-release-please-version` marker)
   - A new `## [X.Y.Z]` section appended to `CHANGELOG.md` (release-please's
     node releaser emits headings like `## [X.Y.Z](compare-url) (YYYY-MM-DD)`,
     which differs slightly from the Keep a Changelog `## [X.Y.Z] - YYYY-MM-DD`
     headings written by hand for v1.0.x. Both forms coexist — the publish
     workflow's `extract-changelog.sh` substring-matches either.)
   - PR body = the release notes draft
3. When the release manager decides it's time to ship: **merge that PR** (squash, default).
4. `release-please` then creates the `vX.Y.Z` git tag and a GitHub Release.
5. The tag push triggers `publish-clawhub.yml`, which packages and uploads to ClawHub
   and attaches the tarball to the GitHub Release.

### What developers do

- Write good conventional-commit PR titles. That's it.
- Do **not** hand-edit `CHANGELOG.md` or bump `package.json` in feature PRs.
- The release PR shows up automatically; don't worry about it until release time.

### What the release manager does

- Watch for the `chore(release): release vX.Y.Z` PR to accumulate the desired set of changes.
- Merge it. The rest is automatic.

### About `src/version.ts`

`src/version.ts` is git-tracked but **has two writers**:

1. The `prebuild` script in `package.json` rewrites it from `package.json`'s
   version on every `npm run build`.
2. release-please rewrites it inside the release PR via the
   `// x-release-please-version` marker on line 2.

Both writers produce identical content as long as `package.json` and
`src/version.ts` are in sync (they always are, post-release-please-merge).
If you bump `package.json` manually and run `npm run build` locally, expect
a dirty working tree on `src/version.ts` — **include it in the same commit
as the `package.json` bump** (the manual-override path requires both).

Do not hand-edit `src/version.ts` — the comment at the top of the file says
so, and any manual edit will be overwritten by the next build.

### Manual override (rare)

If for some reason the release-please flow can't be used, open a regular PR that
bumps `package.json` + `package-lock.json` + `src/version.ts` + `CHANGELOG.md`,
get it reviewed and merged, then `git tag vX.Y.Z && git push origin vX.Y.Z` from
the merged commit. `publish-clawhub.yml` enforces `package.json == tag`, so the
bump MUST land on main first.

## Code style

- TypeScript strict mode is enabled.
- No external linter/formatter is configured yet — match the existing style.
- Prefer explicit types over `any` where feasible.

## Reporting issues

Open an issue at https://github.com/Mininglamp-OSS/openclaw-channel-octo/issues.
