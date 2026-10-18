import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useSettings } from "@/hooks/useSettings";
import { showSuccess, showError } from "@/lib/toast";
import { ipc } from "@/ipc/types";

/**
 * Fork: Firecrawl API key for direct web crawls with a full-page
 * screenshot (used by the web_crawl tool when cloning a site). 9Router
 * cannot return screenshots, so crawls bypass the gateway when this key is
 * set. The key is encrypted by the main process on save, like the other
 * integration tokens.
 */
export function FirecrawlIntegration() {
  const { settings, updateSettings } = useSettings();
  const [apiKey, setApiKey] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [isDisconnecting, setIsDisconnecting] = useState(false);

  const isConnected = !!settings?.firecrawlApiKey;

  const handleSave = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!apiKey.trim()) return;
    setIsSaving(true);
    try {
      const result = await updateSettings({
        firecrawlApiKey: { value: apiKey.trim() },
      });
      if (result) {
        showSuccess("Firecrawl API key saved.");
        setApiKey("");
      } else {
        showError("Failed to save Firecrawl API key.");
      }
    } catch (err: any) {
      showError(err.message || "Failed to save Firecrawl API key.");
    } finally {
      setIsSaving(false);
    }
  };

  const handleDisconnect = async () => {
    setIsDisconnecting(true);
    try {
      const result = await updateSettings({ firecrawlApiKey: undefined });
      if (result) {
        showSuccess("Firecrawl API key removed.");
      } else {
        showError("Failed to remove Firecrawl API key.");
      }
    } catch (err: any) {
      showError(err.message || "Failed to remove Firecrawl API key.");
    } finally {
      setIsDisconnecting(false);
    }
  };

  if (isConnected) {
    return (
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300">
            Firecrawl Integration
          </h3>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
            Your Firecrawl API key is saved. Web crawls will include a full-page
            screenshot when cloning a website.
          </p>
        </div>
        <Button
          onClick={handleDisconnect}
          variant="destructive"
          size="sm"
          disabled={isDisconnecting}
          className="flex items-center gap-2"
        >
          {isDisconnecting ? "Removing..." : "Remove API Key"}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300">
          Firecrawl Integration
        </h3>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
          Add your Firecrawl API key so web crawls can include a full-page
          screenshot when cloning a website. Without a key, crawls use the local
          9Router gateway (markdown only). The free tier includes 1,000 credits
          per month, and a crawl with screenshot costs 1 credit.
        </p>
        <Button
          variant="link"
          size="sm"
          className="h-auto p-0 text-xs"
          onClick={() =>
            ipc.system.openExternalUrl("https://www.firecrawl.dev/")
          }
        >
          Get a Firecrawl API key
        </Button>
      </div>
      <form onSubmit={handleSave} className="space-y-3">
        <div>
          <Label
            htmlFor="firecrawl-api-key"
            className="block text-sm font-medium mb-1"
          >
            Firecrawl API Key
          </Label>
          <Input
            id="firecrawl-api-key"
            type="password"
            placeholder="Paste your Firecrawl API key (fc-...)"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            disabled={isSaving}
            className="w-full"
          />
        </div>
        <Button type="submit" disabled={!apiKey.trim() || isSaving}>
          {isSaving ? "Saving..." : "Save API Key"}
        </Button>
      </form>
    </div>
  );
}
