import { OpenAIEmbeddings } from "@langchain/openai";

import { appEnv } from "../config/env.js";

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);

    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

export class ArchiveEmbedder {
  private readonly embeddings = new OpenAIEmbeddings({
    apiKey: appEnv.embeddingApiKey,
    model: appEnv.embeddingModel,
    dimensions: appEnv.embeddingDimensions,
    configuration: {
      baseURL: appEnv.embeddingBaseUrl
    }
  });

  async embedTexts(texts: string[]): Promise<number[][]> {
    if (!texts.length) {
      return [];
    }

    return withTimeout(
      this.embeddings.embedDocuments(texts),
      appEnv.archiveEmbeddingTimeoutMs,
      "archive embeddings"
    );
  }

  async embedQuery(text: string): Promise<number[]> {
    return withTimeout(
      this.embeddings.embedQuery(text),
      appEnv.archiveEmbeddingTimeoutMs,
      "archive query embedding"
    );
  }
}

let archiveEmbedderSingleton: ArchiveEmbedder | null = null;

export function getArchiveEmbedder(): ArchiveEmbedder {
  archiveEmbedderSingleton ??= new ArchiveEmbedder();
  return archiveEmbedderSingleton;
}
