/**
 * Exercises inspect_page's accessibilityTree against Chromium's own tree.
 *
 * The fixture is the form from issue #132. The tree used to be a DOM walk that
 * named the e-mail field by its placeholder, reported `input` as its role, and
 * dropped the unlabelled checkbox — three disagreements with the browser, and a
 * name that contradicted the same report's `interactive` entry.
 */
const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');
const { inspectPage } = require('../../dist/tools/inspect-page.js');

async function inspectFixture(body) {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><html lang="en"><head><title>Repro</title></head><body>${body}</body></html>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    return await inspectPage({ url: `http://127.0.0.1:${port}/`, allowPrivateNetwork: true });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const REPRO = `<main>
<form>
  <label for="email">E-mail address</label>
  <input id="email" name="email" type="email" placeholder="you@example.com">
  <input id="remember" name="rememberMe" type="checkbox">
  <span>Keep me signed in</span>
  <button type="submit">Sign in</button>
</form></main>`;

test('the tree carries the browser\'s roles and computed names', { timeout: 60_000 }, async () => {
  const result = await inspectFixture(REPRO);
  const tree = result.accessibilityTree;

  const email = tree.find((node) => node.tag === 'input' && node.role === 'textbox');
  assert.ok(email, 'the e-mail field is a textbox, not an `input`');
  assert.equal(email.name, 'E-mail address', 'the label wins over the placeholder');
  assert.equal(email.nameSource, 'label');

  const button = tree.find((node) => node.role === 'button');
  assert.equal(button.name, 'Sign in');
  assert.equal(button.nameSource, 'text');

  // Tag names are never reported as roles.
  for (const node of tree) assert.notEqual(node.role, 'input', JSON.stringify(node));

  // A landmark is named by its accessible name, not by every word inside it.
  const main = tree.find((node) => node.role === 'main');
  assert.equal(main.name, '');
  assert.ok(email.depth > main.depth, 'the field is listed under its landmark');
});

test('a control without a name is listed and flagged, not dropped', { timeout: 60_000 }, async () => {
  const result = await inspectFixture(REPRO);
  const checkbox = result.accessibilityTree.find((node) => node.role === 'checkbox');

  assert.ok(checkbox, 'the unlabelled checkbox is in the tree');
  assert.equal(checkbox.name, '');
  assert.equal(checkbox.unnamed, true);
  assert.equal(checkbox.checked, 'false');
  assert.equal(checkbox.tag, 'input');
});

test('the tree and the interactive list agree on a control\'s name', { timeout: 60_000 }, async () => {
  const result = await inspectFixture(`${REPRO}
    <nav><a href="/help" title="Help centre">Help</a></nav>
    <span id="search-label">Search orders</span>
    <input type="search" aria-label="Ignored" aria-labelledby="search-label">`);

  for (const control of result.interactive) {
    // A name attribute is not an accessible name; the tree is right to omit it.
    if (control.nameSource === 'name-attribute') continue;
    const node = result.accessibilityTree.find(
      (candidate) => candidate.role === control.role && candidate.name === control.name
    );
    assert.ok(node, `${control.role} "${control.name}" has a matching tree node`);
    assert.equal(node.nameSource, control.nameSource, `${control.role} "${control.name}"`);
  }

  // The two precedence rules the interactive list used to get backwards.
  assert.ok(result.interactive.some((item) => item.role === 'link' && item.name === 'Help' && item.nameSource === 'text'));
  const search = result.interactive.find((item) => item.name === 'Search orders');
  assert.equal(search.nameSource, 'aria-labelledby');
  assert.equal(search.role, 'searchbox', 'the role getByRole resolves for a search field');
});
