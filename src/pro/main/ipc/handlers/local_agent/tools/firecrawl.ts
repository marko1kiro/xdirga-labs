import { z } from "zod";
import log from "electron-log";
import { AgentContext } from "./types";
import { DyadError, DyadErrorKind } from "@/errors/dyad_error";
import { readSettings } from "@/main/settings";
import { getEnvVar } from "@/ipc/utils/read_env";

const logger = log.scope("firecrawl");

/**
 * Fork: direct Firecrawl scrape for `web_crawl`, so cloning gets a real
 * full-page screenshot without touching the 9Router repo. 9Router's fetch
 * normalization drops Firecrawl's `screenshot` field, so the gateway cannot
 * return a screenshot today — this module calls api.firecrawl.dev directly.
 *
 * The API key lives in Settings (Integrations > Firecrawl) or in the
 * `FIRECRAWL_API_KEY` env var. When no key is configured, callers fall back
 * to the 9Router (markdown-only) or Dyad Engine crawl paths.
 */

const FIRECRAWL_SCRAPE_URL = "https://api.firecrawl.dev/v1/scrape";
const FIRECRAWL_SCRAPE_TIMEOUT_MS = 120_000;
const FIRECRAWL_SCREENSHOT_DOWNLOAD_TIMEOUT_MS = 60_000;

type Ctx = Pick<AgentContext, "dyadRequestId" | "abortSignal">;

const firecrawlScrapeResponseSchema = z.object({
  success: z.boolean().optional(),
  error: z.string().optional(),
  data: z
    .object({
      markdown: z.string().optional(),
      screenshot: z.string().optional(),
      metadata: z
        .object({
          title: z.string().optional().nullable(),
        })
        .optional()
        .nullable(),
    })
    .optional(),
});

/**
 * Resolve the Firecrawl API key from Settings or the environment.
 * Returns `null` when no key is configured, so callers can fall back to
 * the 9Router / Dyad crawl paths.
 */
export async function resolveFirecrawlApiKey(): Promise<string | null> {
  const settings = readSettings();
  const apiKey =
    settings.firecrawlApiKey?.value?.trim() ||
    getEnvVar("FIRECRAWL_API_KEY")?.trim();
  return apiKey || null;
}

function withTimeout(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

/**
 * Download the screenshot URL Firecrawl returned and convert it to a data
 * URL, the shape the crawl message builder expects. Returns `undefined`
 * when the download fails — the crawl still succeeds on markdown alone.
 */
async function downloadScreenshotAsDataUrl(
  screenshotUrl: string,
  signal: AbortSignal | undefined,
): Promise<string | undefined> {
  try {
    const response = await fetch(screenshotUrl, {
      signal: withTimeout(signal, FIRECRAWL_SCREENSHOT_DOWNLOAD_TIMEOUT_MS),
    });
    if (!response.ok) {
      logger.warn(
        `Firecrawl screenshot download failed: ${response.status} ${response.statusText}`,
      );
      return undefined;
    }
    const contentType =
      response.headers.get("content-type")?.split(";")[0]?.trim() ||
      "image/png";
    const arrayBuffer = await response.arrayBuffer();
    const base64 = Buffer.from(arrayBuffer).toString("base64");
    return `data:${contentType};base64,${base64}`;
  } catch (error) {
    logger.warn("Firecrawl screenshot download failed:", error);
    return undefined;
  }
}

/**
 * Scrape a URL via Firecrawl directly, requesting markdown plus a
 * full-page screenshot. Throws when no key is configured or the scrape
 * fails / returns no markdown.
 */
export async function callFirecrawlScrape(
  url: string,
  ctx: Ctx,
): Promise<{ markdown: string; screenshotDataUrl?: string }> {
  const apiKey = await resolveFirecrawlApiKey();
  if (!apiKey) {
    throw new DyadError(
      "Web crawl with screenshot needs a Firecrawl API key. Add it in Settings > Integrations > Firecrawl.",
      DyadErrorKind.Precondition,
    );
  }

  const response = await fetch(FIRECRAWL_SCRAPE_URL, {
    method: "POST",
    signal: withTimeout(ctx.abortSignal, FIRECRAWL_SCRAPE_TIMEOUT_MS),
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      url,
      // Full-page screenshot so the agent sees the whole layout when cloning.
      // `onlyMainContent: false` keeps nav/footer, which cloning needs too.
      formats: ["markdown", "screenshot@fullPage"],
      onlyMainContent: false,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Firecrawl scrape failed: ${response.status} ${response.statusText} - ${errorText}`,
    );
  }

  const data = firecrawlScrapeResponseSchema.parse(await response.json());
  if (data.success === false) {
    throw new Error(
      `Firecrawl scrape failed: ${data.error ?? "unknown error"}`,
    );
  }
  const markdown = data.data?.markdown?.trim();
  if (!markdown) {
    throw new DyadError(
      "No content available from web crawl",
      DyadErrorKind.External,
    );
  }

  let screenshotDataUrl: string | undefined;
  const screenshotUrl = data.data?.screenshot;
  if (screenshotUrl) {
    screenshotDataUrl = await downloadScreenshotAsDataUrl(
      screenshotUrl,
      ctx.abortSignal,
    );
    if (!screenshotDataUrl) {
      logger.warn(
        "Firecrawl scrape returned a screenshot URL but it could not be downloaded; continuing with markdown only.",
      );
    }
  } else {
    logger.warn(
      "Firecrawl scrape returned no screenshot; continuing with markdown only.",
    );
  }

  return { markdown, screenshotDataUrl };
}
