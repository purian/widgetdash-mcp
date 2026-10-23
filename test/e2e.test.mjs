/**
 * End-to-end test: WidgetDash API <- HTTP <- this MCP server (dist/index.js)
 * <- stdio <- official MCP client.
 *
 * By default the API is an in-memory mock (test/mock-api.mjs) that mirrors the
 * public WidgetDash API contract, so `npm test` runs anywhere with no network.
 *
 * To run the same suite against a real WidgetDash server checkout instead, set
 * WIDGETDASH_TEST_SERVER_DIR to its `server/` directory (and optionally
 * WIDGETDASH_TEST_PYTHON to its interpreter; default <dir>/.venv/bin/python).
 * It starts uvicorn on 127.0.0.1 with a throwaway SQLite database.
 *
 * Never touches production.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { startMockApi } from "./mock-api.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_DIR = resolve(HERE, "..");
const SERVER_DIR = process.env.WIDGETDASH_TEST_SERVER_DIR ? resolve(process.env.WIDGETDASH_TEST_SERVER_DIR) : null;
const ENTRY = join(PKG_DIR, "dist", "index.js");
const PYTHON = SERVER_DIR ? process.env.WIDGETDASH_TEST_PYTHON || join(SERVER_DIR, ".venv", "bin", "python") : null;

let apiUrl;
let uvicorn;
let mockApi;
let tmp;
let keys; // { api_key_read, api_key_write }
const clients = [];
const stderrChunks = [];

function freePort() {
  return new Promise((res, rej) => {
    const srv = createNetServer();
    srv.unref();
    srv.on("error", rej);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => res(port));
    });
  });
}

async function waitForHealth(url, proc, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`uvicorn exited early with code ${proc.exitCode}`);
    try {
      const r = await fetch(`${url}/health`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("WidgetDash server did not become healthy in time");
}

async function api(method, path, key, body) {
  const r = await fetch(`${apiUrl}${path}`, {
    method,
    headers: {
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}

async function newUser(name) {
  const r = await api("POST", "/api/v1/users", null, { name });
  assert.equal(r.status, 201);
  return r.json;
}

/** Start dist/index.js over stdio with the given env and return a connected client. */
async function connect(env) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [ENTRY],
    // Only pass what the server needs (plus PATH) so no ambient WIDGETDASH_* leaks in.
    env: { PATH: process.env.PATH ?? "", WIDGETDASH_API_URL: apiUrl, ...env },
    stderr: "pipe",
  });
  transport.stderr?.on("data", (d) => stderrChunks.push(d.toString()));
  const client = new Client({ name: "widgetdash-mcp-e2e", version: "0.0.0" });
  await client.connect(transport);
  clients.push(client);
  return client;
}

async function call(client, name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content.map((c) => c.text ?? "").join("\n");
  return { isError: Boolean(res.isError), text };
}

before(async () => {
  assert.ok(existsSync(ENTRY), "dist/index.js missing -- run `npm run build` first");
  if (!SERVER_DIR) {
    mockApi = await startMockApi();
    apiUrl = mockApi.url;
    keys = await newUser("mcp-e2e");
    return;
  }
  assert.ok(existsSync(PYTHON), `Python not found at ${PYTHON}. Create <server>/.venv or set WIDGETDASH_TEST_PYTHON.`);
  tmp = mkdtempSync(join(tmpdir(), "widgetdash-mcp-e2e-"));
  const port = await freePort();
  apiUrl = `http://127.0.0.1:${port}`;
  uvicorn = spawn(PYTHON, ["-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", String(port), "--log-level", "warning"], {
    cwd: SERVER_DIR,
    env: {
      PATH: process.env.PATH ?? "",
      WIDGET_SERVER_DATABASE_URL: `sqlite+aiosqlite:///${join(tmp, "e2e.db")}`,
      WIDGET_SERVER_ADMIN_KEY: randomBytes(32).toString("hex"),
      WIDGET_SERVER_RATE_LIMIT_PER_MINUTE: "10000",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let serverLog = "";
  uvicorn.stderr.on("data", (d) => (serverLog += d.toString()));
  try {
    await waitForHealth(apiUrl, uvicorn);
  } catch (err) {
    throw new Error(`${err.message}\n--- server log ---\n${serverLog}`);
  }
  keys = await newUser("mcp-e2e");
});

after(async () => {
  await Promise.allSettled(clients.map((c) => c.close()));
  if (mockApi) await mockApi.close();
  if (uvicorn && uvicorn.exitCode === null) {
    uvicorn.kill("SIGTERM");
    await new Promise((r) => uvicorn.once("exit", r));
  }
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe(`widgetdash-mcp over stdio against ${SERVER_DIR ? "a local WidgetDash server" : "the mock WidgetDash API"}`, () => {
  let mcp; // write + read key

  test("lists all tools with widget-oriented descriptions", async () => {
    mcp = await connect({ WIDGETDASH_WRITE_KEY: keys.api_key_write, WIDGETDASH_READ_KEY: keys.api_key_read });
    const { tools } = await mcp.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["delete_source", "get_widget_data", "list_sources", "push_metrics", "push_number"]);
    for (const t of tools) assert.match(t.description, /iPhone/, `${t.name} description mentions iPhone`);
    const push = tools.find((t) => t.name === "push_metrics");
    assert.deepEqual(push.inputSchema.required.sort(), ["metrics", "source_key"]);
    assert.equal(tools.find((t) => t.name === "delete_source").annotations.destructiveHint, true);
    assert.equal(tools.find((t) => t.name === "get_widget_data").annotations.readOnlyHint, true);
    const info = mcp.getServerVersion();
    assert.equal(info.name, "widgetdash");
    assert.match(mcp.getInstructions() ?? "", /iPhone/);
  });

  test("push_metrics creates a source exactly as the API stores it", async () => {
    const r = await call(mcp, "push_metrics", {
      source_key: "stripe",
      display_name: "Stripe",
      icon: "dollarsign.circle.fill",
      category: "finance",
      metrics: [
        { label: "MRR", value: "$12,400", type: "number", color: "green" },
        { label: "Customers", value: 312 },
        { label: "Quota", value: "72%", type: "progress", color: "blue" },
        { label: "Status", value: "Healthy", type: "status", color: "green" },
      ],
      raw_data: { currency: "USD" },
    });
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, /Created 'stripe'/);
    assert.match(r.text, /MRR: \$12,400/);

    const d = await api("GET", "/api/v1/data/stripe", keys.api_key_read);
    assert.equal(d.status, 200);
    assert.equal(d.json.display_name, "Stripe");
    assert.equal(d.json.icon, "dollarsign.circle.fill");
    assert.equal(d.json.category, "finance");
    assert.deepEqual(d.json.raw_data, { currency: "USD" });
    assert.deepEqual(d.json.metrics, [
      { label: "MRR", value: "$12,400", type: "number", color: "green", timestamp: null },
      { label: "Customers", value: "312", type: "number", color: null, timestamp: null },
      { label: "Quota", value: "72", type: "progress", color: "blue", timestamp: null },
      { label: "Status", value: "Healthy", type: "status", color: "green", timestamp: null },
    ]);
  });

  test("push_metrics keeps existing metadata, sort_order and raw_data when omitted", async () => {
    // Simulate the user reordering sources in the app.
    await api("PUT", "/api/v1/data/other", keys.api_key_write, { display_name: "Other", metrics: [] });
    const reorder = await api("PATCH", "/api/v1/sources/reorder", keys.api_key_write, { source_keys: ["other", "stripe"] });
    assert.equal(reorder.status, 200);

    const r = await call(mcp, "push_metrics", { source_key: "stripe", metrics: [{ label: "MRR", value: "$13,000", color: "green" }] });
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, /Updated 'stripe'/);
    const d = await api("GET", "/api/v1/data/stripe", keys.api_key_read);
    assert.equal(d.json.display_name, "Stripe");
    assert.equal(d.json.icon, "dollarsign.circle.fill");
    assert.equal(d.json.category, "finance");
    assert.deepEqual(d.json.raw_data, { currency: "USD" });
    assert.deepEqual(d.json.metrics, [{ label: "MRR", value: "$13,000", type: "number", color: "green", timestamp: null }]);
    const sources = await api("GET", "/api/v1/sources", keys.api_key_read);
    assert.equal(sources.json.find((s) => s.source_key === "stripe").sort_order, 1);
  });

  test("push_metrics can't move an existing source; sort_order places a new one", async () => {
    // stripe is at 1 after the app reorder in the previous test.
    const r = await call(mcp, "push_metrics", { source_key: "stripe", sort_order: 0, metrics: [{ label: "MRR", value: "$13,100" }] });
    assert.equal(r.isError, false, r.text);
    let sources = await api("GET", "/api/v1/sources", keys.api_key_read);
    assert.equal(sources.json.find((s) => s.source_key === "stripe").sort_order, 1);

    const created = await call(mcp, "push_metrics", { source_key: "placed", sort_order: 5, metrics: [{ label: "Count", value: "1" }] });
    assert.equal(created.isError, false, created.text);
    sources = await api("GET", "/api/v1/sources", keys.api_key_read);
    assert.equal(sources.json.find((s) => s.source_key === "placed").sort_order, 5);
    const cleanup = await call(mcp, "delete_source", { source_key: "placed" });
    assert.equal(cleanup.isError, false, cleanup.text);
  });

  test("push_number updates one metric in place and appends new ones", async () => {
    await call(mcp, "push_metrics", {
      source_key: "stripe",
      metrics: [
        { label: "MRR", value: "$13,000", type: "number", color: "green" },
        { label: "Churn", value: "2.1%", type: "percentage" },
      ],
    });
    let r = await call(mcp, "push_number", { source_key: "stripe", label: "MRR", value: "$14,250", color: "green" });
    assert.equal(r.isError, false, r.text);
    r = await call(mcp, "push_number", { source_key: "stripe", label: "Trials", value: 9 });
    assert.equal(r.isError, false, r.text);
    const d = await api("GET", "/api/v1/data/stripe", keys.api_key_read);
    assert.equal(d.json.display_name, "Stripe");
    assert.deepEqual(d.json.metrics, [
      { label: "MRR", value: "$14,250", type: "number", color: "green", timestamp: null },
      { label: "Churn", value: "2.1%", type: "percentage", color: null, timestamp: null },
      { label: "Trials", value: "9", type: "number", color: null, timestamp: null },
    ]);
    // Omitted type/color keep the existing metric's style; text values stay text.
    r = await call(mcp, "push_number", { source_key: "stripe", label: "Churn", value: "1.9%" });
    assert.equal(r.isError, false, r.text);
    r = await call(mcp, "push_number", { source_key: "stripe", label: "Plan", value: "Scale" });
    assert.equal(r.isError, false, r.text);
    const d2 = await api("GET", "/api/v1/data/stripe", keys.api_key_read);
    assert.deepEqual(d2.json.metrics.slice(1), [
      { label: "Churn", value: "1.9%", type: "percentage", color: null, timestamp: null },
      { label: "Trials", value: "9", type: "number", color: null, timestamp: null },
      { label: "Plan", value: "Scale", type: "text", color: null, timestamp: null },
    ]);
  });

  test("push_number creates a new source with a readable default title", async () => {
    const r = await call(mcp, "push_number", { source_key: "open_tickets", label: "Open", value: 7, color: "yellow", icon: "ticket.fill" });
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, /Created 'open_tickets'/);
    const d = await api("GET", "/api/v1/data/open_tickets", keys.api_key_read);
    assert.equal(d.json.display_name, "Open Tickets");
    assert.equal(d.json.icon, "ticket.fill");
    assert.deepEqual(d.json.metrics, [{ label: "Open", value: "7", type: "number", color: "yellow", timestamp: null }]);
  });

  test("timestamp metrics: pushed as ISO or epoch, read back as relative time plus the ISO time", async () => {
    // Own user so the other tests' source counts don't change.
    const u = await newUser("mcp-e2e-timestamps");
    const c = await connect({ WIDGETDASH_WRITE_KEY: u.api_key_write, WIDGETDASH_READ_KEY: u.api_key_read });
    const epoch = 1761200000;
    const epochIso = new Date(epoch * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
    let r = await call(c, "push_metrics", {
      source_key: "ha",
      metrics: [
        { label: "Updates", value: 3 },
        { label: "Last backup", value: "2026-10-23T05:00:00Z", type: "timestamp" },
        { label: "Synced", value: epoch, type: "timestamp" },
      ],
    });
    assert.equal(r.isError, false, r.text);
    const d = await api("GET", "/api/v1/data/ha", u.api_key_read);
    const [, backup, synced] = d.json.metrics;
    assert.equal(backup.type, "timestamp");
    assert.equal(backup.timestamp, "2026-10-23T05:00:00Z");
    assert.match(backup.value, /ago$/);
    assert.equal(synced.timestamp, epochIso, "epoch seconds are stored as ISO");
    r = await call(c, "get_widget_data", { source_key: "ha" });
    assert.match(r.text, /Last backup: \S+ ago \[timestamp, 2026-10-23T05:00:00Z\]/, "reads show the real time too");
    r = await call(c, "push_number", { source_key: "ha", label: "When", value: "yesterday", type: "timestamp" });
    assert.equal(r.isError, true);
    assert.match(r.text, /422.*ISO 8601/);
  });

  test("push_number keeps other timestamp metrics and color-rule colors as stored", async () => {
    const u = await newUser("mcp-e2e-rules");
    const c = await connect({ WIDGETDASH_WRITE_KEY: u.api_key_write, WIDGETDASH_READ_KEY: u.api_key_read });
    // color_rules aren't an MCP option; set them through the API as a script would.
    let w = await api("PUT", "/api/v1/data/ha", u.api_key_write, {
      metrics: [
        { label: "Updates", value: "3", type: "number" },
        { label: "Last backup", value: "2026-10-23T05:00:00Z", type: "timestamp" },
      ],
      color_rules: { Updates: [{ above: 0, color: "yellow" }, { color: "green" }] },
    });
    assert.equal(w.status, 200);
    const get = async () => (await api("GET", "/api/v1/data/ha", u.api_key_read)).json.metrics;
    assert.equal((await get())[0].color, "yellow", "rule colors 3 yellow");

    // Changing another metric used to re-send "14h ago" as the timestamp (422).
    let r = await call(c, "push_number", { source_key: "ha", label: "Disk", value: "41%" });
    assert.equal(r.isError, false, r.text);
    let metrics = await get();
    assert.equal(metrics[1].timestamp, "2026-10-23T05:00:00Z", "other timestamp kept exactly");
    assert.equal(metrics[2].label, "Disk");

    // ...and pinned the rule's yellow as an explicit color, so 0 stayed yellow.
    r = await call(c, "push_number", { source_key: "ha", label: "Updates", value: 0 });
    assert.equal(r.isError, false, r.text);
    metrics = await get();
    assert.equal(metrics[0].value, "0");
    assert.equal(metrics[0].color, "green", "color rules still decide the color");

    // A new time with no type keeps the metric a timestamp.
    r = await call(c, "push_number", { source_key: "ha", label: "Last backup", value: "2026-10-23T09:30:00Z" });
    assert.equal(r.isError, false, r.text);
    metrics = await get();
    assert.equal(metrics[1].type, "timestamp");
    assert.equal(metrics[1].timestamp, "2026-10-23T09:30:00Z");
  });

  test("input validation rejects bad keys, colors, progress values and duplicate labels", async () => {
    let r = await call(mcp, "push_number", { source_key: "Bad Key!", label: "x", value: 1 });
    assert.equal(r.isError, true);
    assert.match(r.text, /source_key/);
    r = await call(mcp, "push_number", { source_key: "ok", label: "x", value: 1, color: "pink" });
    assert.equal(r.isError, true);
    r = await call(mcp, "push_number", { source_key: "ok", label: "Disk", value: "lots", type: "progress" });
    assert.equal(r.isError, true);
    assert.match(r.text, /between 0 and 100/);
    r = await call(mcp, "push_metrics", { source_key: "ok", metrics: [{ label: "A", value: 1 }, { label: "A", value: 2 }] });
    assert.equal(r.isError, true);
    assert.match(r.text, /Duplicate metric label/);
    r = await call(mcp, "push_metrics", { source_key: "ok", metrics: [] });
    assert.equal(r.isError, true);
    const d = await api("GET", "/api/v1/data/ok", keys.api_key_read);
    assert.equal(d.status, 404, "nothing was written by rejected calls");
  });

  test("get_widget_data returns all sources or a single one", async () => {
    let r = await call(mcp, "get_widget_data");
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, /3 source\(s\)/);
    assert.match(r.text, /Stripe \(source_key: stripe/);
    assert.match(r.text, /MRR: \$14,250 \[number, green\]/);
    assert.match(r.text, /Open Tickets/);
    r = await call(mcp, "get_widget_data", { source_key: "open_tickets" });
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, /Open: 7 \[number, yellow\]/);
    assert.doesNotMatch(r.text, /Stripe/);
    r = await call(mcp, "get_widget_data", { source_key: "nope" });
    assert.equal(r.isError, true);
    assert.match(r.text, /404/);
  });

  test("list_sources shows keys and plan usage", async () => {
    const r = await call(mcp, "list_sources");
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, /Plan: free -- 3 of 5 sources used/);
    assert.match(r.text, /- stripe: Stripe/);
    assert.match(r.text, /- open_tickets: Open Tickets/);
  });

  test("delete_source removes a source", async () => {
    let r = await call(mcp, "delete_source", { source_key: "other" });
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, /Source 'other' deleted/);
    assert.equal((await api("GET", "/api/v1/data/other", keys.api_key_read)).status, 404);
    r = await call(mcp, "delete_source", { source_key: "other" });
    assert.equal(r.isError, true);
    assert.match(r.text, /WidgetDash API error 404: Source not found/);
  });

  test("API errors surface status and detail (free plan source limit)", async () => {
    for (const k of ["s3", "s4", "s5"]) {
      const ok = await call(mcp, "push_number", { source_key: k, label: "n", value: 1 });
      assert.equal(ok.isError, false, ok.text);
    }
    const r = await call(mcp, "push_number", { source_key: "s6", label: "n", value: 1 });
    assert.equal(r.isError, true);
    assert.match(r.text, /WidgetDash API error 403: Free plan limited to 5 sources/);
    assert.match(r.text, /Upgrade to Pro/);
  });

  test("read tools fall back to the write key when no read key is set", async () => {
    const writeOnly = await connect({ WIDGETDASH_WRITE_KEY: keys.api_key_write });
    const r = await call(writeOnly, "get_widget_data", { source_key: "stripe" });
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, /MRR/);
  });

  test("read-only config: reads work, writes explain the missing write key", async () => {
    const readOnly = await connect({ WIDGETDASH_READ_KEY: keys.api_key_read });
    let r = await call(readOnly, "list_sources");
    assert.equal(r.isError, false, r.text);
    r = await call(readOnly, "push_number", { source_key: "stripe", label: "MRR", value: 1 });
    assert.equal(r.isError, true);
    assert.match(r.text, /WIDGETDASH_WRITE_KEY is not set/);
    r = await call(readOnly, "delete_source", { source_key: "stripe" });
    assert.equal(r.isError, true);
    assert.match(r.text, /WIDGETDASH_WRITE_KEY is not set/);
  });

  test("no keys: helpful configuration error", async () => {
    const none = await connect({});
    const r = await call(none, "get_widget_data");
    assert.equal(r.isError, true);
    assert.match(r.text, /widgetdash\.app\/app/);
  });

  test("wrong key: 401 is surfaced and the key is never echoed", async () => {
    const other = await newUser("other-user");
    const bogus = randomBytes(32).toString("hex");
    // A read key used as write key must be rejected by the server.
    const wrong = await connect({ WIDGETDASH_WRITE_KEY: other.api_key_read, WIDGETDASH_READ_KEY: bogus });
    let r = await call(wrong, "push_number", { source_key: "x", label: "n", value: 1 });
    assert.equal(r.isError, true);
    assert.match(r.text, /401/);
    assert.ok(!r.text.includes(other.api_key_read));
    r = await call(wrong, "get_widget_data");
    assert.equal(r.isError, true);
    assert.match(r.text, /WidgetDash API error 401: Invalid API key/);
    assert.ok(!r.text.includes(bogus));
  });

  test("unreachable API gives a clear error", async () => {
    const port = await freePort();
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [ENTRY],
      env: { PATH: process.env.PATH ?? "", WIDGETDASH_API_URL: `http://127.0.0.1:${port}`, WIDGETDASH_WRITE_KEY: keys.api_key_write },
      stderr: "pipe",
    });
    const c = new Client({ name: "widgetdash-mcp-e2e", version: "0.0.0" });
    await c.connect(transport);
    clients.push(c);
    const r = await call(c, "get_widget_data");
    assert.equal(r.isError, true);
    assert.match(r.text, /Could not reach the WidgetDash API/);
  });

  test("keys never appear on the MCP server's stderr", () => {
    const log = stderrChunks.join("");
    assert.ok(!log.includes(keys.api_key_write), "write key leaked to stderr");
    assert.ok(!log.includes(keys.api_key_read), "read key leaked to stderr");
  });
});
