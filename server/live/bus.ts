import { EventEmitter } from "node:events";
import type { LiveTopic } from "@household/contracts";

/**
 * The change feed (PLT-11): domain writes publish a topic, screens listen over SSE and refetch.
 * One process serves the house, so an in-process emitter is the whole feed.
 */
export class LiveBus {
  readonly #emitter = new EventEmitter();
  constructor() {
    this.#emitter.setMaxListeners(0);
  }
  publish(topic: LiveTopic): void {
    this.#emitter.emit("change", { topic, at: Date.now() });
  }
  subscribe(listener: (event: { topic: LiveTopic; at: number }) => void): () => void {
    this.#emitter.on("change", listener);
    return () => this.#emitter.off("change", listener);
  }
}
