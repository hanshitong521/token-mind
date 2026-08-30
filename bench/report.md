# Token Tool Bench — measured results

date: 2026-08-29 22:52

| case | raw tok | RTK tok | RTK save | RTK lost | CC balanced tok | save | lost | CC aggressive tok | save | lost |
|---|---:|---:|---:|---|---:|---:|---|---:|---:|---|
| git_status | 376 | 309 | 18% | LOST: modified: | 326 | 13% | OK | 288 | 23% | LOST: modified: |
| git_log_40 | 477 | 477 | 0% | LOST: second commit | 477 | 0% | LOST: second commit | 477 | 0% | LOST: second commit |
| grep_hit | 26 | 26 | 0% | OK | 26 | 0% | OK | 27 | -3% | OK |
| build_success_log | 14624 | 26 | 100% | LOST: BUILD SUCCESS; Total time:  42.817 s | 157 | 99% | OK | 157 | 99% | OK |
| pytest_fail_log | 2597 | 74 | 97% | LOST: 1 failed, 127 passed | 2597 | 0% | OK | 2597 | 0% | OK |
| java_stacktrace_log | 623 | 25 | 96% | LOST: java.lang.NullPointerException; OrderServiceImpl.applyDiscount(OrderServiceImpl.java:142); OrderController.checkout(OrderController.java:87) | 623 | 0% | OK | 623 | 0% | OK |
| big_log | 88802 | 109 | 100% | LOST: req-002747 | 1524 | 98% | LOST: req-002747 | 1524 | 98% | LOST: req-002747 |
| source_read | 96 | 96 | 0% | OK | 96 | 0% | OK | 96 | 0% | OK |

## Weighted totals (char-based)

- raw total: 430496 chars (~107624 tok)
- RTK: 4582 chars, saving 98.9%
- CC balanced: 23315 chars, saving 94.6%
- CC aggressive: 23165 chars, saving 94.6%

token estimate = chars / 4; saving measured on cleaned (ANSI-stripped) output.
