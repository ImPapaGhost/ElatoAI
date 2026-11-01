import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const envFile = new URL("../.env", import.meta.url);
if (existsSync(envFile)) process.loadEnvFile(fileURLToPath(envFile));
const { createAppServer } = await import("./server.mjs");
const { readConfig } = await import("./config.mjs");
const config = readConfig();
const server = createAppServer({ config });
const port = Number(process.env.PORT || 3000);
server.listen(port, "127.0.0.1", () => {
  console.log(`Cardputer Voice dashboard: http://localhost:${port}`);
  if (!config.configured) console.log(`Setup needed: ${config.missing.join(", ")}`);
});
