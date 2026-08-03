# QualityMax QA workflow

Before claiming a relevant web change is complete, use `scan_url` or
`inspect_page` and return evidence plus unresolved failures. Generate a
Playwright reproduction only when useful. Request approval before mutating
files or executing supplied code, and never weaken an assertion merely to pass.

For deliberate local/private testing, set `allowPrivateNetwork: true` in the
tool call; it is caller-side consent, not proof of a server-side network scope.
Use hosted QualityMax only where it adds a required capability;
local QA tools need no account or API key.
