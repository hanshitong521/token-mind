# shejiuPro live Token-Mind bench

date: 2026-08-30 14:07
token estimate = chars/4; content omitted on purpose.

| case | raw tok | RTK tok | RTK save | CC bal tok | CC save | note |
|---|---:|---:|---:|---:|---:|---|
| git_status | 227 | 118 | 48% | 227 | 0% |  |
| git_log_40 | 248 | 248 | 0% | 248 | 0% |  |
| git_diff_stat | 85 | 85 | 0% | 85 | 0% |  |
| git_diff | 1475 | 1053 | 29% | 1401 | 5% | raw_chars=5900 |
| java_tree_product | 18435 | 0 | 100% | 18435 | 0% |  |
| java_serviceimpl | 15911 | 15911 | 0% | 15911 | 0% | lines=1660 |
| mvn_success_noise | 2017 | 25 | 99% | 44 | 98% |  |
| cursor_rules_all | 974 | 52 | 95% | 974 | 0% |  |

**合计** raw=39372  RTK=17492 (55.6% save)  CC balanced=37325 (5.2% save)

## Save-The-Token eval (instruction layer)

exit=0
```
{
  "task_query": "fix NullPointerException in TRedPacketTaskServiceImpl red packet create",
  "required_terms": [
    "create",
    "fix",
    "nullpointerexception",
    "packet",
    "red",
    "tredpackettaskserviceimpl"
  ],
  "variants": [
    {
      "name": "full_context",
      "estimated_tokens": 46,
      "selected_evidence_recall": 0.0,
      "missing_fact_count": 0,
      "sufficiency_status": "insufficient",
      "preserved_terms": [],
      "missing_terms": [
        "create",
        "fix",
        "nullpointerexception",
        "packet",
        "red",
        "tredpackettaskserviceimpl"
      ]
    },
    {
      "name": "selected_context",
      "estimated_tokens": 0,
      "selected_evidence_recall": 0.0,
      "missing_fact_count": 1,
      "sufficiency_status": "insufficient",
      "preserved_terms": [],
      "missing_terms": [
        "create",
        "fix",
        "nullpointerexception",
        "packet",
        "red",
        "tredpackettaskserviceimpl"
      ]
    },
    {
      "name": "compressed_context",
      "estimated_tokens": 0,
      "selected_evidence_recall": 0.0,
      "missing_fact_count": 1,
      "sufficiency_status": "insufficient",
      "preserved_terms": [],
      "missing_terms": [
        "create",
        "fix",
        "nullpointerexception",
        "packet",
        "red",
        "tredpackettaskserviceimpl"
      ]
    },
    {
      "name": "reordered_context",
      "estimated_tokens": 1,
      "selected_evidence_recall": 0.0,
      "missing_fact_count": 2,
      "sufficiency_status": "insufficient",
      "preserved_terms": [],
      "missing_terms": [
        "create",
        "fix",
        "nullpointerexception",
        "packet",
        "red",
        "tredpackettaskserviceimpl"
      ]
    }
  ],
  "regressions": [],
  "method": "deterministic-token-budget-eval"
}

```
