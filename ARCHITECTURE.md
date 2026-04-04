# Architecture

English · [한국어](./ARCHITECTURE.kr.md)

## Product model

Har-Nessie is a local web harness for long-running project work.
It is not designed around a single prompt. It is designed around continuity.

The working model is:

`project -> phase -> run -> task`

## Main ideas

1. The human owns goals and approval gates.
2. The harness owns state, scope, verification, and recovery.
3. Docs and repo context should shape the next run, not disappear after the last one.
4. Local machine settings can guide the harness without mutating the repo itself.

## Harness engineering angle

Har-Nessie treats the model as one component inside a larger control system.
The useful behavior comes from the loop around the model:

- preflight and trust scoring before execution
- docs and repo state as structured context
- mechanical verification after execution
- review, recovery, and continuation after a result exists

That is the difference between "an agent answered" and "a run is actually operable."

## Runtime shape

```text
User
  -> Local Web UI
  -> project analysis / run creation
  -> clarify / approval / retry / resume

Web app
  -> app/server.mjs
  -> app/orchestrator.mjs
  -> app/project-workflow.mjs
  -> app/project-health.mjs
  -> app/project-intel.mjs
  -> app/memory-store.mjs

Filesystem
  -> runs/<run-id>/*
  -> projects/<project-id>/*
  -> memory/projects/<project-key>/*
```

## Main runtime layers

- `server.mjs`
  - local HTTP API and UI entry
- `orchestrator.mjs`
  - run loop coordination and runtime dispatch
- `project-workflow.mjs`
  - intake and preflight workflow helpers
- `project-health.mjs`
  - project health, continuity, and long-running checks
- `project-intel.mjs`
  - project analysis and document discovery
- `memory-store.mjs`
  - long-lived memory and retrieval

## What happens in a run

1. the operator defines a goal and project path
2. preflight checks environment and trust level
3. Har-Nessie builds context from docs, repo state, and local harness settings
4. clarify runs if the scope is still loose
5. a plan is produced
6. a person approves or adjusts the plan
7. tasks execute
8. verification runs
9. review and goal checks decide whether to continue
10. useful context is written back into project memory

## Why projects matter

The project container is what makes long-running work practical.
It keeps:

- defaults
- phases
- carry-over behavior
- project memory
- continuity signals for the next run

Without that layer, every run would have to rediscover the same context.

## Verification model

Har-Nessie does not rely on model judgment alone.
It combines:

- agent review
- harness-enforced rules
- recorded verification evidence

That is why the UI can show proof instead of only intent.

## Continuity model

Long-running work is not treated as a chain of unrelated prompts.
The harness keeps continuity through:

- project memory
- carry-over work
- docs drift signals
- suggested next run drafts
- phase and project health surfaces
