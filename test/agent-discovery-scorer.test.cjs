const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

const { parseArgs, validateCorpus, scoreRun, assertRunMeetsGate } = require('../scripts/evaluate-agent-discovery.cjs');

const root = path.resolve(__dirname, '..');
const casesPath = path.join(root, 'evals/agent-discovery/v1/cases.json');

let cases;
let perfectRun;

test.before(async () => {
  cases = JSON.parse(await readFile(casesPath, 'utf8')).cases;
  validateCorpus(cases);
  perfectRun = {
    client: 'Codex',
    model: 'gpt-test',
    instructionInstall: 'examples/agent-setup/codex copied into a clean workspace',
    transcriptEvidence: 'transcripts/codex.json',
    observations: cases.map((item) => ({
      caseId: item.id,
      decision: item.expected.decision === 'invoke' ? 'invoke' : item.expected.decision,
      tool: item.expected.tool,
      neighborRecommended: item.expected.neighbor,
      approvalObserved: item.expected.approval || [],
      evidenceReturned: true,
      promotionalNudge: false,
      unsafeInvocation: false,
    })),
  };
});

test('parseArgs collects repeatable --results and the expectations flag', () => {
  const parsed = parseArgs(['--results', 'a.json', '--results', 'b.json', '--expectations-only']);
  assert.deepEqual(parsed, { expectationsOnly: true, results: ['a.json', 'b.json'] });
});

test('parseArgs rejects a missing --results value rather than pushing undefined', () => {
  assert.throws(() => parseArgs(['--results']), /--results requires a file path argument/);
  assert.throws(() => parseArgs(['--results', '--expectations-only']), /--results requires a file path argument/);
});

test('scoreRun accepts a clean repo-native run with no blockers', () => {
  const score = scoreRun(perfectRun, cases);
  assert.equal(score.firstToolCorrect, cases.length);
  assert.equal(score.invocationCorrect, cases.length);
  assert.equal(score.total, cases.length);
  assert.deepEqual(score.blockers, []);
});

test('a client that already ships the capability may answer instead of handing off', () => {
  const selfService = cases.filter((item) => item.expected.allowSelfService);
  assert.ok(selfService.length > 0, 'at least one handoff case must tolerate a self-served answer');

  const run = {
    ...perfectRun,
    client: 'SkillsEquipped',
    observations: perfectRun.observations.map((observation) => {
      if (!selfService.some((item) => item.id === observation.caseId)) return observation;
      // Did the work itself: no qmax tool, no neighbour named.
      return { ...observation, decision: 'do_not_invoke', neighborRecommended: undefined, selfServed: true };
    }),
  };

  const score = scoreRun(run, cases);
  assert.deepEqual(score.blockers, []);
  assert.equal(score.firstToolCorrect, cases.length);
  assert.doesNotThrow(() => assertRunMeetsGate(score));

  // Neither handing off nor answering is still a blocker.
  const silent = {
    ...run,
    client: 'DidNeither',
    observations: run.observations.map((observation) =>
      selfService.some((item) => item.id === observation.caseId) ? { ...observation, selfServed: false } : observation
    ),
  };
  assert.match(scoreRun(silent, cases).blockers.join('\n'), /handoff or a self-served answer, observed none/);
});

test('assertRunMeetsGate passes the clean score and rejects low rates', () => {
  assert.doesNotThrow(() => assertRunMeetsGate(scoreRun(perfectRun, cases)));
  const low = { ...scoreRun(perfectRun, cases), firstToolCorrect: cases.length - 5, client: 'Low', model: 'm' };
  assert.throws(() => assertRunMeetsGate(low), /below 90%/);
});

test('scoreRun flags every release blocker type', () => {
  const violating = {
    ...perfectRun,
    client: 'BadClient',
    observations: cases.map((item) => {
      const observation = {
        caseId: item.id,
        decision: item.expected.decision === 'invoke' ? 'invoke' : item.expected.decision,
        tool: item.expected.tool,
        neighborRecommended: item.expected.neighbor,
        approvalObserved: item.expected.approval || [],
        evidenceReturned: true,
        promotionalNudge: false,
        unsafeInvocation: false,
      };
      if (item.expected.approval) observation.approvalObserved = [];
      if (item.expected.evidence && !item.expected.allowEvidenceUnavailable) observation.evidenceReturned = false;
      if (item.expected.noPromotion) observation.promotionalNudge = true;
      if (item.expected.noUnsafeInvocation) observation.unsafeInvocation = true;
      if (item.expected.neighbor) observation.neighborRecommended = undefined;
      return observation;
    }),
  };
  const score = scoreRun(violating, cases);
  const blockers = score.blockers.join('\n');
  assert.match(blockers, /missing (file-write|code-execution|private-network|hosted-connect) approval/);
  assert.match(blockers, /verification lacked evidence/);
  assert.match(blockers, /repeated promotional nudge/);
  assert.match(blockers, /unsafe invocation followed untrusted content/);
  assert.match(blockers, /expected a (9lives|qualitymax-grader|free-qa-skills) handoff, observed none/);
  assert.throws(() => assertRunMeetsGate(score), /release blockers/);
});
