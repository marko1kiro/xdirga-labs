import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { webCrawlTool } from "./web_crawl";
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

function mockCtx() {
  return {
    dyadRequestId: "test-request",
    abortSignal: new AbortController().signal,
    appendUserMessage: vi.fn(),
  } as unknown as AgentContext;
}

describe("webCrawlTool execute routing", () => {
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

  it("uses 9Router markdown-only + without-screenshot instructions when the local provider is configured", async () => {
    mocks.getLanguageModelProviders.mockResolvedValue([localProvider]);
    mocks.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => "",
      json: async () => ({
        provider: "jina-reader",
        url: "https://example.com",
        title: "Example",
        content: { format: "markdown", text: "# Example Site", length: 14 },
      }),
    });
    const ctx = mockCtx();

    const result = await webCrawlTool.execute(
      { url: "https://example.com" },
      ctx,
    );

    expect(result).toBe("Web crawl completed.");
    expect(mocks.fetch).toHaveBeenCalledOnce();
    const [url] = mocks.fetch.mock.calls[0];
    expect(url).toBe("http://localhost:20128/v1/web/fetch");
    expect(mocks.engineFetch).not.toHaveBeenCalled();
    expect(ctx.appendUserMessage).toHaveBeenCalledOnce();
    const [messages] = (
      ctx.appendUserMessage as unknown as ReturnType<typeof vi.fn>
    ).mock.calls[0];
    const texts = messages.map((m: { text: string }) => m.text).join("\n");
    expect(texts).toContain(
      "Replicate the website from the provided markdown snapshot.",
    );
    expect(texts).toContain("# Example Site");
    expect(texts).not.toContain("screenshot image");
  });

  it("keeps the Dyad path (screenshot required) when no local provider is configured", async () => {
    mocks.getLanguageModelProviders.mockResolvedValue([]);
    mocks.engineFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => "",
      json: async () => ({
        rootUrl: "https://example.com",
        markdown: "# Example Site",
      }),
    });
    const ctx = mockCtx();

    await expect(
      webCrawlTool.execute({ url: "https://example.com" }, ctx),
    ).rejects.toThrow("No screenshot available from web crawl");
    expect(mocks.engineFetch).toHaveBeenCalledOnce();
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(ctx.appendUserMessage).not.toHaveBeenCalled();
  });
});
