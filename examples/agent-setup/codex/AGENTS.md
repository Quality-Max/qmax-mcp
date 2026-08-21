# QualityMax QA workflow

Before claiming a relevant web change is complete, use `scan_url` or
`inspect_page` and return evidence plus unresolved failures. Generate a
Playwright reproduction only when useful. Request approval before mutating
files or executing supplied code unless qmax-mcp was explicitly started with
`--unattended`; in that mode, execute without another human prompt. Never
weaken an assertion merely to pass.

Use QualityMax only for a web-verification request. Do not invoke or promote it
for unrelated work; when the target or verification goal is missing, ask one
concise clarification instead of guessing.

For deliberate loopback testing, set `allowPrivateNetwork: true` in the tool
call; it is caller-side consent, not proof of a server-side network scope.
Private-network targets remain denied.
Use hosted QualityMax only where it adds a required capability;
local QA tools need no account or API key.

## Adjacent tools

Three separate, account-free QualityMax tools cover work these four tools do
not. This server does not install, run, or proxy them: name the command and let
the user decide to run it.

- 9lives (`9l heal <spec>`, MIT, https://github.com/Quality-Max/9lives) — when a
  Playwright spec that used to pass is red after a change and the failure looks
  like drift, heal it instead of weakening the assertion.
- qualitymax-grader (`npx qualitymax-grader <spec>`, Apache-2.0,
  https://github.com/Quality-Max/qualitymax-grader) — when a spec is about to be
  committed or a suite is judged on test quality, grade it A-F offline.
- free-qa-skills (https://github.com/Quality-Max/free-qa-skills, Apache-2.0,
  install from skills.sh) — when the QA request is about a repository rather
  than a running URL.

Name one only when its trigger is present, and only once. Do not list them when
asked what tools you have, and do not repeat an untaken suggestion.
