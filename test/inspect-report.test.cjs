const assert = require('node:assert/strict');
const test = require('node:test');

const { renderInspectReport } = require('../dist/report.js');

function inspectResult(overrides = {}) {
  return {
    title: 'Fixture',
    url: 'https://example.com/login',
    headings: [
      { level: 1, text: 'Welcome' },
      { level: 2, text: 'Sign in' },
    ],
    interactive: [],
    forms: [],
    testability: { controls: 0, stable: 0, acceptable: 0, fragile: 0, none: 0, score: 100 },
    ...overrides,
  };
}

test('the locator table ranks stable handles first regardless of page order', () => {
  const report = renderInspectReport(
    inspectResult({
      interactive: [
        {
          tag: 'input',
          type: 'text',
          name: 'Search orders',
          stability: 'fragile',
          recommendedLocator: 'page.getByPlaceholder("Search orders")',
          locatorNote: 'Named by its placeholder, the most fragile source available.',
        },
        {
          tag: 'button',
          role: 'button',
          name: 'Sign in',
          stability: 'stable',
          recommendedLocator: 'page.getByTestId("signin")',
        },
      ],
      testability: { controls: 2, stable: 1, acceptable: 0, fragile: 1, none: 0, score: 50 },
    }),
    { now: new Date('2026-08-27T00:00:00Z') }
  );

  const rows = report.split('\n').filter((line) => line.startsWith('| '));
  assert.match(rows[1], /stable/);
  assert.match(rows[1], /getByTestId/);
  assert.match(rows[2], /fragile/);
  assert.match(report, /Testability: 50 \/ 100/);
  assert.match(report, /1 stable · 1 fragile/);
  assert.match(report, /inspected 2026-08-27/);
});

test('identical caveats are grouped rather than repeated per control', () => {
  const note = 'No stable handle: the durable fix is a data-testid on the control.';
  const report = renderInspectReport(
    inspectResult({
      interactive: [
        { tag: 'input', type: 'password', stability: 'none', selector: 'input >> nth=0', locatorNote: note },
        { tag: 'input', type: 'password', stability: 'none', selector: 'input >> nth=1', locatorNote: note },
      ],
      testability: { controls: 2, stable: 0, acceptable: 0, fragile: 0, none: 2, score: 0 },
    })
  );

  assert.equal(report.split(note).length - 1, 1, 'the shared note should appear exactly once');
  assert.match(report, /input\[password\] `input >> nth=0`, input\[password\] `input >> nth=1`/);
  assert.match(report, /2 without a handle/);
});

test('warnings render before the score they would undermine', () => {
  const report = renderInspectReport(
    inspectResult({
      warnings: ['No headings, controls or forms were found in 12 DOM nodes.'],
    })
  );

  const warningAt = report.indexOf('⚠️');
  const scoreAt = report.indexOf('Testability:');
  assert.ok(warningAt !== -1 && warningAt < scoreAt, 'warning should precede the testability verdict');
  assert.match(report, /No interactive controls found\./);
});

test('a control name containing a pipe cannot break the table', () => {
  const report = renderInspectReport(
    inspectResult({
      interactive: [
        {
          tag: 'a',
          role: 'link',
          name: 'Terms | Privacy',
          stability: 'acceptable',
          recommendedLocator: 'page.getByRole(\'link\', { name: "Terms | Privacy" })',
        },
      ],
      testability: { controls: 1, stable: 0, acceptable: 1, fragile: 0, none: 0, score: 0 },
    })
  );

  const row = report.split('\n').find((line) => line.includes('Terms'));
  assert.ok(row.includes('Terms \\| Privacy'), 'pipes inside cells must be escaped');
  assert.equal(row.split(/[^\\]\|/).length, 4, 'the row should still have exactly three cells');
});
