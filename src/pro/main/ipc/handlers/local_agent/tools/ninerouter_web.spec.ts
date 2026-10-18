import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { callNineRouterSearch, callNineRouterFetch } from "./ninerouter_web";

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
  };
}

function jsonResponse(
  status: number,
  body: unknown,
  statusText = "OK",
): {
  ok: boolean;
  status: number;
  statusText: string;
  text: () => Promise<string>;
  json: () => Promise<unknown>;
} {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    text: async () => (typeof body === "string" ? body : ""),
    json: async () => body,
  };
}

describe("callNineRouterSearch", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", mocks.fetch);
    mocks.readSettings.mockReturnValue({
      providerSettings: {
        "nine-router-local": { apiKey: { value: "local-key" } },
      },
    });
    mocks.getLanguageModelProviders.mockResolvedValue([localProvider]);
    mocks.getEnvVar.mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetAllMocks();
  });

  it("posts to the 9Router search endpoint with the combo model", async () => {
    mocks.fetch.mockResolvedValue(
      jsonResponse(200, {
        provider: "tavily",
        query: "NextJS 14",
        results: [
          {
            title: "Next.js 14 Docs",
            url: "https://nextjs.org/docs",
            snippet: "The React framework.",
            position: 1,
          },
          {
            title: "Next.js Blog",
            url: "https://nextjs.org/blog",
            snippet: "Latest news.",
            position: 2,
          },
        ],
      }),
    );

    const result = await callNineRouterSearch("NextJS 14", mockCtx());

    expect(result).toContain('## Web search results for "NextJS 14"');
    expect(result).toContain("### 1. Next.js 14 Docs");
    expect(result).toContain("https://nextjs.org/docs");
    expect(result).toContain("The React framework.");
    expect(result).toContain("### 2. Next.js Blog");
    expect(mocks.fetch).toHaveBeenCalledOnce();
    const [url, options] = mocks.fetch.mock.calls[0];
    expect(url).toBe("http://localhost:20128/v1/search");
    expect(options.method).toBe("POST");
    expect(options.headers.Authorization).toBe("Bearer local-key");
    expect(JSON.parse(options.body)).toMatchObject({
      model: "search-combo",
      query: "NextJS 14",
    });
  });

  it("falls back to a discovered model when the combo model is rejected", async () => {
    mocks.fetch
      .mockResolvedValueOnce(
        jsonResponse(400, "Invalid model format", "Bad Request"),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          object: "list",
          data: [{ id: "tavily/search", kind: "webSearch" }],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
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
      );

    const result = await callNineRouterSearch("NextJS 14", mockCtx());

    expect(result).toContain("Next.js 14 Docs");
    expect(mocks.fetch).toHaveBeenCalledTimes(3);
    const [discoveryUrl] = mocks.fetch.mock.calls[1];
    expect(discoveryUrl).toBe("http://localhost:20128/v1/models/web");
    const [retryUrl, retryOptions] = mocks.fetch.mock.calls[2];
    expect(retryUrl).toBe("http://localhost:20128/v1/search");
    expect(JSON.parse(retryOptions.body)).toMatchObject({
      model: "tavily/search",
    });
  });

  it("rejects when no web search provider is configured", async () => {
    mocks.fetch
      .mockResolvedValueOnce(
        jsonResponse(400, "Invalid model format", "Bad Request"),
      )
      .mockResolvedValueOnce(jsonResponse(200, { object: "list", data: [] }));

    await expect(callNineRouterSearch("NextJS 14", mockCtx())).rejects.toThrow(
      "No web search provider",
    );
  });

  it("rejects when the gateway returns no results", async () => {
    mocks.fetch.mockResolvedValue(
      jsonResponse(200, {
        provider: "tavily",
        query: "NextJS 14",
        results: [],
        answer: null,
      }),
    );

    await expect(callNineRouterSearch("NextJS 14", mockCtx())).rejects.toThrow(
      "Web search returned no results",
    );
  });

  it("surfaces upstream failures without a discovery retry", async () => {
    mocks.fetch.mockResolvedValue(jsonResponse(401, "bad key", "Unauthorized"));

    await expect(callNineRouterSearch("NextJS 14", mockCtx())).rejects.toThrow(
      "Web search failed: 401 Unauthorized - bad key",
    );
    expect(mocks.fetch).toHaveBeenCalledOnce();
  });
});

describe("callNineRouterFetch", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", mocks.fetch);
    mocks.readSettings.mockReturnValue({
      providerSettings: {
        "nine-router-local": { apiKey: { value: "local-key" } },
      },
    });
    mocks.getLanguageModelProviders.mockResolvedValue([localProvider]);
    mocks.getEnvVar.mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetAllMocks();
  });

  it("posts to the 9Router web fetch endpoint and maps to the Dyad shape", async () => {
    mocks.fetch.mockResolvedValue(
      jsonResponse(200, {
        provider: "jina-reader",
        url: "https://example.com/guide",
        title: "Example Guide",
        content: {
          format: "markdown",
          text: "# Hello\n\nBody text.",
          length: 21,
        },
      }),
    );

    const result = await callNineRouterFetch(
      "https://example.com/guide",
      mockCtx(),
    );

    expect(result).toEqual({
      rootUrl: "https://example.com/guide",
      pages: [
        {
          url: "https://example.com/guide",
          markdown: "# Example Guide\n\n# Hello\n\nBody text.",
        },
      ],
    });
    expect(mocks.fetch).toHaveBeenCalledOnce();
    const [url, options] = mocks.fetch.mock.calls[0];
    expect(url).toBe("http://localhost:20128/v1/web/fetch");
    expect(options.method).toBe("POST");
    expect(options.headers.Authorization).toBe("Bearer local-key");
    expect(JSON.parse(options.body)).toMatchObject({
      model: "fetch-combo",
      url: "https://example.com/guide",
      format: "markdown",
    });
  });

  it("falls back to a discovered model when the combo model is rejected", async () => {
    mocks.fetch
      .mockResolvedValueOnce(jsonResponse(404, "not found", "Not Found"))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          object: "list",
          data: [{ id: "firecrawl/fetch", kind: "webFetch" }],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          provider: "firecrawl",
          url: "https://example.com/guide",
          content: { format: "markdown", text: "Body text.", length: 10 },
        }),
      );

    const result = await callNineRouterFetch(
      "https://example.com/guide",
      mockCtx(),
    );

    expect(result.pages[0].markdown).toBe("Body text.");
    expect(mocks.fetch).toHaveBeenCalledTimes(3);
    const [retryUrl, retryOptions] = mocks.fetch.mock.calls[2];
    expect(retryUrl).toBe("http://localhost:20128/v1/web/fetch");
    expect(JSON.parse(retryOptions.body)).toMatchObject({
      model: "firecrawl/fetch",
    });
  });

  it("rejects when no web fetch provider is configured", async () => {
    mocks.fetch
      .mockResolvedValueOnce(jsonResponse(404, "not found", "Not Found"))
      .mockResolvedValueOnce(jsonResponse(200, { object: "list", data: [] }));

    await expect(
      callNineRouterFetch("https://example.com/guide", mockCtx()),
    ).rejects.toThrow("No web fetch provider");
  });

  it("rejects when the gateway returns empty content", async () => {
    mocks.fetch.mockResolvedValue(
      jsonResponse(200, {
        provider: "jina-reader",
        url: "https://example.com/guide",
        content: { format: "markdown", text: "   ", length: 0 },
      }),
    );

    await expect(
      callNineRouterFetch("https://example.com/guide", mockCtx()),
    ).rejects.toThrow("No content available from web fetch");
  });
});
