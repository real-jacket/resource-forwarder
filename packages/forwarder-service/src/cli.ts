import { buildServer } from "./index.js";
import { loadOrCreateToken, resolveTokenPath } from "./auth.js";
import { DEFAULT_SERVICE_PORT, resolveStorageRoot } from "./defaults.js";
import { WorkspaceStorage } from "./storage.js";

async function main(): Promise<void> {
  const port = Number.parseInt(process.env.PORT ?? `${DEFAULT_SERVICE_PORT}`, 10);
  const storageRoot = process.env.RF_STORAGE_ROOT ?? resolveStorageRoot();
  const storage = new WorkspaceStorage(storageRoot);
  await storage.init();

  const authToken = await loadOrCreateToken(storageRoot);
  const tokenPath = resolveTokenPath(storageRoot);
  const extensionId = process.env.RF_EXTENSION_ID?.trim() || undefined;

  const app = buildServer({ storage, authToken, extensionId });
  await app.listen({ port, host: "127.0.0.1" });
  console.log(`Resource Forwarder service listening on http://127.0.0.1:${port}`);
  // Print every launch, not just the "freshly generated" path: even when the
  // token is re-used, an operator restarting the service will appreciate not
  // having to grep for the file.
  console.log(`[forwarder-service] auth token file: ${tokenPath}`);
  console.log(`[forwarder-service] paste the token's contents into the extension settings page.`);
}

void main();
