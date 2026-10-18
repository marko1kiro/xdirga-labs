import { z } from "zod";
import log from "electron-log";
import { AgentContext } from "./types";
import { DyadError, DyadErrorKind } from "@/errors/dyad_error";
import { resolveLocalNineRouterProvider } from "./ninerouter_provider";

const logger = log.scope("ninerouter_web");

/**
 * Fork: web search / web fetch through the local 9Router gateway, not Dyad
 * Engine. 9Router exposes `POST /v1/search` (JSON) and
 * `POST /v1/web/fetch` (JSON), per the 9Router SKILL.md.
 *
 * Model selection is zero-config: try the `*-combo` model first (auto-fallback
 * across providers), and if the gateway rejects it (400/404), discover
 * `/v1/models/web` and use the first model with the matching `kind`.
 */

const NINEROUTER_SEARCH_COMBO_MODEL = "search-combo";
const NINEROUTER_FETCH_COMBO_MODEL = "fetch-combo";
const WEB_TIMEOUT_MS = 60_000;

type Ctx = Pick<AgentContext, "dyadRequestId" | "abortSignal">;

const nineRouterSearchResultSchema = z.object({
  title: z.string().optional().nullable(),
  url: z.string().optional().nullable(),
  snippet: z.string().optional().nullable(),
});

const nineRouterSearchResponseSchema = z.object({
  results: z.array(nineRouterSearchResultSchema).optional(),
  answer: z.string().optional().nullable(),
});

const nineRouterFetchResponseSchema = z.object({
  url: z.string().optional(),
  title: z.string().optional().nullable(),
  content: z.object({
    text: z.string(),
  }),
});

const nineRouterModelsWebResponseSchema = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      kind: z.string().optional(),
    }),
  ),
});

function withTimeout(signal: AbortSignal | undefined): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(WEB_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

async function postNineRouter(
  baseUrl: string,
  apiKey: string,
  path: string,
  body: unknown,
  signal: AbortSignal | undefined,
): Promise<Response> {
  const endpoint = `${baseUrl.replace(/\/+$/, "")}${path}`;
  return fetch(endpoint, {
    method: "POST",
    signal: withTimeout(signal),
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
}

/**
 * Discover the first 9Router web model of the given kind via
 * `GET /v1/models/web`. Returns undefined when the gateway has no such
 * provider configured.
 */
async function discoverWebModel(
  baseUrl: string,
  apiKey: string,
  kind: "webSearch" | "webFetch",
  signal: AbortSignal | undefined,
): Promise<string | undefined> {
  const endpoint = `${baseUrl.replace(/\/+$/, "")}/models/web`;
  const response = await fetch(endpoint, {
    method: "GET",
    signal: withTimeout(signal),
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });
  if (!response.ok) {
    logger.warn(
      `9Router web model discovery failed: ${response.status} ${response.statusText}`,
    );
    return undefined;
  }
  const data = nineRouterModelsWebResponseSchema.parse(await response.json());
  const suffix = kind === "webSearch" ? "/search" : "/fetch";
  const entry = data.data.find(
    (model) => model.kind === kind || model.id.endsWith(suffix),
  );
  return entry?.id;
}

function throwUpstreamError(
  label: string,
  response: Response,
  errorText: string,
): never {
  throw new Error(
    `${label} failed: ${response.status} ${response.statusText} - ${errorText}`,
  );
}

/** Format 9Router search results into the plain-text result the agent reads. */
function formatSearchResults(
  query: string,
  data: z.infer<typeof nineRouterSearchResponseSchema>,
): string {
  const results = data.results ?? [];
  const lines = [`## Web search results for "${query}"`, ""];
  if (data.answer) {
    lines.push(data.answer, "");
  }
  results.forEach((result, index) => {
    lines.push(`### ${index + 1}. ${result.title ?? result.url ?? "Result"}`);
    if (result.url) lines.push(result.url);
    if (result.snippet) lines.push(result.snippet);
    lines.push("");
  });
  return lines.join("\n").trim();
}

/**
 * Web search via 9Router `POST /v1/search`. Returns the formatted text
 * result. Throws when no web search provider is configured on the gateway.
 */
export async function callNineRouterSearch(
  query: string,
  ctx: Ctx,
): Promise<string> {
  const resolved = await resolveLocalNineRouterProvider();
  if (!resolved) {
    throw new DyadError(
      "Web search needs the local 9Router provider configured as a custom provider in Settings.",
      DyadErrorKind.Precondition,
    );
  }
  const { baseUrl, apiKey } = resolved;

  let model = NINEROUTER_SEARCH_COMBO_MODEL;
  let response = await postNineRouter(
    baseUrl,
    apiKey,
    "/search",
    { model, query, max_results: 10 },
    ctx.abortSignal,
  );

  if (response.status === 400 || response.status === 404) {
    // Combo model not available on this gateway — fall back to discovery.
    const discovered = await discoverWebModel(
      baseUrl,
      apiKey,
      "webSearch",
      ctx.abortSignal,
    );
    if (!discovered) {
      throw new DyadError(
        "No web search provider is configured in 9Router. Add one (e.g. Tavily) in the 9Router dashboard.",
        DyadErrorKind.Precondition,
      );
    }
    model = discovered;
    response = await postNineRouter(
      baseUrl,
      apiKey,
      "/search",
      { model, query, max_results: 10 },
      ctx.abortSignal,
    );
  }

  if (!response.ok) {
    throwUpstreamError("Web search", response, await response.text());
  }

  const data = nineRouterSearchResponseSchema.parse(await response.json());
  if ((!data.results || data.results.length === 0) && !data.answer) {
    throw new DyadError(
      "Web search returned no results",
      DyadErrorKind.External,
    );
  }
  return formatSearchResults(query, data);
}

/**
 * Web fetch via 9Router `POST /v1/web/fetch`. Returns the content in the
 * Dyad web-fetch shape (`{ rootUrl, pages }`) so callers need no changes.
 * Throws when no web fetch provider is configured on the gateway.
 */
export async function callNineRouterFetch(
  url: string,
  ctx: Ctx,
): Promise<{ rootUrl: string; pages: { url: string; markdown: string }[] }> {
  const resolved = await resolveLocalNineRouterProvider();
  if (!resolved) {
    throw new DyadError(
      "Web fetch needs the local 9Router provider configured as a custom provider in Settings.",
      DyadErrorKind.Precondition,
    );
  }
  const { baseUrl, apiKey } = resolved;

  let model = NINEROUTER_FETCH_COMBO_MODEL;
  let response = await postNineRouter(
    baseUrl,
    apiKey,
    "/web/fetch",
    { model, url, format: "markdown" },
    ctx.abortSignal,
  );

  if (response.status === 400 || response.status === 404) {
    // Combo model not available on this gateway — fall back to discovery.
    const discovered = await discoverWebModel(
      baseUrl,
      apiKey,
      "webFetch",
      ctx.abortSignal,
    );
    if (!discovered) {
      throw new DyadError(
        "No web fetch provider is configured in 9Router. Add one (e.g. Firecrawl or Jina Reader) in the 9Router dashboard.",
        DyadErrorKind.Precondition,
      );
    }
    model = discovered;
    response = await postNineRouter(
      baseUrl,
      apiKey,
      "/web/fetch",
      { model, url, format: "markdown" },
      ctx.abortSignal,
    );
  }

  if (!response.ok) {
    throwUpstreamError("Web fetch", response, await response.text());
  }

  const data = nineRouterFetchResponseSchema.parse(await response.json());
  const text = data.content.text.trim();
  if (!text) {
    throw new DyadError(
      "No content available from web fetch",
      DyadErrorKind.NotFound,
    );
  }
  const pageUrl = data.url ?? url;
  const markdown = data.title ? `# ${data.title}\n\n${text}` : text;
  return { rootUrl: pageUrl, pages: [{ url: pageUrl, markdown }] };
}
