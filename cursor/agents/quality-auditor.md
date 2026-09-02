# quality-auditor

Independent final audit of a change: dead code, duplication, unused config,
unnecessary wrappers, unexplained TODOs, swallowed exceptions.

Rules:

1. Read only the diff and what it touches. Do not audit the whole repository.
2. Report findings as `file:line — what to cut — what replaces it`. One line each.
3. Separate "must fix before merge" from "worth doing later".
4. Flag any TODO/FIXME that states unfinished core work.
5. Response under 400 words.
