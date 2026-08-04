# Reproducible demo: find → read → prove → approved execution

One command exercises all four tools against a checked-in, dependency-free local fixture. There is no account, private infrastructure, or mutable third-party target.

![The demo flow: scan_url, inspect_page, generate_playwright_repro, then run_playwright_test behind a human approval gate](flow.svg)

```bash
npx playwright install chromium
npm run demo
npm run demo -- --format json
npm run demo:record
```

The one-time Playwright install downloads the browser used by the local test runner.

## What the run does

The script starts an ephemeral loopback server hosting a small storefront that deliberately carries **one defect per check**, then:

1. **`scan_url`** runs all nine checks in a single page load and grades the result, with a screenshot and measured Core Web Vitals.
2. **`inspect_page`** reads the structure an agent needs to write a locator: headings, forms, and role/name candidates.
3. **`generate_playwright_repro`** writes a deterministic repro for the console finding below `.qmax-mcp/repros`.
4. **`run_playwright_test`** executes it on Chromium.

The expected test result is **failed**, because the fixture retains its intentional error. That is useful evidence the error is reproducible — not a release pass.

The JSON mode is the machine-readable quality receipt: scan findings and metrics, the inspected structure, the generated repro path, the structured execution summary, and the approval limitation. Stable receipt shapes are committed as [Markdown](quality-receipt.example.md) and [JSON](quality-receipt.example.json) examples; generate current evidence from the release candidate rather than treating those examples as a fresh run. Generated files and Playwright artifacts remain under `.qmax-mcp/` for local inspection and are not committed.

`npm run demo:record` refreshes the checked-in [short terminal recording source](scan-to-repro.cast) from the same tested flow. It is an [asciicast v2](https://docs.asciinema.org/manual/asciicast/v2/) file; replay it with a compatible asciicast player. Regenerate it only from the release candidate whose behavior it depicts.

## What the run cannot show

- The fixture is served over HTTP on loopback, so the `mixed_content` check correctly reports itself as not applicable, and no third-party trackers or third-party cookies can appear. Scan a real HTTPS site to exercise those paths.
- Core Web Vitals against a local fixture are fast by construction. They are printed as measurements, not as a passing grade.
- The weight budget is deliberately set below the fixture's size so the budget check has something to report. It is not a recommended budget.

## Safety limit

The runner executes only a test digest it has already seen approved. A real MCP client obtains that digest from a form elicitation a human accepts; this script computes the digest and supplies it to itself, which the receipt records as `approvalMechanism: "demo-self-asserted-digest"`. It is not a verifiable record of a human client approval. Do not use this demo as evidence that QUA-1730’s human-approval control is complete; consult the [security threat model](../docs/security-threat-model.md) before release.
