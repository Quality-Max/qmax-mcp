/**
 * Exercises inspect_page's locator ranking and stability verdict against real DOM.
 *
 * The ranking lives inside a page.evaluate body, so — like the keyboard-trap
 * rule — it cannot be reached from the unit harness. Both fixtures below are the
 * markup from the report that motivated this: a password pair with no handle of
 * any kind, and a login field where a stable id and a placeholder were both
 * present and the placeholder won.
 */
const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');
const { inspectPage } = require('../../dist/tools/inspect-page.js');

async function inspectFixture(body) {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><html lang="en"><head><title>fixture</title></head><body>${body}</body></html>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    return await inspectPage({ url: `http://127.0.0.1:${port}/`, allowPrivateNetwork: true });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const control = (result, predicate) => result.interactive.find(predicate);

test('a control with no handle at all says so, and offers a scoped fallback', async () => {
  // The reported markup: two password inputs, no id, no name, no label.
  const result = await inspectFixture(`
    <form>
      <div><div><input type="password"></div></div>
      <div><div><input type="password"></div></div>
    </form>
  `);

  const passwords = result.interactive.filter((item) => item.type === 'password');
  assert.equal(passwords.length, 2);

  for (const [index, field] of passwords.entries()) {
    assert.equal(field.stability, 'none', `field ${index} should have no stable handle`);
    // The knowledge the tool had but never surfaced.
    assert.match(field.locatorNote, /No stable handle/);
    assert.match(field.locatorNote, /data-testid/);
    // Scoped to the form and positional, exactly as a spec author would have to
    // write by hand — but handed over rather than left to be invented.
    assert.equal(field.recommendedLocator, `page.locator("form input[type=\\"password\\"] >> nth=${index}")`);
  }

  assert.equal(result.testability.none, 2);
  assert.match(result.testability.note, /2 of \d+ controls have no stable handle/);
});

test('a stable id outranks a placeholder on the same element', async () => {
  // The reported recommendation was getByRole('textbox', { name: "beispiel@email.de" })
  // — the placeholder — while #email sat on the same element.
  const result = await inspectFixture('<form><input id="email" type="email" placeholder="beispiel@email.de"></form>');
  const email = control(result, (item) => item.type === 'email');

  assert.equal(email.stability, 'stable');
  assert.equal(email.recommendedLocator, "page.locator('#email')");
  assert.equal(email.locatorNote, undefined);
});

test('a placeholder-only control is marked fragile and carries the caveat', async () => {
  const result = await inspectFixture('<form><input type="text" placeholder="Search orders"></form>');
  const search = control(result, (item) => item.type === 'text');

  assert.equal(search.stability, 'fragile');
  assert.equal(search.nameSource, 'placeholder');
  assert.equal(search.recommendedLocator, 'page.getByPlaceholder("Search orders")');
  assert.match(search.locatorNote, /breaks on a copy edit and on any translation/);
});

test('a label-derived name ranks above text and is called stable', async () => {
  const result = await inspectFixture(`
    <form>
      <label for="city">City</label><input id="city2" name="city_field" type="text">
      <label>Postcode <input type="text"></label>
    </form>
  `);

  // Wrapped label: no id, but the name comes from the label, so it is stable.
  const postcode = result.interactive.find((item) => item.name === 'Postcode');
  assert.equal(postcode.stability, 'stable');
  assert.equal(postcode.nameSource, 'label');
  assert.equal(postcode.recommendedLocator, 'page.getByRole(\'textbox\', { name: "Postcode" })');
});

test('a name attribute is not passed off as an accessible name', async () => {
  // getByRole would not match a name attribute, so recommending it would hand
  // over a locator that silently finds nothing.
  const result = await inspectFixture('<form><input type="text" name="coupon"></form>');
  const coupon = control(result, (item) => item.type === 'text');

  assert.equal(coupon.nameSource, 'name-attribute');
  assert.equal(coupon.recommendedLocator, "page.locator('[name=\"coupon\"]')");
  assert.match(coupon.locatorNote, /not an accessible name/);
});

test('a data-qa attribute is addressed by the attribute it actually uses', async () => {
  // Emitting a data-qa value as [data-testid=...] produces a selector that
  // matches nothing, and getByTestId only reads data-testid by default.
  const result = await inspectFixture('<button data-qa="submit-order">Go</button>');
  const button = control(result, (item) => item.tag === 'button');

  assert.equal(button.stability, 'stable');
  assert.equal(button.selector, '[data-qa="submit-order"]');
  assert.equal(button.recommendedLocator, "page.locator('[data-qa=\"submit-order\"]')");

  const testid = await inspectFixture('<button data-testid="submit-order">Go</button>');
  const native = control(testid, (item) => item.tag === 'button');
  assert.equal(native.recommendedLocator, 'page.getByTestId("submit-order")');
});

test('the page-level score counts only stable handles', async () => {
  const result = await inspectFixture(`
    <form>
      <input id="a" type="text">
      <input type="text" placeholder="fragile">
      <input type="password">
      <button>Send</button>
    </form>
  `);

  assert.equal(result.testability.controls, 4);
  assert.equal(result.testability.stable, 1, 'only #a has a stable handle');
  assert.equal(result.testability.acceptable, 1, 'the button is named by its text');
  assert.equal(result.testability.fragile, 1);
  assert.equal(result.testability.none, 1);
  assert.equal(result.testability.score, 25);
});
