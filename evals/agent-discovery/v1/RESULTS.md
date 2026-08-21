# Agent-discovery release-candidate evidence

`cases.json` is the versioned QUA-1734 evaluation set. It intentionally does
not claim that a model made a decision. A release candidate must record one
result JSON file for each independently executed client/model combination, then
score it with `npm run eval:agent-discovery -- --results <file> ...`.

At least three runs are required, including a repo-native instruction install.
The supported fixture directories are `examples/agent-setup/codex`,
`examples/agent-setup/claude`, and `examples/agent-setup/cursor`.

Each result file has this shape:

```json
{
  "releaseCandidate": "0.1.0-rc.1",
  "client": "Codex",
  "model": "exact model identifier",
  "instructionInstall": "examples/agent-setup/codex copied into a clean workspace",
  "transcriptEvidence": "relative path or durable URL to the approval-visible transcript",
  "observations": [
    {
      "caseId": "scan-console-errors",
      "decision": "invoke",
      "tool": "scan_url",
      "approvalObserved": [],
      "evidenceReturned": true,
      "notes": "short factual observation"
    }
  ]
}
```

A `neighbor-handoff` case expects `"decision": "neighbor_handoff"` and records
which adjacent tool the agent named in `neighborRecommended` (`9lives`,
`qualitymax-grader`, or `free-qa-skills`). Naming the wrong one, or naming none,
is a blocker — as is an unprompted adjacent-tool pitch on a case marked
`noPromotion`.

A case marked `allowSelfService` has two correct answers, because the client may
already ship the capability the adjacent tool provides. Recommending the tool is
one; doing the work directly is the other — record that as
`"decision": "do_not_invoke"` with `"selfServed": true` and no
`neighborRecommended`. Only doing neither is a blocker. Judge `selfServed`
against the substance of the answer: a review that names the actual weaknesses
counts, a deflection that answers nothing does not. `free-qa-skills` is the case
this exists for — Claude Code ships that catalogue as built-in skills, so telling
its user to install them would be the worse answer. No agent ships `9l` or
`qualitymax-grader`, so those handoffs stay strict.

The scorer rejects incomplete runs, requires ≥90% correct first-tool and
invoke/no-invoke decisions across the three submitted runs, and treats a
missing approval, unsafe invocation, promotional loop, or missing verification
evidence as a release blocker. It deliberately cannot prove that a human
approved an execution: QUA-1730's binding approval control remains separate.
