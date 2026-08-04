# QualityMax MCP demo — all four tools, one run

| # | Tool | What it produced here |
|:-:|------|------------------------|
| 1 | `scan_url` | 17 findings across 8 categories, graded, with measurements |
| 2 | `inspect_page` | 5 interactive elements, 1 form, role/name locators |
| 3 | `generate_playwright_repro` | `.qmax-mcp/repros/<generated>.spec.ts` |
| 4 | `run_playwright_test` | expected **failed** on Chromium |

---

# QA Scan — local QualityMax demo

**Grade: 🔴 F  (0 / 100)**   ·   17 issues found   ·   target: dependency-free loopback fixture

`░░░░░░░░░░░░░░░░░░░░░░░░` 0 / 100

| Category | Issues | Worst |
|----------|--------|:-----:|
| Console errors | `██░░░░░░░░` 1 | 🔴 high |
| Broken links | `██░░░░░░░░` 1 | 🟠 medium |
| Accessibility | `████████░░` 3 | 🔴 high |
| Performance | `░░░░░░░░░░` 0 | — |
| SEO | `██░░░░░░░░` 1 | 🟡 low |
| Security headers | `██████████` 4 | 🟠 medium |
| Cookies and trackers | `█████░░░░░` 2 | 🟠 medium |
| Mixed content | `██░░░░░░░░` 1 | 🔵 info |
| Page weight | `██████████` 4 | 🟠 medium |

---

## Measurements

| Metric | Value |
|--------|-------|
| Largest Contentful Paint | 20ms |
| Cumulative Layout Shift | 0.000 |
| Time to First Byte | 3ms |
| First Contentful Paint | 20ms |
| Interaction to Next Paint | not measured — needs real user interaction |
| Page transfer | 22 kB across 4 requests |
| Slowest request | 15ms — the fixture document |

Where the bytes went:

```
script      ████████████████  18 kB
document    ██░░░░░░░░░░░░░░   3 kB
stylesheet  ██░░░░░░░░░░░░░░   1 kB
image       ░░░░░░░░░░░░░░░░  417 B
```

_INP is not measured: Interaction to Next Paint requires real user interaction, which this scan does not perform._

---

## 🔴 high · error: Demo checkout calculation failed

**Reproduce:**

1. Run `npm run demo`.
2. Open the ephemeral loopback URL printed in the local receipt.
3. Open DevTools → Console.
4. Observe `Demo checkout calculation failed`.

**Fix:** Remove or handle the runtime error before relying on generated tests.

---

## Page structure — `inspect_page`

Title: **Northwind Coffee — checkout** · 3 headings · 1 form · 5 interactive elements

Suggested locators, preferring role and accessible name:

- `page.getByRole('textbox', { name: "you@example.com" })`
- `page.getByRole('link', { name: "Pricing" })`
- `page.getByRole('button', { name: "Complete checkout" })`

---

## Repro and executed evidence

- A deterministic repro is generated below `.qmax-mcp/repros`.
- Chromium executes that repro and returns the expected **failed** status because the fixture intentionally retains the error.
- The runner executed only the digest it was given. The demo self-asserted that digest, so it is not independently verifiable human approval; a real client obtains it from a form elicitation a human accepts.

This is a stable, illustrative receipt shape. Generate current evidence with `npm run demo` or `npm run demo -- --format json`.
