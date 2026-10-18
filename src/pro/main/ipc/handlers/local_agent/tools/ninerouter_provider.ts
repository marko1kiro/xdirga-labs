import { DyadError, DyadErrorKind } from "@/errors/dyad_error";
import { readSettings } from "@/main/settings";
import { getLanguageModelProviders } from "@/ipc/shared/language_model_helpers";
import { getEnvVar } from "@/ipc/utils/read_env";

/**
 * Fork: the local 9Router gateway (OpenAI-compatible) that replaces Dyad
 * Engine for tool calls when it is configured as a custom provider.
 * Provider base URLs in Dyad settings include the `/v1` prefix, e.g.
 * `http://localhost:20128/v1`.
 */
export const LOCAL_NINEROUTER_BASE_URL = "http://localhost:20128/v1";

/** Normalize a provider base URL for comparison. */
export function normalizeBaseUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  // localhost and 127.0.0.1 are the same local gateway.
  return trimmed
    .replace("http://127.0.0.1", "http://localhost")
    .replace("https://127.0.0.1", "https://localhost");
}

/**
 * Find the local 9Router custom provider and its API key.
 *
 * Returns `null` when the provider is not configured at all, so callers can
 * fall back to the upstream Dyad Engine path. Throws when the provider IS
 * configured but has no API key, because falling back to Dyad in that case
 * would silently hit the Dyad server the user meant to avoid.
 */
export async function resolveLocalNineRouterProvider(): Promise<{
  baseUrl: string;
  apiKey: string;
} | null> {
  const settings = readSettings();
  const providers = await getLanguageModelProviders();
  const provider = providers.find(
    (p) =>
      p.type === "custom" &&
      p.apiBaseUrl &&
      normalizeBaseUrl(p.apiBaseUrl) ===
        normalizeBaseUrl(LOCAL_NINEROUTER_BASE_URL),
  );
  if (!provider) {
    return null;
  }
  const rawKey =
    settings.providerSettings?.[provider.id]?.apiKey?.value ||
    (provider.envVarName ? getEnvVar(provider.envVarName) : undefined);
  const apiKey = rawKey?.trim() || undefined;
  if (!apiKey) {
    throw new DyadError(
      `Tool needs an API key for the local 9Router provider (${provider.name ?? provider.id}). Add it in Settings.`,
      DyadErrorKind.Auth,
    );
  }
  return { baseUrl: provider.apiBaseUrl!, apiKey };
}
