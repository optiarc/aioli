---
name: commit-push-split
description: "Create X discrete git commits by grouping existing repository changes into logical parts, then push. Use when asked to split changes into multiple commits, to stage and commit groups without modifying files, and to push once after all commits are created."
---

# Split, Commit, Push

## Rules

- Do not modify, format, or edit any file contents.
- Do not create a single giant commit unless splitting is unsafe.
- Prefer fewer, coherent commits over many noisy commits.

## Inputs

- X = number of commits to create. If not provided, choose a sensible X (2 to 6) based on change boundaries.

## Workflow

### 1) Discover changes

- Run `git status --porcelain=v1`.
- Run `git diff` and `git diff --staged`.
- Capture new, deleted, and renamed files from status.
- Summarize changed files with rough intent.

### 2) Propose commit groups

- Partition changes into X logical groups that are independently buildable or testable when possible.
- Use these heuristics when helpful:
  - Separate refactors from functional changes.
  - Separate formatting or lint-only changes from behavior changes.
  - Separate docs, config, or CI from application code.
  - Group by feature area, module, or directory.
  - Keep deletes with the commit that removes related functionality.
- If exactly X commits would be unsafe or nonsensical, use the closest sensible number and explain why.

### 3) Execute commits (repeat for each group)

1. Reset staging: `git reset`.
2. Confirm clean staging: `git status --porcelain=v1` shows no staged entries.
3. Stage only the group files:
   - `git add <files...>`
   - Use `git add -p <file>` for mixed concerns; do not edit hunks.
   - For deletions: `git rm <file>`.
   - For renames: use `git mv` only if the rename already exists in the working tree.
4. Validate staged diff: `git diff --staged`.
   - If unrelated hunks appear, unstage with `git reset -p` or `git restore --staged` and re-stage.
5. Commit with a clear message:
   - Title <= 70 characters, prefix encouraged (`feat`, `fix`, `chore`, `docs`, `refactor`, `test`).
   - Body as bullet list describing what changed and why.
6. Create commit: `git commit -m "<title>" -m "- ..."`.

### 4) Push once

- After all commits are created, run `git push` (default remote and branch unless specified).

## Output requirements

- Before executing, print the proposed commit plan: Group 1..N with included files and rationale.
- During execution, print each commit message and the files or hunks staged for that commit.
- Never alter file contents.
