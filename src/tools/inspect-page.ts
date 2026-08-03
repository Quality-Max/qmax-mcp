import { cssEscape, type Viewport, validateHttpUrl, withPage } from './common';
import { safeUrlForDisplay } from './network-policy';
import { redactSensitiveData } from './run-playwright-test';

export type InspectPageArgs = {
  url: string;
  includeAccessibilityTree?: boolean;
  includeForms?: boolean;
  viewport?: Viewport;
  allowPrivateNetwork?: boolean;
};

export async function inspectPage(args: InspectPageArgs) {
  const url = validateHttpUrl(args.url);

  return await withPage({ url, viewport: args.viewport, allowPrivateNetwork: args.allowPrivateNetwork }, async (page) => {
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
          return el.tagName.toLowerCase();
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

    return redactSensitiveData({
      ...snapshot,
      url: safeUrlForDisplay(snapshot.url),
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
