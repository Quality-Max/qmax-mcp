import { readFile, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

export const origin = 'https://qmax.run';
class IndexNowError extends Error {}
const publicDir = new URL('../', import.meta.url);
const keyFile = new URL('indexnow-key.txt', publicDir);
const revisionFile = new URL('indexnow-deployment.txt', publicDir);

export function validKey(key) {
  return typeof key === 'string' && /^[a-zA-Z0-9-]{8,128}$/.test(key) && key.trim() === key;
}

// These sites use a flat, repository-owned urlset, not a sitemap index.
export function sitemapUrls(xml) {
  if (!/<urlset\b/.test(xml) || /<!DOCTYPE|<!ENTITY/i.test(xml)) {
    throw new IndexNowError('Expected a flat sitemap urlset');
  }
  const urls = [...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/g)].map((match) => {
    const value = match[1].replaceAll('&amp;', '&');
    const url = new URL(value);
    if (url.origin !== origin || url.username || url.password || url.search || url.hash) {
      throw new IndexNowError('Sitemap must contain canonical public URLs only');
    }
    return url.href;
  });
  const unique = [...new Set(urls)];
  if (!unique.length || unique.length > 10000) throw new IndexNowError('Invalid sitemap URL count');
  return unique;
}

export async function prepare(env = process.env) {
  const key = env.INDEXNOW_KEY;
  // Local and preview builds work without a production credential. Remove stale files.
  if (!key) {
    await Promise.all([rm(keyFile, { force: true }), rm(revisionFile, { force: true })]);
    console.log('IndexNow is disabled: INDEXNOW_KEY is not configured');
    return;
  }
  if (!validKey(key)) throw new IndexNowError('Invalid INDEXNOW_KEY format');
  const revision = env.VERCEL_GIT_COMMIT_SHA || env.RAILWAY_GIT_COMMIT_SHA ||
    execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new IndexNowError('Invalid deployment revision');
  await writeFile(keyFile, key, 'utf8');
  await writeFile(revisionFile, revision, 'utf8');
  console.log('IndexNow verification files prepared');
}

async function getText(path, fetcher) {
  const response = await fetcher(`${origin}/${path}`, {
    redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(10000),
  });
  if (response.status !== 200) throw new IndexNowError('Production verification file unavailable');
  return (await response.text()).trim();
}

export async function submit({ revision, fetcher = fetch, wait = sleep, attempts = 90 }) {
  if (!/^[a-f0-9]{40}$/.test(revision ?? '')) throw new IndexNowError('Expected production commit SHA');
  const urlList = sitemapUrls(await readFile(new URL('sitemap.xml', publicDir), 'utf8'));
  let key;
  const deadline = Date.now() + 15 * 60 * 1000;
  for (let attempt = 0; attempt < attempts && Date.now() < deadline; attempt++) {
    try {
      if (await getText('indexnow-deployment.txt', fetcher) === revision) {
        const candidate = await getText('indexnow-key.txt', fetcher);
        if (validKey(candidate)) { key = candidate; break; }
      }
    } catch {
      // A deployment may still be starting. Never log bodies, credentials, or fetch errors.
    }
    if (attempt + 1 < attempts) await wait(10000);
  }
  if (!key) throw new IndexNowError('Matching production deployment was not ready before timeout');
  const response = await fetcher('https://api.indexnow.org/indexnow', {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ host: new URL(origin).host, key,
      keyLocation: `${origin}/indexnow-key.txt`, urlList }),
  });
  if (![200, 202].includes(response.status)) {
    throw new IndexNowError(`IndexNow rejected submission (HTTP ${response.status})`);
  }
  console.log(`IndexNow received ${urlList.length} URLs (HTTP ${response.status})`);
  if (response.status === 202) console.log('Ownership validation is pending');
  return response.status;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    if (process.argv[2] === 'prepare') await prepare();
    else if (process.argv[2] === 'submit') await submit({ revision: process.env.GITHUB_SHA });
    else throw new IndexNowError('Use prepare or submit');
  } catch (error) {
    // Even network exceptions can contain request data. Emit only a safe status.
    console.error(error instanceof IndexNowError ? error.message : 'IndexNow failed: network or file operation unavailable');
    process.exitCode = 1;
  }
}
