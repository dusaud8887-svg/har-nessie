# User Guide

English · [한국어](./USER_GUIDE.kr.md)

## The shortest way to think about Har-Nessie

You give it a project folder and a goal.
It helps turn that into a run, keeps the work grounded in docs and repo state, and carries useful context into the next run.

The important idea is that Har-Nessie is a harness, not just a model wrapper.
It tries to make work visible before, during, and after a run.

## Recommended first-time flow

1. Start the app with `harness.cmd` or `./harness.sh`.
2. Open the local URL.
3. Click `New Project`.
4. If you already have a repo or docs, click `Project Analysis`.
5. Review the recommended docs and the first-run draft.
6. Use `Recommended: Create project + first run`.

That path is the easiest way to start with an existing codebase.

## Project vs run

- `Project`
  - the long-lived container
  - keeps defaults, phases, carry-over work, and memory
- `Run`
  - one focused working session inside a project
  - can be intake, implementation, recovery, or cleanup

If the work will continue later, keep using the same project.

## What an intake run is

An `*-intake` run is a setup and alignment run.
It usually answers:

- what should happen first
- which docs matter
- what counts as done
- whether docs should be updated too

It is normal for an intake run to ask questions before it starts implementation.

## How to answer clarify questions

Keep it short and plain.

Good answers usually say:

- what you want
- what you do not want
- whether docs should be updated

Example:

`Use the recommended path, keep the scope tight, and update the docs too.`

## How to read the run overview

The top cards matter most:

- `Autonomy Score`
  - how safe it is to hand off
- `Proof of Work`
  - what actually got verified
- `Context Engine`
  - how much useful project context is attached
- `Recovery Loop`
  - whether the run is likely to need intervention

If you only read a few things, read those first.
That is the shortest version of the harness idea: trust, proof, context, recovery.

## Mid-project continuation

When a project keeps going:

- use `Suggested next run draft` first
- use `Re-analyze and open draft` when docs changed a lot
- check `Long-running checks` for drift, repeated failures, and continuity warnings
- use `Next phase / re-entry` when the work is moving into a new phase

## Approval

Most of the time you only need to confirm:

- the goal is correct
- protected areas are respected
- the first task makes sense

Use `Request plan changes` only when the plan is clearly off-scope, unsafe, or missing a major constraint.

## Settings most people can leave alone

For a normal local setup, defaults are usually enough:

- planning provider: whichever CLI you have installed
- implementation provider: same, or a different one if you want to mix
- runtime profile: `Go now`
- UI language: `English`
- agent response language: `English`

## When to re-analyze

Use project re-analysis when:

- docs changed a lot
- the project direction changed
- the run draft no longer matches reality
- you want a fresh intake based on the latest repo state

## When to stop and review manually

Pause and look more closely when:

- autonomy trust drops to `Human check first`
- protected areas are missing
- the project folder is dirty and worktree isolation is unavailable
- the plan looks broader than the goal
- the run failed in the same way more than once
