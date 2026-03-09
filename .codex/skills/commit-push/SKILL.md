---
name: commit-push
description: Commit and push existing Git changes without modifying files; use when asked to stage all changes (new/modified/deleted), generate a clear commit message, commit, and push.
---

# Commit and Push Changes (No File Modification)

## Rules

- Do not modify, format, or edit any file contents.
- Stage all changes, including new, modified, and deleted files.
- Generate a clear, professional commit message from the actual changes.
- Commit the staged changes.
- Push to the remote repository (default branch unless the user specifies otherwise).

## Workflow

1. Inspect repository status to see staged and unstaged changes.
2. Stage everything with a single add command that captures new, modified, and deleted files.
3. Review staged changes to inform the commit message.
4. Compose a commit message:
   - Short title (<= 70 characters).
   - Blank line.
   - Bullet list of meaningful change summaries.
5. Create the commit with the generated message.
6. Push to the default remote/branch unless the user specifies a target.

## Commit Message Template

chore: <short, specific title>

- <Added/Updated/Removed/Refactored> <thing> <why/what>
- <Added/Updated/Removed/Refactored> <thing> <why/what>

## Notes

- If there are no changes, report that and stop.
- If the remote or branch is ambiguous, ask the user before pushing.
- Never edit files to fix linting or formatting as part of this flow.
