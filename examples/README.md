# Example ICP profiles

These are **illustrations**, not defaults — the plugin ships with no built-in target. They
show what an agent composes after talking to a user. Load one with:

```
bin/lk profile set --file examples/dental-clinics-us.json
bin/lk campaign --mode people --pages 3
bin/lk export
```

Flags still override the file (e.g. `--geo "United Kingdom"` to retarget the same ICP).

## `dental-clinics-us.json`
Selling a patient-scheduling SaaS to **independent dental & dermatology clinics** in the US.
A deliberately non-tech domain that exercises every override:
- custom **keywords** (practice owner / manager / DSO terms),
- a US **geo** filter,
- custom **scoreRules** (owner > ops > multi-site),
- custom **classification groups** (`owner_clinician` / `practice_ops` / `other`) instead of
  the generic role tiers — so the CSVs split by what matters for *this* outreach.

To build your own, copy this file and rewrite the four fields, or just describe your target
to the agent and let it compose the profile for you.
