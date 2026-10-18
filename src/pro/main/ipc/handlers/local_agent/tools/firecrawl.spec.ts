import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { callFirecrawlScrape, resolveFirecrawlApiKey } from "./firecrawl";
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
  getEnvVar: vi.fn(() => undefined),
  fetch: vi.fn(),
}));

vi.mock("@/main/settings", () => ({
  readSettings: mocks.readSettings,
}));

vi.mock("@/ipc/utils/read_env", () => ({
  getEnvVar: mocks.getEnvVar,
}));

function mockCtx() {
  return {
    dyadRequestId: "test-request",
    abortSignal: new AbortController().signal,
  } as unknown as AgentContext;
}

function scrapeResponse(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    text: async () => "",
    json: async () => ({
      success: true,
      data: {
        markdown: "# Example Site",
        screenshot: "https://cdn.example.com/shot.png",
        metadata: { title: "Example" },
      },
      ...overrides,
    }),
  };
}

function screenshotResponse() {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: { get: () => "image/png" },
    arrayBuffer: async () => new TextEncoder().encode("fake-png-bytes").buffer,
  };
}

describe("resolveFirecrawlApiKey", () => {
  beforeEach(() => {
    mocks.readSettings.mockReturnValue({});
    mocks.getEnvVar.mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it("returns the key from Settings, trimmed", async () => {
    mocks.readSettings.mockReturnValue({
      firecrawlApiKey: { value: "  fc-test-key  " },
    });
    await expect(resolveFirecrawlApiKey()).resolves.toBe("fc-test-key");
  });

  it("falls back to the FIRECRAWL_API_KEY env var", async () => {
    mocks.getEnvVar.mockReturnValue("fc-env-key");
    await expect(resolveFirecrawlApiKey()).resolves.toBe("fc-env-key");
  });

  it("returns null when no key is configured anywhere", async () => {
    await expect(resolveFirecrawlApiKey()).resolves.toBeNull();
  });
});

describe("callFirecrawlScrape", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", mocks.fetch);
    mocks.readSettings.mockReturnValue({
      firecrawlApiKey: { value: "fc-test-key" },
    });
    mocks.getEnvVar.mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetAllMocks();
  });

  it("posts markdown + full-page screenshot formats and downloads the screenshot as a data URL", async () => {
    mocks.fetch
      .mockResolvedValueOnce(scrapeResponse())
      .mockResolvedValueOnce(screenshotResponse());
    const ctx = mockCtx();

    const result = await callFirecrawlScrape("https://example.com", ctx);

    expect(result.markdown).toBe("# Example Site");
    expect(result.screenshotDataUrl).toBe(
      `data:image/png;base64,${Buffer.from("fake-png-bytes").toString("base64")}`,
    );
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    const [scrapeUrl, scrapeInit] = mocks.fetch.mock.calls[0];
    expect(scrapeUrl).toBe("https://api.firecrawl.dev/v1/scrape");
    expect(scrapeInit.headers.Authorization).toBe("Bearer fc-test-key");
    const body = JSON.parse(scrapeInit.body);
    expect(body).toEqual({
      url: "https://example.com",
      formats: ["markdown", "screenshot@fullPage"],
      onlyMainContent: false,
    });
    const [screenshotUrl] = mocks.fetch.mock.calls[1];
    expect(screenshotUrl).toBe("https://cdn.example.com/shot.png");
  });

  it("throws a precondition error when no key is configured", async () => {
    mocks.readSettings.mockReturnValue({});
    await expect(
      callFirecrawlScrape("https://example.com", mockCtx()),
    ).rejects.toThrow("needs a Firecrawl API key");
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("throws on a non-OK scrape response", async () => {
    mocks.fetch.mockResolvedValue({
      ok: false,
      status: 402,
      statusText: "Payment Required",
      text: async () => "Insufficient credits",
    });
    await expect(
      callFirecrawlScrape("https://example.com", mockCtx()),
    ).rejects.toThrow("Firecrawl scrape failed: 402");
    expect(mocks.fetch).toHaveBeenCalledOnce();
  });

  it("throws when Firecrawl reports success: false", async () => {
    mocks.fetch.mockResolvedValue(
      scrapeResponse({ success: false, error: "Scrape failed" }),
    );
    await expect(
      callFirecrawlScrape("https://example.com", mockCtx()),
    ).rejects.toThrow("Firecrawl scrape failed: Scrape failed");
  });

  it("throws when the scrape returns no markdown", async () => {
    mocks.fetch.mockResolvedValue(
      scrapeResponse({
        data: { markdown: "   ", screenshot: undefined },
      }),
    );
    await expect(
      callFirecrawlScrape("https://example.com", mockCtx()),
    ).rejects.toThrow("No content available from web crawl");
  });

  it("returns markdown only when the scrape has no screenshot", async () => {
    mocks.fetch.mockResolvedValue(
      scrapeResponse({ data: { markdown: "# Example Site" } }),
    );
    const result = await callFirecrawlScrape("https://example.com", mockCtx());
    expect(result).toEqual({ markdown: "# Example Site" });
    expect(mocks.fetch).toHaveBeenCalledOnce();
  });

  it("returns markdown only when the screenshot download fails", async () => {
    mocks.fetch.mockResolvedValueOnce(scrapeResponse()).mockResolvedValueOnce({
      ok: false,
      status: 404,
      statusText: "Not Found",
    });
    const result = await callFirecrawlScrape("https://example.com", mockCtx());
    expect(result).toEqual({ markdown: "# Example Site" });
  });
});
