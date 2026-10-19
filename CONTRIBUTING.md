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

**One-time release-owner exception: v1.5.2 (PR #256).** The release owner
explicitly chose `1.5.2` to keep PR #252 and PR #261 in the existing `1.5` release series,
overriding the computed minor version. For this release only, the feature and
its documented breaking behavior may ship under a patch number. This is a
versioning-policy exception, not a claim of SemVer patch compatibility; the
normal feature/minor and breaking/major rules above remain in force for future
releases. Consumers using `~1.5.1` or patch-only updates can receive the new
default-on tool-preview uploads, visible to all target-document readers, and
ordinary IM timeout cancellation that discards late replies. Check explicit
`dispatchTimeoutMs` settings for unintended early cancellation.
Deploy the companion receipt endpoint and event-table migrations first; review
the upload audience or set `docTaskProgress: false` before upgrading, accounting
for per-account overrides. Preserve this decision and the upgrade requirements
in the PR and versioned release notes. See [RELEASE.md](RELEASE.md) for the full
exception. Review approval, required checks and branch protection still apply.

**Current unreleased behavior after PR #270:** the v1.5.2 paragraph above is
historical. Ordinary IM `dispatchTimeoutMs` now releases only the inbound queue;
it neither cancels the agent nor discards late replies. Without an explicit
queue override, use the host's public execution timeout plus 60 seconds. If
neither the host API nor config provides a timeout, retain the 11-minute queue
fallback; explicitly unlimited execution uses a 30-minute queue wait. Neither
fallback is an agent execution deadline. Host execution limits, account-stop
cancellation and document-task cancellation policies still apply. Describe this
restoration from the Unreleased changelog in the next release; preserve the
published v1.5.2 history and document-upload upgrade requirements above.

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
bumps **all five** of these, then get it reviewed and merged:

1. `package.json`
2. `package-lock.json` (both the top-level `version` and `packages[""].version` —
   `npm install --package-lock-only` does it)
3. `src/version.ts` (via `npm run build`; the `prebuild` script writes it — do not hand-edit)
4. `CHANGELOG.md` (hand-written prose section, see RELEASE.md)
5. `.release-please-manifest.json`

Then `git tag vX.Y.Z && git push origin vX.Y.Z` from the merged commit.
`publish-clawhub.yml` enforces `package.json == tag`, so the bump MUST land on main first.

**Do not skip #5.** release-please reads `.release-please-manifest.json` at the tip of
the target branch as its source of truth for "last released version". Leave it behind and
the next automated run still believes the previous version is current: it rescans commits
that already shipped, proposes a release PR for a version that is already tagged and
already on ClawHub, and the tag creation then collides — so the genuinely new fix never
ships. Like the parse failure above, this surfaces only as a line in the run log, not as
a red workflow. Cross-check against the previous release commit (`git show --stat <sha>`);
it should touch exactly these five files.

## Code style

- TypeScript strict mode is enabled.
- No external linter/formatter is configured yet — match the existing style.
- Prefer explicit types over `any` where feasible.

## Reporting issues

Open an issue at https://github.com/Mininglamp-OSS/openclaw-channel-octo/issues.
