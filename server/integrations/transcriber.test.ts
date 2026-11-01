import type { TranscriptionModelV4 } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { AiSdkTranscriber } from "./transcriber.ts";

describe("transcriber", () => {
  it("[MOM-8][CODE-12] turns a voice note into text through the AI SDK, with the model passed in", async () => {
    const calls: { mediaType: string; bytes: number }[] = [];
    const model: TranscriptionModelV4 = {
      specificationVersion: "v4",
      provider: "practice",
      modelId: "practice-stt",
      async doGenerate(options) {
        calls.push({ mediaType: options.mediaType, bytes: typeof options.audio === "string" ? options.audio.length : options.audio.length });
        return { text: "  slow day today  ", segments: [], language: "en", durationInSeconds: 1, warnings: [], response: { timestamp: new Date(), modelId: "practice-stt" } };
      },
    };
    const text = await new AiSdkTranscriber(model).transcribe(new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0, 2]), "audio/ogg");
    expect(text).toBe("slow day today");
    expect(calls).toHaveLength(1);
  });
});
