# 011: Autonomous loops run by a supervisor with no model of its own

Status: accepted

## Context

Long autonomous jobs fail when a model is in charge of its own stopping,
budgeting and bookkeeping: it loops, overspends, or loses track after a crash.

## Options

1. A long single conversation with a "manager" model.
2. A deterministic supervisor that drives short, fresh model sessions.

## Decision

Option 2. Work lives in a dependency-ordered queue in SQLite. Each iteration
claims one ready task and runs it in a fresh context. Configured gates (tests,
typecheck) run one at a time; a green gate commits to git, a red gate
re-queues the task with the failure output, and three failures block it. The
supervisor owns budgets (predictive: an iteration that can't be afforded
doesn't start), iteration limits and a no-progress detector. Decisions are
journaled to `loop.jsonl` and `handoff.json`, so resuming after a crash costs
no tokens.

## Consequences

- Every unit of finished work is a commit that passed the gates.
- Tasks must be small enough to finish in one fresh context.
