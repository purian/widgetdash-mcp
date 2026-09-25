#!/usr/bin/env node
/**
 * widgetdash-mcp -- stdio MCP server that lets AI agents push numbers to
 * WidgetDash iPhone Home Screen / Lock Screen widgets and Live Activities.
 *
 * Env:
 *   WIDGETDASH_WRITE_KEY  write key (required for push/delete tools)
 *   WIDGETDASH_READ_KEY   read key (optional; read tools fall back to the write key)
 *   WIDGETDASH_API_URL    API base URL (default https://api.widgetdash.app)
 *
 * stdout is reserved for the MCP protocol; diagnostics go to stderr and never
 * include keys.
 */
import { createRequire } from "node:module";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { ConfigError, WidgetDashClient, loadConfig } from "./api.js";
import { createServer } from "./server.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

async function main(): Promise<void> {
  const config = loadConfig(process.env, `widgetdash-mcp/${version}`);
  if (!config.writeKey && !config.readKey) {
    console.error(
      "[widgetdash-mcp] Warning: neither WIDGETDASH_WRITE_KEY nor WIDGETDASH_READ_KEY is set; tools will return a " +
        "configuration error. Get your keys at https://widgetdash.app/app",
    );
  }
  const server = createServer(new WidgetDashClient(config), version);
  await server.connect(new StdioServerTransport());
}

// Never let a stray rejection kill the stdio session (the MCP client would just see "connection closed").
process.on("unhandledRejection", (err) => {
  console.error(`[widgetdash-mcp] Unhandled error: ${err instanceof Error ? err.message : String(err)}`);
});

main().catch((err) => {
  console.error(`[widgetdash-mcp] ${err instanceof ConfigError ? err.message : "Fatal error"}`);
  if (!(err instanceof ConfigError)) console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
