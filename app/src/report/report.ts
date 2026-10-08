// Draft → numbers guard → template fallback → staff approval stamp.
import type { AiProvider } from '../ai/provider.js';
import { type Figures, figuresHash } from './figures.js';
import { guardDraft } from './guard.js';
import { renderTemplate } from './template.js';

export const DRAFT_BANNER = '> DRAFT - not approved. Numbers are checked against the figures; the narrative needs staff review.';

export interface DraftResult {
  markdown: string;
  source: 'provider' | 'template';
  provider: string;
  rejectedNumbers: string[];
  figuresSha256: string;
}

export async function draftReport(figures: Figures, provider: AiProvider): Promise<DraftResult> {
  let text: string | undefined;
  let rejected: string[] = [];
  try {
    text = await provider.draftReport(figures);
    const g = guardDraft(text, figures);
    if (!g.ok) {
      rejected = g.unknown;
      text = undefined;
    }
  } catch {
    text = undefined;
  }
  const source = text === undefined ? 'template' : 'provider';
  const body = text ?? renderTemplate(figures);
  return {
    markdown: `${DRAFT_BANNER}\n\n${body.trim()}\n`,
    source,
    provider: provider.name,
    rejectedNumbers: rejected,
    figuresSha256: figuresHash(figures),
  };
}

/** Replaces the DRAFT banner with the approver's name, date and the figures hash. */
export function approveReport(markdown: string, figures: Figures, staffName: string, atIso: string): string {
  const name = staffName.trim();
  if (!name) throw new Error('--approve needs a staff name');
  if (!markdown.startsWith(DRAFT_BANNER)) throw new Error('report is not a draft (already approved?)');
  const stamp = `> APPROVED by ${name} on ${atIso}. Figures sha256: ${figuresHash(figures)}.`;
  return stamp + markdown.slice(DRAFT_BANNER.length);
}
