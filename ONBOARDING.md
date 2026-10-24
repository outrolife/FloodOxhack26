# Onboarding: first session in this repo

Two audiences: the **human** does the first three steps once. **Claude** does the rest on its first prompt, whenever the team board says "NEW SESSION, NO IDENTITY".

## Human: once per machine
1. Clone the repo and switch to `main`:
   ```
   git clone https://github.com/outrolife/FloodOxhack26.git && cd FloodOxhack26 && git checkout main
   ```
2. Install and log in to the GitHub CLI. `gh auth login` is interactive, so run it yourself, not through Claude:
   ```
   brew install gh && gh auth login
   ```
3. Start `claude` in the repo folder and accept the prompt to trust the project's hooks. Then type anything. Claude will take it from there.

## Claude: first prompt of a new session
Do these in order, then carry on with whatever the human asked.

1. **Check the tools.** Run `gh auth status`. If it fails, stop and ask the human to run `gh auth login` (they can type `! gh auth login` into this prompt). Make sure the branch is not the old `agent/magenta/claude-workflow`. If it is, run `git checkout main && git pull`.
2. **Ask the human two questions in one message:**
   - Their first name.
   - Their role: Data, Model, App or Story (SPEC.md §12), or Observer. Say which roles already appear on the board, so two people don't take the same one by accident.
   - **If they choose Observer**, register them (step 4) and then follow **OBSERVER.md** instead of steps 5–7: Observers don't claim issues or write project code.
3. **Pick the session name.**
   - Use the person's first name, lower-case: `sam`.
   - If the person already has another Claude running, add a suffix: `sam-2`, or the area, `sam-web`.
   - Never reuse another person's name. If `whoami` says the name is taken by someone else, add a suffix or an initial: `sam-k`. Use `--force` only when the existing entry is the same person on another machine.
4. **Register:** `python3 scripts/status.py whoami <name> <Role>`
5. **Find work.** Run `gh issue list --label <role-label> --state open`, where the role label is `data`, `model`, `app` or `story`. Skip issues labelled `in-progress`. Suggest the highest-priority unclaimed one (P0 before P1 before P2; `stretch` only after the core gate in SPEC.md §13). Ask the human to confirm before you claim it.
6. **Claim it**, following CLAUDE.md "Team coordination" rule 3:
   ```
   gh issue edit <n> --add-assignee @me --add-label in-progress
   git checkout -b <role>/<short-name>
   python3 scripts/status.py set --state working --issue "#<n>" --task "<one line>" --next "<one line>"
   ```
7. **Read the spec section for that issue** before writing code. From then on, follow CLAUDE.md.

## Running more than one Claude
Each Claude needs its own name. The name is stored per folder in `.claude/agent.json`, which git ignores. So either:
- use a separate clone or `git worktree` for each Claude, and run step 4 in each one, or
- start the second Claude in the same folder with an override: `RC_AGENT=sam-2 claude`.
