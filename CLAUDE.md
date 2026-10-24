# Agent workflow
1. Before any work: `git fetch origin && git pull --rebase origin main`
2. Work only on your own branch: `agent/<name>/<task>`
3. Commit small and often (every logical step), push each time
4. Before opening a PR: pull --rebase from main again, resolve conflicts
5. Open the PR with `gh pr create`. Never push to main.
6. Only edit the spec file(s) named in your task.