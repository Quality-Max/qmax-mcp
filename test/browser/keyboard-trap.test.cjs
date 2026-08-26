/**
 * Exercises the accessibility check's keyboard-reachability rule against real DOM.
 *
 * It needs the Playwright browser, so — like test/demo — it is not part of
 * `npm test`; run it with `npm run test:browser`.
 *
 * The rule is defined inside a page.evaluate body and so is not reachable from a
 * unit test. That gap let a false positive ship in 0.6.0: clickable <label> text
 * was reported as a keyboard trap even though the label's own control was
 * focusable, which on a registration form meant both consent checkboxes were
 * flagged as unreachable when they were operable. Fixtures are the cheapest way
 * to hold that behaviour still.
 */
const assert = require('node:assert/strict');
const test = require('node:test');
const { chromium } = require('playwright');
const { scanUrl } = require('../../dist/tools/scan-url.js');

const PAGE = (body) => `<!doctype html><html lang="en"><head>
<style>.click { cursor: pointer; }</style></head><body>${body}</body></html>`;

/** Serve one fixture over http:// so the scanner's URL policy accepts it. */
async function scanFixture(body) {
  const http = require('node:http');
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(PAGE(body));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const result = await scanUrl({
      url: `http://127.0.0.1:${port}/`,
      allowPrivateNetwork: true,
      checks: ['accessibility'],
    });
    return result.findings
      .filter((finding) => /clickable but cannot be focused/.test(finding.message))
      .map((finding) => finding.selector);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('a div styled as a control is reported', async () => {
  const traps = await scanFixture('<div class="click">Log in here</div>');
  assert.equal(traps.length, 1, `expected one trap, got ${JSON.stringify(traps)}`);
});

test('clickable label text is not reported when the label has a control', async () => {
  // Regression for the 0.6.0 false positive. Both shapes must stay quiet:
  // a wrapping label, and a label associated by `for`.
  const wrapping = await scanFixture(
    '<label><input type="checkbox"><span class="click">I accept the terms</span></label>'
  );
  assert.deepEqual(wrapping, [], `wrapping label flagged: ${JSON.stringify(wrapping)}`);

  const associated = await scanFixture(
    '<input type="checkbox" id="c"><label for="c"><span class="click">I accept the terms</span></label>'
  );
  assert.deepEqual(associated, [], `for-associated label flagged: ${JSON.stringify(associated)}`);

  // The real-world shape that triggered it: label text with a nested button.
  const nestedButton = await scanFixture(
    '<label><input type="checkbox"><span class="click">I accept the <button type="button">terms</button></span></label>'
  );
  assert.deepEqual(nestedButton, [], `label with nested button flagged: ${JSON.stringify(nestedButton)}`);
});

test('a clickable wrapper around a real control is not reported', async () => {
  const wrapper = await scanFixture('<div class="click"><button type="button">Save</button></div>');
  assert.deepEqual(wrapper, [], `wrapper around a button flagged: ${JSON.stringify(wrapper)}`);
});

test('an icon-only control with no focusable anywhere is still reported', async () => {
  // The case the rule exists for — must survive the false-positive fixes above.
  const icon = await scanFixture('<div class="click"><img alt="Messages" src="data:,"></div>');
  assert.equal(icon.length, 1, `icon control not reported: ${JSON.stringify(icon)}`);

  const svg = await scanFixture('<div><svg class="click" width="10" height="10"></svg></div>');
  assert.equal(svg.length, 1, `svg control not reported: ${JSON.stringify(svg)}`);
});

test('an icon inside a real button is not reported', async () => {
  const inside = await scanFixture('<button type="button"><svg class="click" width="10" height="10"></svg></button>');
  assert.deepEqual(inside, [], `icon inside a button flagged: ${JSON.stringify(inside)}`);
});

test.after(async () => {
  // chromium is launched per scan by withPage; nothing to tear down here, but
  // assert the import resolved so a packaging regression fails loudly.
  assert.equal(typeof chromium.launch, 'function');
});
