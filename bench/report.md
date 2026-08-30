# Token Tool Bench — measured results

date: 2026-08-30 13:27

| case | raw tok | RTK tok | RTK save | RTK lost | CC balanced tok | save | lost | CC aggressive tok | save | lost |
|---|---:|---:|---:|---|---:|---:|---|---:|---:|---|
| git_status | 376 | 309 | 18% | LOST: modified: | 326 | 13% | OK | 288 | 23% | LOST: modified: |
| git_log_40 | 477 | 477 | 0% | LOST: second commit | 477 | 0% | LOST: second commit | 477 | 0% | LOST: second commit |
| grep_hit | 22 | 22 | 0% | OK | 22 | 0% | OK | 23 | -7% | OK |
| build_success_log | 14624 | 26 | 100% | LOST: BUILD SUCCESS; Total time:  42.817 s | 45 | 100% | OK | 45 | 100% | OK |
| pytest_fail_log | 2597 | 74 | 97% | LOST: 1 failed, 127 passed | 102 | 96% | OK | 102 | 96% | OK |
| java_stacktrace_log | 623 | 25 | 96% | LOST: java.lang.NullPointerException; OrderServiceImpl.applyDiscount(OrderServiceImpl.java:142); OrderController.checkout(OrderController.java:87) | 623 | 0% | OK | 623 | 0% | OK |
| big_log | 88802 | 109 | 100% | LOST: req-002747 | 1524 | 98% | LOST: req-002747 | 1524 | 98% | LOST: req-002747 |
| jest_fail_log | 1269 | 46 | 96% | LOST: 2 failed, 125 passed, 127 total; FAIL src/orders/discount.test.ts; expect(received).toBe(expected) | 159 | 87% | OK | 159 | 87% | OK |
| source_read | 96 | 96 | 0% | OK | 96 | 0% | OK | 96 | 0% | OK |

## Weighted totals (char-based)

- raw total: 435555 chars (~108888 tok)
- RTK: 4747 chars, saving 98.9%
- CC balanced: 13504 chars, saving 96.9%
- CC aggressive: 13357 chars, saving 96.9%

token estimate = chars / 4; saving measured on cleaned (ANSI-stripped) output.
