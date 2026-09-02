# Shell first-layer corrected A/B (Q3 retest)

date: 2026-09-01 15:04  |  token = chars/4  |  CC = balanced + --cmd  |  RTK 0.46
excludes non-shell-owner cases (ServiceImpl source, dir listing) — see DECISIONS-2026-09-01 3C.

| case | raw tok | CC tok | CC save | RTK tok | RTK save |
|---|---:|---:|---:|---:|---:|
| git_status | 63 | 46 | 27% | 14 | 78% |
| git_log_40 | 239 | 239 | 0% | 239 | 0% |
| git_diff_large | 104413 | 1785 | 98% | 0 | 100% |
| mvn_success_noise | 2007 | 44 | 98% | 25 | 99% |
| pytest_fail | 2597 | 102 | 96% | 72 | 97% |
| java_stacktrace | 623 | 623 | 0% | 11 | 98% |

**TOTAL** raw=109942  CC=2839 (97%)  RTK=361 (100%)

## failure-path fidelity (CC balanced, spec P5/P12)

- PASS: pytest_fail preserved assertion+test name
- PASS: java_stacktrace preserved exception+frame
