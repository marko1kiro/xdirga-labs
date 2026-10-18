import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { callWebFetch } from "./web_fetch";

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
  };
}

describe("callWebFetch routing", () => {
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
        provider: "jina-reader",
        url: "https://example.com/guide",
        title: "Example Guide",
        content: { format: "markdown", text: "# Hello", length: 7 },
      }),
    });

    const result = await callWebFetch("https://example.com/guide", mockCtx());

    expect(result).toEqual({
      rootUrl: "https://example.com/guide",
      pages: [
        {
          url: "https://example.com/guide",
          markdown: "# Example Guide\n\n# Hello",
        },
      ],
    });
    expect(mocks.fetch).toHaveBeenCalledOnce();
    const [url] = mocks.fetch.mock.calls[0];
    expect(url).toBe("http://localhost:20128/v1/web/fetch");
    expect(mocks.engineFetch).not.toHaveBeenCalled();
  });

  it("falls back to Dyad Engine when no local provider is configured", async () => {
    mocks.getLanguageModelProviders.mockResolvedValue([]);
    mocks.engineFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => "",
      json: async () => ({
        rootUrl: "https://example.com/guide",
        pages: [{ url: "https://example.com/guide", markdown: "# Hi" }],
      }),
    });

    const result = await callWebFetch("https://example.com/guide", mockCtx());

    expect(result).toEqual({
      rootUrl: "https://example.com/guide",
      pages: [{ url: "https://example.com/guide", markdown: "# Hi" }],
    });
    expect(mocks.engineFetch).toHaveBeenCalledOnce();
    const [, path, options] = mocks.engineFetch.mock.calls[0];
    expect(path).toBe("/tools/web-crawl");
    expect(JSON.parse(options.body)).toMatchObject({
      url: "https://example.com/guide",
      markdownOnly: true,
    });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});
