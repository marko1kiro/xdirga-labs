import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const settings = vi.hoisted(() => ({
  value: {} as Record<string, unknown>,
  updateSettings: vi.fn(),
}));
vi.mock("@/hooks/useSettings", () => ({
  useSettings: () => ({
    settings: settings.value,
    updateSettings: settings.updateSettings,
  }),
}));
const showSuccess = vi.hoisted(() => vi.fn());
const showError = vi.hoisted(() => vi.fn());
vi.mock("@/lib/toast", () => ({ showSuccess, showError }));
const openExternalUrl = vi.hoisted(() => vi.fn());
vi.mock("@/ipc/types", () => ({
  ipc: { system: { openExternalUrl } },
}));

const { FirecrawlIntegration } = await import("./FirecrawlIntegration");

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("the Firecrawl card in Settings", () => {
  it("shows the API key form without a saved key", () => {
    settings.value = {};
    render(<FirecrawlIntegration />);
    expect(screen.getByText("Firecrawl Integration")).toBeTruthy();
    expect(screen.getByLabelText("Firecrawl API Key")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save API Key" })).toBeTruthy();
  });

  it("saves a trimmed API key", async () => {
    settings.value = {};
    settings.updateSettings.mockResolvedValue(true);
    render(<FirecrawlIntegration />);
    fireEvent.change(screen.getByLabelText("Firecrawl API Key"), {
      target: { value: "  fc-test-key  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save API Key" }));
    await waitFor(() =>
      expect(settings.updateSettings).toHaveBeenCalledWith({
        firecrawlApiKey: { value: "fc-test-key" },
      }),
    );
    expect(showSuccess).toHaveBeenCalledWith("Firecrawl API key saved.");
  });

  it("shows the connected state and removes the key", async () => {
    settings.value = { firecrawlApiKey: { value: "fc-test-key" } };
    settings.updateSettings.mockResolvedValue(true);
    render(<FirecrawlIntegration />);
    expect(screen.getByText(/full-page screenshot when cloning/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove API Key" }));
    await waitFor(() =>
      expect(settings.updateSettings).toHaveBeenCalledWith({
        firecrawlApiKey: undefined,
      }),
    );
    expect(showSuccess).toHaveBeenCalledWith("Firecrawl API key removed.");
  });
});
