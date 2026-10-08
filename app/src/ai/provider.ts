// One interface, two implementations. The heuristic provider is deterministic and is
// what every test uses; the LLM provider is optional (LLM_API_KEY) and never decides
// anything on its own: staff decide every duplicate pair and sign every report.
import type { DedupPair, PseudoRow } from './dedup.js';
import type { Figures } from '../report/figures.js';
import { renderTemplate } from '../report/template.js';

export interface AiProvider {
  readonly name: 'heuristic' | 'llm';
  /** Re-judge `review`-band pairs; may move bands and add reasons, never drops a pair. */
  rejudgeReview(pairs: DedupPair[], rows: ReadonlyMap<string, PseudoRow>): Promise<DedupPair[]>;
  /** Draft donor-report markdown from the figures JSON only. */
  draftReport(figures: Figures): Promise<string>;
}

export class HeuristicProvider implements AiProvider {
  readonly name = 'heuristic' as const;
  async rejudgeReview(pairs: DedupPair[]): Promise<DedupPair[]> {
    return pairs;
  }
  async draftReport(figures: Figures): Promise<string> {
    return renderTemplate(figures);
  }
}

export interface ProviderEnv {
  LLM_API_KEY?: string;
  LLM_MODEL?: string;
}

/**
 * The LLM path for dedup is off unless LLM_API_KEY is set AND the programme records a
 * data-protection sign-off (`llm_dedup_allowed: true`).
 */
export function dedupLlmAllowed(env: ProviderEnv, llmDedupAllowed: boolean): boolean {
  return Boolean(env.LLM_API_KEY) && llmDedupAllowed === true;
}
