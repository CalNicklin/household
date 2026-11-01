import { transcribe, type TranscriptionModel } from "ai";
import type { Transcriber } from "../ports.ts";

/**
 * MOM-8: voice notes become text at the edge, through the Vercel AI SDK (CODE-12). The model is
 * passed in, so which provider transcribes is configuration (PLT-9).
 */
export class AiSdkTranscriber implements Transcriber {
  readonly #model: TranscriptionModel;
  constructor(model: TranscriptionModel) {
    this.#model = model;
  }

  async transcribe(audio: Uint8Array, _contentType: string): Promise<string> {
    const result = await transcribe({ model: this.#model, audio });
    return result.text.trim();
  }
}
