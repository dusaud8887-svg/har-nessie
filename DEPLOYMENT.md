# Deployment

English · [한국어](./DEPLOYMENT.kr.md)

## Supported deployment style

Har-Nessie is meant to run as a local app.
The normal ways to share it are:

1. via Git
2. via a shared folder or zip

Cloud hosting is not the default model.

## Git-based sharing

Best when:

- the team already uses Git
- updates and history matter

Recommended flow:

1. clone or pull the repo
2. run `harness.cmd` on Windows or `./harness.sh` on macOS/Linux
3. open the web UI locally

Keep this machine-local state separate from normal code replacement:

- `memory/`
- `runs/`
- `projects/`
- `.harness-web/settings.json`

## Folder or zip handoff

Best when:

- the recipient is not using Git
- you just want to hand over a working folder

Recommended flow:

1. share the folder or zip
2. unpack locally
3. run the launcher

If the execute bit is missing on macOS/Linux:

```bash
chmod +x harness.sh
```

## Updating safely

When moving to a newer version:

1. replace code and public docs
2. keep local state separately
3. back up local state before risky upgrades

Usually worth preserving:

- `memory/`
- `.harness-web/settings.json`

Optional:

- `runs/`
- `projects/`

## CLI provider support

All three CLIs work equally. There is no default.

| CLI | How to get it |
|-----|---------------|
| Codex CLI | `npm i -g @openai/codex` — ChatGPT Plus or Pro |
| Claude Code | `npm i -g @anthropic-ai/claude-code` — Anthropic subscription |
| Gemini CLI | `npm i -g @google/gemini-cli` — Google account |

Install whichever you have. You can use different CLIs for planning and implementation in the same run.
The deployment package itself does not require any specific CLI — only the one(s) you choose to use.

## Public document set

- [README.md](./README.md)
- [USER_GUIDE.md](./USER_GUIDE.md)
- [OPERATIONS.md](./OPERATIONS.md)
- [ARCHITECTURE.md](./ARCHITECTURE.md)
