# Claude Code Instructions

## Git Workflow

After every commit, always push changes to `main`:
1. Commit on the working branch.
2. Merge the working branch into `main` and push: `git checkout main && git merge <branch> && git push origin main && git checkout <branch>`.

If there is no separate feature branch (already on `main`), just `git push origin main` after each commit.
