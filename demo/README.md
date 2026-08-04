# Reproducible demo: scan → finding → repro → evidence

This demo uses a checked-in, dependency-free local fixture and Node’s built-in HTTP server. It has no account, private infrastructure, or mutable third-party target. The fixture intentionally raises `Demo checkout calculation failed` in the browser.

```bash
npx playwright install chromium
npm run demo
npm run demo -- --format json
npm run demo:record
```

The one-time Playwright install downloads the browser used by the local test runner. The script starts an ephemeral loopback server, calls `scan_url` with its narrow `allowPrivateNetwork: true` opt-in, generates a console-error repro below `.qmax-mcp/repros`, then executes that repro on Chromium. The expected test result is **failed**, because the fixture retains the intentional error. This is useful evidence that the error is reproducible, not a release pass.

The JSON mode is the machine-readable quality receipt. It identifies the exact scan findings, generated repro path, structured execution summary, and the approval limitation. Stable receipt shapes are committed as [Markdown](quality-receipt.example.md) and [JSON](quality-receipt.example.json) examples; generate current evidence from the release candidate rather than treating those examples as a fresh run. Generated files and Playwright artifacts remain under `.qmax-mcp/` for local inspection and are not committed.

`npm run demo:record` refreshes the checked-in [short terminal recording source](scan-to-repro.cast) from the same tested flow. It is an [asciicast v2](https://docs.asciinema.org/manual/asciicast/v2/) file; replay it with a compatible asciicast player. Regenerate it only from the release candidate whose behavior it depicts.

## Safety limit

The runner executes only a test digest it has already seen approved. A real MCP client obtains that digest from a form elicitation a human accepts; this script computes the digest and supplies it to itself, which the receipt records as `approvalMechanism: "demo-self-asserted-digest"`. It is not a verifiable record of a human client approval. Do not use this demo as evidence that QUA-1730’s human-approval control is complete; consult the [security threat model](../docs/security-threat-model.md) before release.
