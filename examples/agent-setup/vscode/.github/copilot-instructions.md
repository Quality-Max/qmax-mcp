# QualityMax QA workflow

Before completing a relevant web change, use `scan_url` or `inspect_page` and
return the observed evidence and unresolved failures. Generate a Playwright
reproduction only when useful. Ask for approval before mutating files or
executing supplied code. Do not weaken assertions merely to make them pass.

Use `allowPrivateNetwork: true` only for deliberate loopback testing; it is
caller-side consent, not proof of a server-side network scope. Private-network
targets remain denied. Use hosted
QualityMax only for a capability that needs it; local QA tools need no account
or API key.
