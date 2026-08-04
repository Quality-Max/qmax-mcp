import type { Finding } from '../common';
import type { ResourceSignal } from './signals';

/** A subresource reference read out of the served markup. */
export type MarkupResource = {
  kind: 'script' | 'stylesheet' | 'iframe' | 'image' | 'media' | 'form-action';
  url: string;
};

export type MixedContentInput = {
  /** Display-safe URL of the scanned page. */
  pageUrl: string;
  /** Subresources declared in the DOM, including ones the browser refused to load. */
  markup: MarkupResource[];
  /** Responses actually observed on the wire. */
  resources: ResourceSignal[];
};

/** Resource types the browser treats as active mixed content and blocks outright. */
const ACTIVE_RESOURCE_TYPES = new Set(['script', 'stylesheet', 'xhr', 'fetch', 'websocket', 'eventsource', 'manifest']);
const ACTIVE_MARKUP_KINDS = new Set<MarkupResource['kind']>(['script', 'stylesheet', 'iframe']);
const PASSIVE_MARKUP_KINDS = new Set<MarkupResource['kind']>(['image', 'media']);

function isInsecure(url: string): boolean {
  return url.startsWith('http://') || url.startsWith('ws://');
}

/**
 * Find HTTP subresources on an HTTPS page.
 *
 * Plain `http://` links are navigation rather than mixed content and are reported by the `links`
 * check instead, so anchors are never inspected here.
 */
export function analyzeMixedContent(input: MixedContentInput): Finding[] {
  if (!input.pageUrl.startsWith('https://')) {
    return [
      {
        severity: 'info',
        category: 'mixed_content',
        message: 'Mixed content does not apply: the page itself was served over HTTP.',
        suggestion: 'Serve the page over HTTPS, then rescan to check its subresources.',
      },
    ];
  }

  const active = new Set<string>();
  const passive = new Set<string>();
  const formActions = new Set<string>();

  for (const item of input.markup) {
    if (!isInsecure(item.url)) continue;
    if (item.kind === 'form-action') formActions.add(item.url);
    else if (ACTIVE_MARKUP_KINDS.has(item.kind)) active.add(item.url);
    else if (PASSIVE_MARKUP_KINDS.has(item.kind)) passive.add(item.url);
  }

  for (const resource of input.resources) {
    if (!isInsecure(resource.url) || passive.has(resource.url)) continue;
    if (ACTIVE_RESOURCE_TYPES.has(resource.resourceType)) active.add(resource.url);
    else if (resource.resourceType === 'image' || resource.resourceType === 'media') passive.add(resource.url);
  }

  const findings: Finding[] = [];
  const networkSteps = `1. Open ${input.pageUrl}\n2. Open DevTools → Console and Network\n3. Observe the insecure subresource requests listed below`;

  if (active.size > 0) {
    findings.push({
      severity: 'high',
      category: 'mixed_content',
      message: `${active.size} active mixed-content subresource${active.size === 1 ? ' is' : 's are'} requested over HTTP.`,
      evidence: Array.from(active).slice(0, 20),
      repro: networkSteps,
      suggestion:
        'Browsers block active mixed content, so these scripts, styles, frames, and API calls silently do not run. Serve them over HTTPS.',
    });
  }

  if (passive.size > 0) {
    findings.push({
      severity: 'medium',
      category: 'mixed_content',
      message: `${passive.size} passive mixed-content resource${passive.size === 1 ? ' is' : 's are'} requested over HTTP.`,
      evidence: Array.from(passive).slice(0, 20),
      repro: networkSteps,
      suggestion:
        'Images and media over HTTP are tamperable in transit and mark the page as not fully secure. Serve them over HTTPS.',
    });
  }

  if (formActions.size > 0) {
    findings.push({
      severity: 'high',
      category: 'mixed_content',
      message: `${formActions.size} form${formActions.size === 1 ? '' : 's'} submit${formActions.size === 1 ? 's' : ''} to an insecure HTTP endpoint.`,
      evidence: Array.from(formActions).slice(0, 20),
      repro: `1. Open ${input.pageUrl}\n2. Inspect the form element\n3. Read its action attribute`,
      suggestion: 'Submitted form data would travel in plaintext. Point the action at an HTTPS endpoint.',
    });
  }

  return findings;
}
