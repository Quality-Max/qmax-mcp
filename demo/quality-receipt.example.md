# QA Scan — local QualityMax demo

**Grade: 🟢 B (80 / 100)** · **1 issue found** · target: dependency-free loopback fixture

| Category | Issues | Worst |
| --- | :---: | :---: |
| Console errors | 1 | 🔴 high |

---

## 🔴 high · error: Demo checkout calculation failed

**Reproduce:**

1. Run `npm run demo`.
2. Open the ephemeral loopback URL printed in the local receipt.
3. Open DevTools → Console.
4. Observe `Demo checkout calculation failed`.

**Fix:** Remove or handle the runtime error before relying on generated tests.

## Repro and execution evidence

- A deterministic repro is generated below `.qmax-mcp/repros`.
- Chromium executes that repro and returns the expected **failed** status because the fixture intentionally retains the error.
- The runner executed only the digest it was given. The demo self-asserted that digest, so it is not independently verifiable human approval; a real client obtains it from a form elicitation a human accepts.

This is a stable, illustrative receipt shape. Generate current evidence with `npm run demo` or `npm run demo -- --format json`.
