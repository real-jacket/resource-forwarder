import { buildServer } from "./index.js";
import { DEFAULT_SERVICE_PORT, resolveStorageRoot } from "./defaults.js";
import { WorkspaceStorage } from "./storage.js";

async function main(): Promise<void> {
  const port = Number.parseInt(process.env.PORT ?? `${DEFAULT_SERVICE_PORT}`, 10);
  const storage = new WorkspaceStorage(process.env.RF_STORAGE_ROOT ?? resolveStorageRoot());
  await storage.init();

  const app = buildServer({ storage });
  await app.listen({ port, host: "127.0.0.1" });
  console.log(`Resource Forwarder service listening on http://127.0.0.1:${port}`);
}

void main();
