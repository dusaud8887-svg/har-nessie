# Operations

English · [한국어](./OPERATIONS.kr.md)

## Before starting a run

- Node.js 22+ is available
- at least one CLI is installed and authenticated (Codex, Claude Code, or Gemini CLI)
- the project folder is trusted
- if it is a git repo, check whether the working tree is clean

## How to read preflight

- `Safe to automate`
  - good to hand off now
- `Use with caution`
  - probably runnable, but warnings matter
- `Human check first`
  - do not treat this as safe automation yet

`blockers` stop the run.
`warnings` do not always stop the run, but they reduce trust.

## Common issues

### Node is missing

- install Node.js 22+
- reopen the terminal
- run the launcher again

### CLI is missing or not authenticated

Har-Nessie needs at least one CLI installed and authenticated.
Install whichever you have:

- Codex CLI: `npm i -g @openai/codex` — requires ChatGPT Plus or Pro
- Claude Code: `npm i -g @anthropic-ai/claude-code` — requires Anthropic subscription
- Gemini CLI: `npm i -g @google/gemini-cli` — requires Google account

After installing, authenticate with the CLI's own login command, then rerun diagnostics.

### Folder picker does not open

- type the path manually
- on Linux, make sure `zenity`, `qarma`, or `kdialog` exists if you expect a native picker
- on macOS, check `osascript`

### `harness.sh` permission denied

- run `chmod +x harness.sh`
- try again

### Dirty repo

Impact:

- worktree isolation may be unavailable
- tasks may run in the shared workspace instead
- even if a preset prefers parallel execution, the live run may downgrade to one task at a time for safety

Preferred fix:

- commit, stash, or move the work first

### Path is too long

This is mostly a Windows problem.
It can affect worktree setup or patch application.

Preferred fix:

- move the repo to a shorter path like `C:\work\repo`

### Text looks broken

Supported text decoding includes:

- UTF-8
- UTF-8 BOM
- UTF-16 LE / BE

PDF intake is text-extraction based, not OCR based.
Scanned PDFs may not yield usable text.

### A run is waiting for input

If the run enters `needs_input`:

- answer briefly
- describe the goal, limits, and whether docs should change too

### A run is waiting for approval

If the run enters `needs_approval`:

- approve when the goal and first task look right
- request changes when the scope or protected areas are wrong

### A task failed

Check these in order:

1. `Proof of Work`
2. runtime observability
3. review summary

Then choose one:

- retry the same plan
- replan with a smaller scope
- exclude it from the current goal

### The project needs another run

Use:

- `Suggested next run draft`
- `Re-analyze and open draft` when docs changed a lot
- `Long-running checks` for drift and repeated failures

## Useful local paths

- run state: `runs/<run-id>/state.json`
- run logs: `runs/<run-id>/logs.ndjson`
- task artifacts: `runs/<run-id>/tasks/<task-id>/`
- project memory: `memory/projects/<project-key>/`
- machine-local settings: `.harness-web/settings.json`

## Runtime profiles

- `Go now`
  - fastest local path
- `Approval requested`
  - more conservative
- `Read-only`
  - best when you want inspection before edits

Additional notes:

- The `Docs and Spec First` preset can use limited parallelism (`2` tasks at a time) when the git repo is clean.
- If the repo is dirty and falls back to the shared workspace, the same preset automatically downgrades to sequential execution.
