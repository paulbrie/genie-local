---
name: eu-funding-fit
description: Find currently-open EU funding calls that fit a company, with adversarial deadline/fit verification
inputs: [company, profile, verticals, country, today]
steps:
  - agent: eu-funding-scout       # searches programmes, produces `candidates`
  - agent: eu-funding-verifier    # adversarially re-checks each, produces `verified`
  - agent: eu-funding-reporter    # buckets + ranks, produces `report`
---

Point this at a company. The **eu-funding-scout** searches Horizon Europe, the
Digital Europe Programme, EIC/EIT Digital, and national co-funded programmes for
open calls that fit the company's capabilities and verticals, extracting each as
a structured candidate. The **eu-funding-verifier** then independently re-checks
every candidate against the official source — is the deadline still open on
**{{today}}**, does the topic ID actually match the call fiche, and is the fit
real — reclassifying each into open-fit / open-not-actionable / closed / irrelevant
(this is the step that catches closed-but-listed and mislabeled calls). Finally the
**eu-funding-reporter** turns the verified set into a ranked, bucketed brief with a
recommendation, saved as `eu-funding-report.md`.

Because the context is **inclusive**, the reporter sees the original `candidates`,
the `verified` verdicts, and every input at once — so nothing gets promoted above
what verification actually confirmed.

Inputs:
- **company** — name + URL, e.g. `Evozon (evozon.com)`
- **profile** — capabilities, e.g. `custom software & outsourcing; AI/ML/data; QA`
- **verticals** — e.g. `fintech, healthcare, e-commerce, travel, publishing/media`
- **country** — home country for SME eligibility, e.g. `Romania`
- **today** — reference date `YYYY-MM-DD`; only calls with a deadline on/after this
  are treated as open.
