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
  /** Explicit consent to return structure and text derived from authenticated private content. */
  acknowledgePrivateContent?: boolean;
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

/**
 * Summarise how testable a page is from its controls' stability verdicts.
 *
 * A page where most controls have no stable handle is expensive to write specs
 * against, and that is worth knowing *before* the first spec is written rather
 * than discovering it one locator at a time. The score counts only `stable`
 * handles — a test-id, an id, or a name that comes from a label — because those
 * are the ones that survive a copy edit.
 */
export function summarizeTestability(
  controls: Array<{ stability?: string }>
): { controls: number; stable: number; acceptable: number; fragile: number; none: number; score: number; note?: string } {
  const count = (value: string) => controls.filter((control) => control.stability === value).length;
  const stable = count('stable');
  const none = count('none');
  const summary = {
    controls: controls.length,
    stable,
    acceptable: count('acceptable'),
    fragile: count('fragile'),
    none,
    score: controls.length === 0 ? 100 : Math.round((stable / controls.length) * 100),
  };
  if (none === 0) return summary;
  return {
    ...summary,
    note: `${none} of ${controls.length} controls have no stable handle. Their locators are positional fallbacks that move with the markup; a data-testid on each is the durable fix.`,
  };
}

export async function inspectPage(args: InspectPageArgs) {
  const url = validateHttpUrl(args.url);

  return await withPage({
    url,
    viewport: args.viewport,
    allowPrivateNetwork: args.allowPrivateNetwork,
    storageStatePath: args.storageStatePath,
    acknowledgePrivateContent: args.acknowledgePrivateContent,
  }, async (page) => {
    await waitForDomToSettle(page);
    const snapshot = await page.evaluate(
      ({ includeForms }) => {
        const text = (value: string | null | undefined) => (value || '').replace(/\s+/g, ' ').trim();
        // Where a control's name came from decides how much a locator built on
        // it is worth, so the source is carried rather than discarded. A name
        // read off a placeholder and one read off an associated label are not
        // interchangeable: the first breaks on a copy edit or a translation.
        const namedBy = (el: Element): { name: string; source: string } | null => {
          const aria = text(el.getAttribute('aria-label'));
          if (aria) return { name: aria, source: 'aria-label' };

          const labelledBy = el.getAttribute('aria-labelledby');
          if (labelledBy) {
            const referenced = labelledBy
              .split(/\s+/)
              .map((id) => document.getElementById(id))
              .filter((node): node is HTMLElement => Boolean(node));
            const joined = text(referenced.map((node) => node.textContent).join(' '));
            if (joined) return { name: joined, source: 'aria-labelledby' };
          }

          // `labels` covers both `for=`/`id` association and a wrapping label;
          // closest() is the fallback for elements that do not expose it.
          const labelled = (el as HTMLInputElement).labels;
          const labels = labelled ? Array.from(labelled) : [];
          const labelText = text(labels.map((label) => label.textContent).join(' ')) || text(el.closest('label')?.textContent);
          if (labelText) return { name: labelText, source: 'label' };

          const title = text(el.getAttribute('title'));
          if (title) return { name: title, source: 'title' };

          const own = text(el.textContent);
          if (own) return { name: own, source: 'text' };

          const placeholder = text(el.getAttribute('placeholder'));
          if (placeholder) return { name: placeholder, source: 'placeholder' };

          const nameAttribute = text(el.getAttribute('name'));
          if (nameAttribute) return { name: nameAttribute, source: 'name-attribute' };

          return null;
        };

        /**
         * The least brittle locator available for a control that has no handle
         * of its own: scoped to the nearest form or landmark, described by tag
         * and input type, and positional only where it has to be.
         *
         * Deliberately returned rather than withheld. A spec author facing this
         * markup will write something positional regardless; the useful thing is
         * to hand them the narrowest version and say plainly that it is a
         * fallback.
         */
        const scopedFallback = (el: Element): string | undefined => {
          const tag = el.tagName.toLowerCase();
          const type = el.getAttribute('type');
          const descriptor = tag === 'input' && type ? `input[type="${type}"]` : tag;

          const scope = el.closest('form') || el.closest('[role="dialog"], dialog, main, nav, header, footer');
          let scopeSelector = '';
          if (scope) {
            const scopeTag = scope.tagName.toLowerCase();
            const scopeId = scope.getAttribute('id');
            const scopeName = scope.getAttribute('name');
            scopeSelector = scopeId
              ? `#${CSS.escape(scopeId)}`
              : scopeName
                ? `${scopeTag}[name="${scopeName}"]`
                : scopeTag;
          }

          const matches = Array.from((scope ?? document).querySelectorAll(descriptor));
          const index = matches.indexOf(el);
          if (index < 0) return undefined;
          const base = scopeSelector ? `${scopeSelector} ${descriptor}` : descriptor;
          return matches.length > 1 ? `${base} >> nth=${index}` : base;
        };
        const selectorFor = (el: Element) => {
          // Name the attribute that was actually found: emitting a data-qa value
          // as `[data-testid=...]` produces a selector that matches nothing.
          const testIdAttribute = ['data-testid', 'data-test', 'data-qa'].find((attribute) => el.getAttribute(attribute));
          if (testIdAttribute) return `[${testIdAttribute}="${el.getAttribute(testIdAttribute)}"]`;
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
            const named = namedBy(el);
            const name = named?.name ?? '';
            const testIdAttribute = ['data-testid', 'data-test', 'data-qa'].find((attribute) =>
              el.getAttribute(attribute)
            );
            const testId = testIdAttribute ? el.getAttribute(testIdAttribute) : null;
            const id = el.getAttribute('id');

            // Ranked best handle first. Every branch states how much the handle
            // is worth, so a caller never has to infer stability from the shape
            // of the string it was handed.
            let stability = 'none';
            let recommendedLocator: string | undefined;
            let locatorNote: string | undefined;

            if (testId && testIdAttribute) {
              stability = 'stable';
              // getByTestId only reads data-testid unless the project configures
              // otherwise, so data-test and data-qa get an explicit attribute
              // selector rather than a recommendation that silently matches
              // nothing.
              recommendedLocator =
                testIdAttribute === 'data-testid'
                  ? `page.getByTestId(${JSON.stringify(testId)})`
                  : `page.locator('[${testIdAttribute}="${testId}"]')`;
            } else if (id) {
              stability = 'stable';
              recommendedLocator = `page.locator('#${CSS.escape(id)}')`;
            } else if (role && named && ['aria-label', 'aria-labelledby', 'label'].includes(named.source)) {
              stability = 'stable';
              recommendedLocator = `page.getByRole('${role}', { name: ${JSON.stringify(name)} })`;
            } else if (role && named && ['text', 'title'].includes(named.source)) {
              stability = 'acceptable';
              recommendedLocator = `page.getByRole('${role}', { name: ${JSON.stringify(name)} })`;
            } else if (named && named.source === 'placeholder') {
              stability = 'fragile';
              recommendedLocator = `page.getByPlaceholder(${JSON.stringify(name)})`;
              locatorNote =
                'Named by its placeholder, the most fragile source available: it breaks on a copy edit and on any translation. Ask for a data-testid, or an associated label, and prefer that.';
            } else if (named && named.source === 'name-attribute') {
              stability = 'acceptable';
              // The name attribute is not part of the accessible name, so a
              // getByRole built on it matches nothing. Address it directly.
              recommendedLocator = `page.locator('[name="${name}"]')`;
              locatorNote =
                'Named by its name attribute, which is not an accessible name: getByRole would not match it.';
            } else {
              const fallback = scopedFallback(el);
              recommendedLocator = fallback ? `page.locator(${JSON.stringify(fallback)})` : undefined;
              locatorNote =
                'No stable handle: this control has no test id, no id, and no accessible name. The locator above is the least brittle option the page allows and is positional, so it moves with the markup. The durable fix is a data-testid on the control.';
            }

            return {
              tag: el.tagName.toLowerCase(),
              role,
              name,
              nameSource: named?.source,
              stability,
              href: (el as HTMLAnchorElement).href || undefined,
              type: el.getAttribute('type') || undefined,
              selector: selectorFor(el),
              recommendedLocator,
              locatorNote,
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
      testability: summarizeTestability(snapshot.interactive),
      selectorGuidance: [
        'recommendedLocator is already ranked: test id, then id, then a label-derived role name, then a text-derived one, then a placeholder. Prefer it over building your own.',
        'Read `stability` before using a locator. `fragile` means the name comes from a placeholder and breaks on a copy edit or a translation; `none` means the control has no handle and the locator is a positional fallback.',
        'When `stability` is `none`, the honest fix is a data-testid on the control — ask for one rather than pinning the spec to the current markup.',
        `Escape CSS identifiers when using raw CSS selectors, e.g. ${cssEscape('example"value')}.`,
      ],
    });
  });
}
