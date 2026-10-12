# IndexNow

Set a unique `INDEXNOW_KEY` in the production hosting environment for this
site. Generate 32 random hexadecimal characters with a password manager; do
not reuse another site's key or commit it. Preview/local builds can omit it.

The build writes `/indexnow-key.txt` and `/indexnow-deployment.txt` into the
public output. Both generated files are gitignored. The first is the UTF-8
ownership proof required by IndexNow; the second identifies the deployed
commit. Treat the key as a credential even though search engines must be able
to fetch its verification file.

After changes to the site merge to `main`, the IndexNow GitHub workflow waits
for up to 15 minutes for the canonical production host to serve that exact
commit. It retrieves the ownership proof without logging it, then submits
the current flat sitemap's public URLs to `https://api.indexnow.org/indexnow`.
There is no browser key or GitHub secret, and preview deployments never submit.
The sitemap must contain only HTTPS URLs on this site's canonical host, without
query strings or fragments. Keep private/authenticated pages out of it.

The workflow can also be run manually on `main` after a hosting configuration
change or redeployment. A missing key, failed deployment, or stale production
revision makes submission fail without sending URLs. HTTP 200 means the URLs
were received; 202 means ownership validation is pending. Neither guarantees
indexing. Check Bing Webmaster Tools > IndexNow for receipt evidence.

This small static-site integration submits the current sitemap after a site
deploy. If removing a page, submit its deleted canonical URL separately before
removing it from the sitemap. Sitemap indexes are not supported.

Run the focused checks with `node --test site/scripts/indexnow.check.mjs`.

Protocol: https://www.indexnow.org/documentation
