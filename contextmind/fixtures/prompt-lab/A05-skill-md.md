---
name: diagnose-bugs
description: Diagnose a hard bug or performance regression
---

# diagnose-bugs

## When to use
Use when a failure is reproducible but the cause is unknown.

## Procedure
1. Reproduce and capture the exact error.
2. Bisect the change range.
3. Confirm the root cause with a targeted experiment.
4. Fix, then verify with the original repro.

## Output
Report the root cause, the fix, and the evidence command output.
