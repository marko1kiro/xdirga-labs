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
});

describe("webCrawlTool execute Firecrawl routing", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", mocks.fetch);
    mocks.readSettings.mockReturnValue({
      firecrawlApiKey: { value: "fc-test-key" },
      providerSettings: {
        "nine-router-local": { apiKey: { value: "local-key" } },
      },
    });
    mocks.getEnvVar.mockReturnValue(undefined);
    mocks.getLanguageModelProviders.mockResolvedValue([localProvider]);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetAllMocks();
  });

  function mockFirecrawl(
    scrapeData: Record<string, unknown>,
    screenshotOk = true,
  ) {
    mocks.fetch.mockImplementation(async (url: string) => {
      if (url === "https://api.firecrawl.dev/v1/scrape") {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          text: async () => "",
          json: async () => ({ success: true, data: scrapeData }),
        };
      }
      if (!screenshotOk) {
        return { ok: false, status: 404, statusText: "Not Found" };
      }
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        headers: { get: () => "image/png" },
        arrayBuffer: async () =>
          new TextEncoder().encode("fake-png-bytes").buffer,
      };
    });
  }

  it("uses Firecrawl with screenshot + with-screenshot instructions when the key is configured (beats 9Router)", async () => {
    mockFirecrawl({
      markdown: "# Example Site",
      screenshot: "https://cdn.example.com/shot.png",
    });
    const ctx = mockCtx();

    const result = await webCrawlTool.execute(
      { url: "https://example.com" },
      ctx,
    );

    expect(result).toBe("Web crawl completed.");
    expect(mocks.engineFetch).not.toHaveBeenCalled();
    const calledUrls = mocks.fetch.mock.calls.map(([url]) => url);
    expect(calledUrls).toEqual([
      "https://api.firecrawl.dev/v1/scrape",
      "https://cdn.example.com/shot.png",
    ]);
    expect(ctx.appendUserMessage).toHaveBeenCalledOnce();
    const [messages] = (
      ctx.appendUserMessage as unknown as ReturnType<typeof vi.fn>
    ).mock.calls[0];
    const texts = messages
      .map((m: { text?: string }) => m.text ?? "")
      .join("\n");
    expect(texts).toContain(
      "Replicate the website from the provided screenshot image",
    );
    expect(texts).toContain("# Example Site");
    const imageMessage = messages.find(
      (m: { type?: string }) => m.type === "image-url",
    );
    expect(imageMessage?.url).toMatch(/^data:image\/png;base64,/);
  });

  it("uses markdown-only instructions when Firecrawl returns no screenshot", async () => {
    mockFirecrawl({ markdown: "# Example Site" });
    const ctx = mockCtx();

    await webCrawlTool.execute({ url: "https://example.com" }, ctx);

    expect(ctx.appendUserMessage).toHaveBeenCalledOnce();
    const [messages] = (
      ctx.appendUserMessage as unknown as ReturnType<typeof vi.fn>
    ).mock.calls[0];
    const texts = messages
      .map((m: { text?: string }) => m.text ?? "")
      .join("\n");
    expect(texts).toContain(
      "Replicate the website from the provided markdown snapshot.",
    );
    expect(
      messages.some((m: { type?: string }) => m.type === "image-url"),
    ).toBe(false);
  });

  it("omits an oversized Firecrawl screenshot and explains why", async () => {
    // Minimal PNG header with width 9000 (> MAX_IMAGE_DIMENSION 8000).
    const png = Buffer.alloc(24);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    png.writeUInt32BE(13, 8);
    png.write("IHDR", 12, "ascii");
    png.writeUInt32BE(9000, 16);
    png.writeUInt32BE(100, 20);
    mocks.fetch.mockImplementation(async (url: string) => {
      if (url === "https://api.firecrawl.dev/v1/scrape") {
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
            },
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        headers: { get: () => "image/png" },
        arrayBuffer: async () =>
          png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength),
      };
    });
    const ctx = mockCtx();

    await webCrawlTool.execute({ url: "https://example.com" }, ctx);

    const [messages] = (
      ctx.appendUserMessage as unknown as ReturnType<typeof vi.fn>
    ).mock.calls[0];
    const texts = messages
      .map((m: { text?: string }) => m.text ?? "")
      .join("\n");
    expect(texts).toContain(
      "Replicate the website from the provided markdown snapshot.",
    );
    expect(texts).toContain("Screenshot omitted");
    expect(
      messages.some((m: { type?: string }) => m.type === "image-url"),
    ).toBe(false);
  });

  it("does NOT fall back to 9Router/Dyad when Firecrawl fails", async () => {
    mocks.fetch.mockResolvedValue({
      ok: false,
      status: 402,
      statusText: "Payment Required",
      text: async () => "Insufficient credits",
    });
    const ctx = mockCtx();

    await expect(
      webCrawlTool.execute({ url: "https://example.com" }, ctx),
    ).rejects.toThrow("Firecrawl scrape failed: 402");
    expect(mocks.fetch).toHaveBeenCalledOnce();
    expect(mocks.engineFetch).not.toHaveBeenCalled();
    expect(ctx.appendUserMessage).not.toHaveBeenCalled();
  });
});

describe("webCrawlTool execute Dyad routing", () => {
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
