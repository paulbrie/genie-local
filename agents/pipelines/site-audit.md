---
name: site-audit
description: Scan a website URL, measure Core Web Vitals in a real browser, and return prioritized recommendations
inputs: [url]
steps:
  - agent: web-vitals-auditor   # loads {{url}}, produces `audit`
  - agent: perf-advisor         # reads `audit`, produces `recommendations`
---

Point this at a website URL. The **web-vitals-auditor** opens the page in a real
Chromium session (via the agent browser), measures **Core Web Vitals** (LCP, CLS,
INP, FCP, TTFB) plus network weight, console errors, accessibility, and SEO
basics, and returns a measured `audit`. The **perf-advisor** then reads that audit
and returns a prioritized, actionable set of `recommendations`.

Because the context is **inclusive**, the advisor sees both the original `url`
and the full `audit`, so every recommendation is tied to a measured number.

Note: this uses real-browser lab measurements from the server, not the Lighthouse
CLI (not installed) or real-user field data — so it reports actual metric values
and ratings rather than a single synthetic "Lighthouse score".
