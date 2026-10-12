import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { origin, validKey, sitemapUrls, prepare, submit } from './indexnow.mjs';

const key = randomBytes(16).toString('hex');
const revision = 'a'.repeat(40);
const publicDir = new URL('../', import.meta.url);
const xml = (urls) => `<urlset>${urls.map((url) => `<url><loc>${url}</loc></url>`).join('')}</urlset>`;

test('canonical sitemap rejects foreign hosts, private query URLs, fragments and empty lists', () => {
  assert.deepEqual(sitemapUrls(xml([`${origin}/`, `${origin}/`])), [`${origin}/`]);
  for (const urls of [[], ['https://example.net/'], [`${origin}/?token=private`],
    [`${origin}/#fragment`], [origin.replace('https:', 'http:')]]) {
    assert.throws(() => sitemapUrls(xml(urls)));
  }
  assert.throws(() => sitemapUrls('<sitemapindex><loc>https://example.net/</loc></sitemapindex>'));
  assert.throws(() => sitemapUrls('<!DOCTYPE urlset [<!ENTITY key SYSTEM "file:///etc/passwd">]><urlset/>'));
  assert.throws(() => sitemapUrls(xml(Array.from({length: 10001}, (_, n) => `${origin}/${n}`))));
});

test('key validation rejects whitespace, unsafe characters and invalid lengths', () => {
  assert.equal(validKey(key), true);
  for (const candidate of [undefined, '', 'short', key + '\n', 'x'.repeat(129), 'a/b'.repeat(8)]) {
    assert.equal(validKey(candidate), false);
  }
});

test('build writes UTF-8 ownership files and clears stale files when disabled', async () => {
  const keyFile = new URL('indexnow-key.txt', publicDir);
  const revisionFile = new URL('indexnow-deployment.txt', publicDir);
  try {
    await prepare({ INDEXNOW_KEY: key, VERCEL_GIT_COMMIT_SHA: revision });
    assert.equal(await readFile(keyFile, 'utf8'), key);
    assert.equal(await readFile(revisionFile, 'utf8'), revision);
    await prepare({});
    await assert.rejects(readFile(keyFile, 'utf8'), { code: 'ENOENT' });
    await assert.rejects(readFile(revisionFile, 'utf8'), { code: 'ENOENT' });
    await assert.rejects(prepare({ INDEXNOW_KEY: 'bad' }), /Invalid INDEXNOW_KEY/);
    await assert.rejects(prepare({ INDEXNOW_KEY: key, RAILWAY_GIT_COMMIT_SHA: 'wrong' }), /revision/);
    await prepare({ INDEXNOW_KEY: key, RAILWAY_GIT_COMMIT_SHA: revision });
    assert.equal(await readFile(revisionFile, 'utf8'), revision);
  } finally {
    await Promise.all([rm(keyFile, {force: true}), rm(revisionFile, {force: true})]);
  }
});

test('waits for the production commit, then sends only sitemap URLs with matching ownership', async () => {
  let markerReads = 0, posts = 0, waits = 0;
  const fetcher = async (url, options) => {
    assert.equal(options.redirect, 'error');
    if (url.endsWith('indexnow-deployment.txt')) {
      markerReads++;
      return new Response(markerReads === 1 ? 'b'.repeat(40) : revision);
    }
    if (url.endsWith('indexnow-key.txt')) return new Response(key);
    assert.equal(url, 'https://api.indexnow.org/indexnow');
    assert.equal(options.method, 'POST');
    posts++;
    const payload = JSON.parse(options.body);
    assert.equal(payload.host, new URL(origin).host);
    assert.equal(payload.key, key);
    assert.equal(payload.keyLocation, `${origin}/indexnow-key.txt`);
    assert.deepEqual(payload.urlList, sitemapUrls(await readFile(new URL('sitemap.xml', publicDir), 'utf8')));
    return new Response('', {status: 202});
  };
  assert.equal(await submit({ revision, fetcher, attempts: 2, wait: async () => waits++ }), 202);
  assert.equal(markerReads, 2);
  assert.equal(waits, 1);
  assert.equal(posts, 1);
});

test('never POSTs when production is stale, inaccessible or returns an HTML key page', async () => {
  for (const mode of ['stale', 'unavailable', 'html', 'network']) {
    let posts = 0;
    const fetcher = async (url, options) => {
      if (options.method === 'POST') posts++;
      if (mode === 'network') throw new Error('unavailable');
      if (mode === 'unavailable') return new Response('', {status: 404});
      if (url.endsWith('indexnow-deployment.txt')) return new Response(mode === 'stale' ? 'old' : revision);
      return new Response('<html>Sign in</html>');
    };
    await assert.rejects(submit({revision, fetcher, attempts: 1}), /not ready/);
    assert.equal(posts, 0);
  }
});

test('HTTP receipts distinguish successful acceptance from rejected submissions', async () => {
  for (const status of [200, 202, 400, 403, 422, 429, 500]) {
    const fetcher = async (url) => {
      if (url.endsWith('indexnow-deployment.txt')) return new Response(revision);
      if (url.endsWith('indexnow-key.txt')) return new Response(key);
      return new Response('', {status});
    };
    const result = submit({revision, fetcher, attempts: 1});
    if ([200,202].includes(status)) assert.equal(await result, status);
    else await assert.rejects(result, new RegExp(`HTTP ${status}`));
  }
  await assert.rejects(submit({revision: 'not-a-sha'}), /commit SHA/);
});
