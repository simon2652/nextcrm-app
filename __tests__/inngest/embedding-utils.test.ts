/**
 * Tests for the Gemini embedding helper.
 */
import {
  generateEmbedding,
  computeContentHash,
  EmbeddingKeyMissingError,
  EMBEDDING_DIMENSIONS,
  MAX_EMBEDDING_CHARS,
} from "@/inngest/lib/embedding-utils";
import { getApiKey } from "@/lib/api-keys";
import { createHash } from "crypto";

jest.mock("@/lib/api-keys", () => ({
  getApiKey: jest.fn(),
}));

const mockGetApiKey = getApiKey as jest.Mock;
const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

function geminiResponse(values: number[]) {
  return { ok: true, json: async () => ({ embedding: { values } }) };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetApiKey.mockResolvedValue("gemini-key");
});

describe("generateEmbedding", () => {
  it("requests 1536 dims from gemini-embedding-001 with the task type", async () => {
    mockFetch.mockResolvedValue(geminiResponse(new Array(EMBEDDING_DIMENSIONS).fill(1)));

    await generateEmbedding("hello", "RETRIEVAL_QUERY");

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toContain("models/gemini-embedding-001:embedContent");
    expect(init.headers["x-goog-api-key"]).toBe("gemini-key");
    const body = JSON.parse(init.body);
    expect(body.outputDimensionality).toBe(1536);
    expect(body.taskType).toBe("RETRIEVAL_QUERY");
    expect(body.content.parts[0].text).toBe("hello");
  });

  it("L2-normalises the returned vector", async () => {
    mockFetch.mockResolvedValue(geminiResponse(new Array(EMBEDDING_DIMENSIONS).fill(2)));

    const vector = await generateEmbedding("hello");

    const norm = Math.sqrt(vector.reduce((s, v) => s + v * v, 0));
    expect(norm).toBeCloseTo(1, 6);
  });

  it("truncates input to the model limit", async () => {
    mockFetch.mockResolvedValue(geminiResponse(new Array(EMBEDDING_DIMENSIONS).fill(1)));

    await generateEmbedding("x".repeat(MAX_EMBEDDING_CHARS + 500));

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.content.parts[0].text).toHaveLength(MAX_EMBEDDING_CHARS);
  });

  it("throws EmbeddingKeyMissingError without a Gemini key", async () => {
    mockGetApiKey.mockResolvedValue(null);
    await expect(generateEmbedding("hello")).rejects.toBeInstanceOf(EmbeddingKeyMissingError);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("rejects a response with the wrong dimension count", async () => {
    mockFetch.mockResolvedValue(geminiResponse([0.1, 0.2]));
    await expect(generateEmbedding("hello")).rejects.toThrow("2 dimensions");
  });
});

describe("computeContentHash", () => {
  it("includes the model id so a model switch invalidates old hashes", () => {
    const plain = createHash("sha256").update("hello").digest("hex");
    expect(computeContentHash("hello")).not.toBe(plain);
    expect(computeContentHash("hello")).toBe(computeContentHash("hello"));
  });
});
