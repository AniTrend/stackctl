# Contributing

When contributing to this repository, please first discuss the change you wish to make via a GitHub issue, email, or Discord with the owners of this repository before making a change.

Please note we have a [Code of Conduct](CODE_OF_CONDUCT.md), please follow it in all your interactions with the project.

## Issue Guidelines

- Search existing issues for duplicates before creating a new one.
- Keep individual issues for each suggestion, bug, or feature.
- Titles should use a scoped prefix for visibility, for example `[config] Harden profile merge order` or `[generate] Port idempotent stack generation`.
- Use labels for taxonomy such as `feature`, `bug`, `refactor`, or `docs` rather than encoding taxonomy into the title itself.

## Pull Request Guidelines

- Make individual pull requests for each issue, and link the issue in the PR description.
- PR titles follow the format `<type>(<scope>): <brief summary>` and stay aligned with the branch intent.
- Do not stage files excluded by `.gitignore`.
- Commits should reference relevant issues or other PRs.
- Automated pull requests should follow the same branch naming conventions as contributor PRs.

## Quality Standards

Exhaustive unit tests are mandatory for all PRs, demonstrating the cases guarded against and extent of coverage.

### Branch Naming

```
<type>/<issue-number>-<short-description>
```

When no issue number exists yet, use `<type>/<short-description>` temporarily and link the branch to the issue as soon as it is created.

Supported types:

- `feat` -- A new feature
- `fix` -- A bug fix
- `chore` -- Routine tasks, dependencies, and maintenance
- `docs` -- Documentation only changes
- `refactor` -- Code change that neither fixes a bug nor adds a feature
- `test` -- Adding missing or correcting existing tests
- `build` -- Changes that affect the build system or tooling
- `dependencies` -- Updating external dependencies (distinct from build-system changes)
- `ci` -- Changes to CI configuration or automation scripts
- `revert` -- Reverting a previous commit

Examples:

- `feat/1208-implement-override-merging`
- `fix/1177-template-drift-in-config-init`
- `docs/1234-update-contributing-guidelines`
- `ci/update-deno-version`

### Commit Messages

```
<type>(<scope>): <brief summary>
```

Scope should be a module area such as `config`, `generate`, `render`, `cli`, `docker`, `secrets`, or `project`.

Examples:

- `feat(config): add profile overlay discovery`
- `fix(render): handle nested $VAR without braces`
- `chore(project): pin Deno version in CI`
- `docs(contributing): clarify PR title format`

### Pull Request Titles

Use the same format `<type>(<scope>): <brief summary>` and keep the title consistent with the branch intent.

### Before Submitting

- Run `deno task check` (fmt, lint, type-check) and fix any issues.
- Run `deno task test` and confirm all tests pass (existing and new).
- Run `deno task coverage` and verify coverage targets are met (minimum 80% line coverage for `src/`).
- Verify that no secrets, credentials, or local paths were committed.

## Code of Conduct

See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) for our community standards and enforcement policies.

---

Thank you for your contribution!
