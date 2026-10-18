import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { callWebSearch } from "./web_search";
import type { AgentContext } from "./types";

vi.mock("electron-log", () => ({
  default: {
    scope: () => ({
      log: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  },
}));

const mocks = vi.hoisted(() => ({
  readSettings: vi.fn(),
  getLanguageModelProviders: vi.fn(),
  getEnvVar: vi.fn(() => undefined),
  fetch: vi.fn(),
  engineFetch: vi.fn(),
}));

vi.mock("@/main/settings", () => ({
  readSettings: mocks.readSettings,
}));

vi.mock("@/ipc/shared/language_model_helpers", () => ({
  getLanguageModelProviders: mocks.getLanguageModelProviders,
}));

vi.mock("@/ipc/utils/read_env", () => ({
  getEnvVar: mocks.getEnvVar,
}));

vi.mock("./engine_fetch", () => ({
  engineFetch: mocks.engineFetch,
}));

const localProvider = {
  id: "nine-router-local",
  name: "9Router Local",
  apiBaseUrl: "http://localhost:20128/v1",
  type: "custom",
};

function mockCtx(): AgentContext {
  return {
    dyadRequestId: "test-request",
    abortSignal: new AbortController().signal,
    onXmlStream: vi.fn(),
    onXmlComplete: vi.fn(),
  } as unknown as AgentContext;
}

function mockSSEResponse(chunks: string[]) {
  const encoder = new TextEncoder();
  const queue = chunks.map((c) => encoder.encode(c));
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    text: async () => "",
    body: {
      getReader: () => ({
        read: async () => {
          const value = queue.shift();
          if (!value) return { done: true, value: undefined };
          return { done: false, value };
        },
        cancel: async () => {},
        releaseLock: () => {},
      }),
    },
  };
}

describe("callWebSearch routing", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", mocks.fetch);
    mocks.readSettings.mockReturnValue({
      providerSettings: {
        "nine-router-local": { apiKey: { value: "local-key" } },
      },
    });
    mocks.getEnvVar.mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetAllMocks();
  });

  it("routes to 9Router when the local provider is configured", async () => {
    mocks.getLanguageModelProviders.mockResolvedValue([localProvider]);
    mocks.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => "",
      json: async () => ({
        provider: "tavily",
        query: "NextJS 14",
        results: [
          {
            title: "Next.js 14 Docs",
            url: "https://nextjs.org/docs",
            snippet: "The React framework.",
          },
        ],
      }),
    });

    const result = await callWebSearch("NextJS 14", mockCtx());

    expect(result).toContain("Next.js 14 Docs");
    expect(mocks.fetch).toHaveBeenCalledOnce();
    const [url] = mocks.fetch.mock.calls[0];
    expect(url).toBe("http://localhost:20128/v1/search");
    expect(mocks.engineFetch).not.toHaveBeenCalled();
  });

  it("falls back to Dyad Engine when no local provider is configured", async () => {
    mocks.getLanguageModelProviders.mockResolvedValue([]);
    mocks.engineFetch.mockResolvedValue(
      mockSSEResponse([
        `data: {"choices":[{"delta":{"content":"hello "}}]}\n`,
        `data: {"choices":[{"delta":{"content":"world"}}]}\n`,
        `data: [DONE]\n`,
      ]),
    );

    const result = await callWebSearch("NextJS 14", mockCtx());

    expect(result).toBe("hello world");
    expect(mocks.engineFetch).toHaveBeenCalledOnce();
    const [ctx, path] = mocks.engineFetch.mock.calls[0];
    expect(ctx.dyadRequestId).toBe("test-request");
    expect(path).toBe("/tools/web-search");
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});
