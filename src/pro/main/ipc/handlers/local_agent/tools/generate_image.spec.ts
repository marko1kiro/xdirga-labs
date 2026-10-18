import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { callGenerateImage } from "./generate_image";

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

describe("callGenerateImage (local 9Router)", () => {
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

  it("posts to the local 9Router image endpoint with the image model", async () => {
    mocks.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => "",
      json: async () => ({
        created: 123,
        data: [{ b64_json: "aGVsbG8=" }],
      }),
    });

    const result = await callGenerateImage("a cat", mockCtx());

    expect(result).toMatchObject({ b64_json: "aGVsbG8=" });
    expect(mocks.fetch).toHaveBeenCalledOnce();
    const [url, options] = mocks.fetch.mock.calls[0];
    expect(url).toBe("http://localhost:20128/v1/images/generations");
    expect(options.method).toBe("POST");
    expect(options.headers.Authorization).toBe("Bearer local-key");
    expect(JSON.parse(options.body)).toMatchObject({
      prompt: "a cat",
      model: "ag/gemini-3.1-flash-image",
    });
  });

  it("matches the local provider despite trailing slash and 127.0.0.1", async () => {
    mocks.getLanguageModelProviders.mockResolvedValue([
      { ...localProvider, apiBaseUrl: "http://127.0.0.1:20128/v1/" },
    ]);
    mocks.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => "",
      json: async () => ({
        created: 123,
        data: [{ url: "https://example.com/img.png" }],
      }),
    });

    await callGenerateImage("a cat", mockCtx());

    expect(mocks.fetch).toHaveBeenCalledOnce();
    const [url] = mocks.fetch.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:20128/v1/images/generations");
  });

  it("rejects when the local 9Router provider is not configured", async () => {
    mocks.getLanguageModelProviders.mockResolvedValue([]);

    await expect(callGenerateImage("a cat", mockCtx())).rejects.toThrow(
      "local 9Router provider",
    );
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("rejects when the provider has no API key", async () => {
    mocks.readSettings.mockReturnValue({ providerSettings: {} });

    await expect(callGenerateImage("a cat", mockCtx())).rejects.toThrow(
      "API key",
    );
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("surfaces upstream failures", async () => {
    mocks.fetch.mockResolvedValue({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      text: async () => "bad key",
      json: async () => ({}),
    });

    await expect(callGenerateImage("a cat", mockCtx())).rejects.toThrow(
      "Image generation failed: 401 Unauthorized - bad key",
    );
  });
});
