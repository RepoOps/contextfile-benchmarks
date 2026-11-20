# Harness constants

The thresholds and tolerances the harness reads, copied from ContextFile's audited config table at commit f9a9a14138e8d87171d80f653cb2ada123c09894. Values marked Example are not yet confirmed by the operator.

| Constant | Value | Meaning |
| --- | --- | --- |
| `golden_pass_threshold` | 0.9 | Entailment score at or above which the golden-set harness counts a claim as passed by the judge. Example value. |
| `golden_min_precision` | 0.9 | Lowest precision (of claims the judge passed, the share labeled supported) a new judge version may show on the golden set and still merge. Example value. |
| `golden_min_recall` | 0.8 | Lowest recall (of supported claims, the share the judge passed) a new judge version may show on the golden set and still merge. Example value. |
| `golden_max_misgrounded_rate` | 0.05 | Highest share of misgrounded claims (cited passage does not support them) a new judge version may pass and still merge. Example value. |
| `golden_rerun_tolerance` | 0.02 | Largest absolute difference per metric between a published golden-set result and an outside rerun that still counts as a match (provider nondeterminism). Example value until measured. |
| `uplift_cadence_days` | 30 | Days after the newest published uplift scorecard result before the nightly cron reruns the harness and `/benchmarks` marks the scorecard stale. Example value (monthly). |
| `uplift_rerun_tolerance` | 0.05 | Largest absolute difference in task accuracy, per model and arm, between a published uplift result and an outside rerun that still counts as a match. Example value until reruns measure it. |
