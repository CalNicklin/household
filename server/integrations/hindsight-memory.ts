import { HindsightClient } from "@vectorize-io/hindsight-client";
import type { EpisodicMemory, MemoryScope } from "../ports.ts";

const clean = (s: string) => s.toLowerCase().replace(/[^a-z0-9_-]/g, "-");

/** One bank per person per house, so a recall can never see anyone else's memories (PLT-6). */
export function bankId(scope: MemoryScope): string {
  return `household-${clean(scope.household)}-person-${clean(scope.person)}`;
}

type HindsightLike = Pick<HindsightClient, "retain" | "recall" | "deleteBank">;

/** Episodic memory (phrasing, dismissals) in Hindsight (PLT-6). Structured facts stay in Postgres. */
export class HindsightMemory implements EpisodicMemory {
  readonly #client: HindsightLike;
  constructor(options: { baseUrl: string; apiKey?: string } | { client: HindsightLike }) {
    if ("client" in options) this.#client = options.client;
    else this.#client = new HindsightClient(options.apiKey === undefined ? { baseUrl: options.baseUrl } : { baseUrl: options.baseUrl, apiKey: options.apiKey });
  }

  async retain(scope: MemoryScope, content: string): Promise<void> {
    await this.#client.retain(bankId(scope), content, { tags: [`person:${scope.person}`] });
  }

  async recall(scope: MemoryScope, query: string): Promise<string[]> {
    const response = await this.#client.recall(bankId(scope), query);
    return response.results.map((r) => r.text);
  }

  /** PRV-7: deleting a person deletes their bank. */
  async forget(scope: MemoryScope): Promise<void> {
    await this.#client.deleteBank(bankId(scope));
  }
}
