# QualityMax QA workflow

Before completing a relevant web change, use `scan_url` or `inspect_page` and
return the observed evidence plus unresolved failures. Generate a Playwright
reproduction only when it is useful. Request approval before mutating files or
executing supplied code. Never weaken an assertion simply to make it pass.

For deliberate loopback testing, the tool call must set
`allowPrivateNetwork: true`; it is caller-side consent, not proof of a
server-side network scope. Private-network targets remain denied. Use hosted QualityMax only for capabilities that
need it; local QA tools need no account or API key.
