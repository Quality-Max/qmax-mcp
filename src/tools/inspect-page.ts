import type { Page } from 'playwright';
import { cssEscape, type Viewport, validateHttpUrl, withPage } from './common';
import { safeUrlForDisplay } from './network-policy';
import { redactSensitiveData } from './run-playwright-test';

export type InspectPageArgs = {
  url: string;
  includeAccessibilityTree?: boolean;
  includeForms?: boolean;
  viewport?: Viewport;
  allowPrivateNetwork?: boolean;
  storageStatePath?: string;
};

/**
 * Give a client-rendered page a bounded chance to finish rendering.
 *
 * `withPage` navigates with `waitUntil: 'domcontentloaded'`, which on an app that
 * renders in the browser fires against an empty shell — the snapshot then reports
 * no headings, no controls and no forms for a page that has all three once
 * hydrated. Polling until the node count stops changing covers that without
 * waiting on `networkidle`, which never arrives on apps holding a websocket or
 * an SSE stream open.
 *
 * Bounded and best-effort by design: if the page is still changing when the
 * budget runs out we snapshot anyway and report what we saw, rather than failing.
 */
async function waitForDomToSettle(page: Page, timeoutMs = 5_000, quietMs = 250): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let previous = -1;
  while (Date.now() < deadline) {
    const count = await page.evaluate(() => document.getElementsByTagName('*').length);
    if (count > 0 && count === previous) return;
    previous = count;
    await page.waitForTimeout(quietMs);
  }
}


/**
 * Warn when a snapshot found nothing, and say how much DOM there was.
 *
 * An all-empty snapshot is ambiguous: the page may genuinely have no semantic
 * markup, or it may simply not have rendered yet. Returning the node count
 * alongside the warning lets the caller tell those apart — a handful of nodes
 * means an empty shell, a few hundred means the page rendered and really has no
 * headings or controls. Previously the response was empty arrays and no
 * explanation, which reads as authoritative.
 */
export function emptySnapshotWarnings(
  counts: { headings: number; interactive: number; forms: number },
  domNodeCount: number
): string[] {
  if (counts.headings > 0 || counts.interactive > 0 || counts.forms > 0) return [];
  return [
    `No headings, controls or forms were found in ${domNodeCount} DOM nodes. ` +
      'If the page renders in the browser it may still have been mid-render; ' +
      'a server-rendered page with no semantic markup produces the same result.',
  ];
}

export async function inspectPage(args: InspectPageArgs) {
  const url = validateHttpUrl(args.url);

  return await withPage({ url, viewport: args.viewport, allowPrivateNetwork: args.allowPrivateNetwork, storageStatePath: args.storageStatePath }, async (page) => {
    await waitForDomToSettle(page);
    const snapshot = await page.evaluate(
      ({ includeForms }) => {
        const text = (value: string | null | undefined) => (value || '').replace(/\s+/g, ' ').trim();
        const accessibleName = (el: Element) =>
          text(el.getAttribute('aria-label')) ||
          text(el.getAttribute('title')) ||
          text(el.textContent) ||
          text(el.getAttribute('placeholder')) ||
          text(el.getAttribute('name'));
        const selectorFor = (el: Element) => {
          const testId = el.getAttribute('data-testid') || el.getAttribute('data-test') || el.getAttribute('data-qa');
          if (testId) return `[data-testid="${testId}"]`;
          const id = el.getAttribute('id');
          if (id) return `#${CSS.escape(id)}`;
          // Fall back to a path rather than the bare tag name: two anchors with
          // no id both used to be reported as `a`, which matches every link on
          // the page and so identifies neither.
          const parts: string[] = [];
          let node: Element | null = el;
          while (node && parts.length < 6) {
            const tag = node.tagName.toLowerCase();
            if (tag === 'body' || tag === 'html') {
              parts.unshift(tag);
              break;
            }
            const nodeId = node.getAttribute('id');
            if (nodeId) {
              parts.unshift(`#${CSS.escape(nodeId)}`);
              break;
            }
            const parent: Element | null = node.parentElement;
            if (!parent) {
              parts.unshift(tag);
              break;
            }
            const twins = Array.from(parent.children).filter((child) => child.tagName === node!.tagName);
            parts.unshift(twins.length > 1 ? `${tag}:nth-of-type(${twins.indexOf(node) + 1})` : tag);
            node = parent;
          }
          return parts.join(' > ');
        };
        const roleFor = (el: Element) => {
          const explicit = el.getAttribute('role');
          if (explicit) return explicit;
          const tag = el.tagName.toLowerCase();
          if (tag === 'button') return 'button';
          if (tag === 'a') return 'link';
          if (tag === 'input') {
            const type = (el.getAttribute('type') || 'text').toLowerCase();
            if (['button', 'submit', 'reset'].includes(type)) return 'button';
            if (type === 'checkbox') return 'checkbox';
            if (type === 'radio') return 'radio';
            return 'textbox';
          }
          if (tag === 'textarea') return 'textbox';
          if (tag === 'select') return 'combobox';
          return tag;
        };

        const interactive = Array.from(
          document.querySelectorAll('button, a[href], input, textarea, select, [role], [data-testid], [data-test], [data-qa]')
        )
          .slice(0, 250)
          .map((el) => {
            const role = roleFor(el);
            const name = accessibleName(el);
            const testId = el.getAttribute('data-testid') || el.getAttribute('data-test') || el.getAttribute('data-qa');
            return {
              tag: el.tagName.toLowerCase(),
              role,
              name,
              href: (el as HTMLAnchorElement).href || undefined,
              type: el.getAttribute('type') || undefined,
              selector: selectorFor(el),
              recommendedLocator: role && name ? `page.getByRole('${role}', { name: ${JSON.stringify(name)} })` : undefined,
              testId,
              text: text(el.textContent).slice(0, 160),
            };
          });

        const headings = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6')).map((el) => ({
          level: Number(el.tagName.slice(1)),
          text: text(el.textContent),
        }));

        const forms = includeForms
          ? Array.from(document.forms).map((form, index) => ({
              index,
              action: form.action,
              method: form.method,
              fields: Array.from(form.querySelectorAll('input, textarea, select')).map((field) => ({
                tag: field.tagName.toLowerCase(),
                name: field.getAttribute('name') || undefined,
                type: field.getAttribute('type') || undefined,
                placeholder: field.getAttribute('placeholder') || undefined,
                selector: selectorFor(field),
              })),
            }))
          : [];

        return {
          title: document.title,
          url: location.href,
          headings,
          interactive,
          forms,
        };
      },
      { includeForms: args.includeForms ?? true }
    );

    const accessibilityTree =
      args.includeAccessibilityTree ?? true
        ? await page.evaluate(() => {
            const nodes = Array.from(document.querySelectorAll('main, nav, header, footer, h1, h2, h3, button, a[href], input, textarea, select, [role]'))
              .slice(0, 300)
              .map((el) => ({
                role: el.getAttribute('role') || el.tagName.toLowerCase(),
                name: (el.getAttribute('aria-label') || el.textContent || el.getAttribute('placeholder') || '').replace(/\s+/g, ' ').trim().slice(0, 160),
                tag: el.tagName.toLowerCase(),
              }))
              .filter((node) => node.name || ['main', 'nav', 'header', 'footer'].includes(node.role));
            return nodes;
          })
        : undefined;

    // Reported so an empty snapshot is self-describing. Without these, "no
    // interactive elements" is indistinguishable from "snapshotted too early",
    // and the caller has nothing to act on.
    const diagnostics = await page.evaluate(() => ({
      domNodeCount: document.getElementsByTagName('*').length,
      readyState: document.readyState,
    }));
    const warnings = emptySnapshotWarnings(
      { headings: snapshot.headings.length, interactive: snapshot.interactive.length, forms: snapshot.forms.length },
      diagnostics.domNodeCount
    );

    return redactSensitiveData({
      ...snapshot,
      url: safeUrlForDisplay(snapshot.url),
      diagnostics,
      warnings: warnings.length > 0 ? warnings : undefined,
      interactive: snapshot.interactive.map((item) => ({ ...item, href: item.href ? safeUrlForDisplay(item.href) : undefined })),
      forms: snapshot.forms.map((form) => ({ ...form, action: safeUrlForDisplay(form.action) })),
      accessibilityTree,
      selectorGuidance: [
        'Prefer page.getByRole(role, { name }) when role and accessible name are present.',
        'Use data-testid/data-test/data-qa before generated classes or nth-child selectors.',
        `Escape CSS identifiers when using raw CSS selectors, e.g. ${cssEscape('example"value')}.`,
      ],
    });
  });
}
