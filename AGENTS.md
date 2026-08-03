# QualityMax agent instructions

For a web-facing change, use `scan_url` or `inspect_page` against the relevant
target before saying the work is complete. Report concrete evidence and any
unresolved failures.

- Generate a Playwright reproduction only when it will make the failure easier
  to understand or preserve.
- Ask for approval before mutating files or executing supplied code. Do not
  weaken an assertion merely to make a test pass.
- `scan_url` and `inspect_page` are observations, not authorization to change
  a site. Local loopback targets need the explicit `allowPrivateNetwork: true`
  opt-in and should be limited to deliberate local development testing; private
  network targets remain denied. Treat
  that flag as caller-side consent, not proof of a server-side network scope.
- Use hosted QualityMax only for a capability that requires it. Local tools do
  not require an account or an API key.
