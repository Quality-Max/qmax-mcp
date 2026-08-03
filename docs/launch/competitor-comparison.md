# Capability boundary comparison

Last verified: **2026-08-03**. This is a narrow, factual comparison of the public documentation linked below; it is not a feature ranking, benchmark, pricing comparison, or safety assurance. Product behavior and documentation can change.

| Product | Documented agent / MCP surface | Documented execution or platform boundary | Source |
| --- | --- | --- | --- |
| QualityMax QA MCP | Local stdio MCP exposes URL scan, page inspection, deterministic repro generation, and local Playwright execution. | Local tools need no account; hosted capabilities require an explicit proxy. Execution still needs client-visible human approval before a release claim. | [README](../../README.md), [safety contract](../mcp-safety.md) |
| TestSprite | Its MCP documentation describes an IDE-connected agent that can analyze a project, create plans and executable tests, run them in its cloud, and report results. | TestSprite documents secure cloud execution for the MCP workflow. | [MCP overview](https://docs.testsprite.com/mcp/getting-started/overview) |
| BrowserStack | Test Companion is documented as an IDE AI assistant that generates tests/scripts and helps debug and address accessibility issues. | The documentation places it in the BrowserStack ecosystem. | [Test Companion overview](https://www.browserstack.com/docs/test-companion/overview) |
| mabl | mabl documents AI-assisted testing, local CLI/Playwright capabilities, cloud execution, and MCP integrations for AI clients. | Its release notes describe unified reporting across local, cloud, and CI sources. | [MCP integration](https://help.mabl.com/hc/en-us/articles/41344391281684-Integrating-mabl-MCP-with-Atlassian-MCP), [January 2026 notes](https://help.mabl.com/hc/en-us/articles/45763941346836) |
| Momentic | Its local stdio MCP server lets agents author, run, and triage tests. | Setup requires a Momentic project configuration and `MOMENTIC_API_KEY`. | [MCP server](https://momentic.ai/docs/integrations/mcp-server) |

QualityMax’s launch claim should stay specific: it offers a no-account local QA loop with explicit action boundaries. It should not claim that competitors lack MCP, agentic testing, cloud execution, or approval controls without a dated, separately maintained source review.
