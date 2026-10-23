import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { ApiError, ConfigError, type DataPush, type Metric, type SourceData, WidgetDashClient } from "./api.js";

/*
 * Limits mirror the WidgetDash API where it defines them
 * (display_name <= 255, icon <= 100, category <= 100). The API does
 * not bound metric fields; the caps below are generous sanity limits so a
 * runaway agent cannot push megabytes into a Home Screen widget.
 */
const METRIC_TYPES = ["number", "text", "status", "progress", "percentage"] as const;
// Colors the WidgetDash iOS app renders; anything else renders as the default color.
const METRIC_COLORS = ["green", "red", "yellow", "blue", "gray", "orange", "purple", "cyan"] as const;
const MAX_METRICS = 50;
// Values like "42", "$12,400", "-3.5%", "1.2k" default to the big-number style.
const NUMERIC_LOOKING = /^\s*[+-]?[$€£¥]?\s*\d[\d,.]*\s*[%kKmMbB]?\s*$/;

const sourceKeySchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[a-z0-9_-]+$/, "source_key may only contain lowercase letters, digits, '_' and '-'")
  .describe(
    "Stable identifier for this data source, e.g. 'stripe_mrr' or 'server_health'. Lowercase letters, digits, '_' or '-'. " +
      "Pushing to an existing key updates it; a new key creates a new widget source.",
  );

const colorSchema = z
  .enum(METRIC_COLORS)
  .describe("Optional accent color. Tip: green = good, yellow = warning, red = bad, gray = neutral.");

const typeSchema = z
  .enum(METRIC_TYPES)
  .describe(
    "How the widget renders the value: 'number' = big bold figure (counts, money, KPIs); 'text' = plain short string; " +
      "'status' = colored badge (e.g. 'Healthy', 'Down'); 'progress' = bar, value must be 0-100; " +
      "'percentage' = compact percent text. If omitted: 'number' for numeric-looking values (42, $12,400, 3.5%), otherwise 'text'.",
  );

const valueSchema = z
  .union([z.string().max(1000), z.number()])
  .describe("The value to display, pre-formatted as you want it shown (e.g. '$12,400', '42', 'Healthy'). For 'progress' use 0-100.");

const metricSchema = z.object({
  label: z.string().trim().min(1).max(255).describe("Short label shown on the widget, e.g. 'MRR' or 'Users online'."),
  value: valueSchema,
  type: typeSchema.optional(),
  color: colorSchema.optional(),
});

const metadataShape = {
  display_name: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .optional()
    .describe("Title shown on the widget, e.g. 'Stripe'. If omitted, keeps the existing name (or derives one from source_key for new sources)."),
  icon: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .optional()
    .describe(
      "SF Symbol name shown next to the title, e.g. 'dollarsign.circle.fill', 'chart.bar.fill', 'server.rack', 'heart.fill', 'cart.fill'. " +
        "If omitted, keeps the existing icon (default 'circle.fill').",
    ),
  category: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .optional()
    .describe("Free-form grouping, e.g. 'finance', 'monitoring', 'fitness'. If omitted, keeps the existing category (default 'general')."),
  sort_order: z
    .number()
    .int()
    .optional()
    .describe(
      "Position for a NEW source among your sources (lower first, default 0). Ignored when updating an existing source: " +
        "its order is set in the WidgetDash app.",
    ),
};

type MetricInput = z.infer<typeof metricSchema>;

class InputError extends Error {}

/** Convert tool input into the exact API Metric shape. */
function normalizeMetric(m: MetricInput): Metric {
  const type = m.type ?? (typeof m.value === "number" || NUMERIC_LOOKING.test(m.value) ? "number" : "text");
  let value = typeof m.value === "number" ? String(m.value) : m.value;
  if (type === "progress") {
    // The iOS widget parses progress as a bare number 0-100 (Double(value) / 100).
    const n = Number(value.trim().replace(/%$/, "").trim());
    if (value.trim() === "" || !Number.isFinite(n) || n < 0 || n > 100) {
      throw new InputError(`Metric '${m.label}': type 'progress' needs a number between 0 and 100, got '${value}'.`);
    }
    value = String(n);
  }
  const metric: Metric = { label: m.label, value, type };
  if (m.color) metric.color = m.color;
  return metric;
}

function assertUniqueLabels(metrics: Metric[]): void {
  const seen = new Set<string>();
  for (const m of metrics) {
    // The iOS app identifies metrics by label, so duplicates render incorrectly.
    if (seen.has(m.label)) throw new InputError(`Duplicate metric label '${m.label}'. Each label must be unique within a source.`);
    seen.add(m.label);
  }
}

function humanize(sourceKey: string): string {
  return sourceKey
    .split(/[_-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function formatMetric(m: Metric): string {
  const extras = [m.type, m.color].filter(Boolean).join(", ");
  return `  - ${m.label}: ${m.value}${extras ? ` [${extras}]` : ""}`;
}

function formatSource(s: SourceData): string {
  const lines = [`${s.display_name} (source_key: ${s.source_key}, icon: ${s.icon}, category: ${s.category})`];
  if (s.metrics.length === 0) lines.push("  (no metrics)");
  else lines.push(...s.metrics.map(formatMetric));
  if (s.updated_at) lines.push(`  updated_at: ${s.updated_at}`);
  return lines.join("\n");
}

function ok(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

function toolError(client: WidgetDashClient, err: unknown): CallToolResult {
  let text: string;
  if (err instanceof ApiError) {
    text = err.message;
    if (err.status === 401) {
      text += " -- Check that the WidgetDash key in this MCP server's config is correct (writes need the write key). Keys: https://widgetdash.app/app";
    } else if (err.status === 403 && /limit/i.test(err.detail)) {
      text += " -- Upgrade to Pro at https://widgetdash.app/app, or delete an unused source with delete_source.";
    } else if (err.status === 429) {
      text += " -- Too many requests; wait a minute and retry.";
    }
  } else if (err instanceof ConfigError || err instanceof InputError) {
    text = err.message;
  } else {
    text = `Unexpected error: ${err instanceof Error ? err.message : String(err)}`;
  }
  return { content: [{ type: "text", text: client.redact(text) }], isError: true };
}

/**
 * Current state of a source, used so that omitted fields keep their existing
 * values. The API keeps omitted display_name/icon/category and ignores
 * sort_order for existing sources, but resets raw_data when it is missing;
 * re-sending the current values also keeps older WidgetDash servers, which
 * reset all of them, from losing anything.
 */
async function loadExisting(client: WidgetDashClient, sourceKey: string) {
  const [data, sources] = await Promise.all([client.getSource(sourceKey, "write"), client.listSources("write")]);
  if (!data) return null;
  const info = sources.find((s) => s.source_key === sourceKey);
  return { data, sortOrder: info?.sort_order ?? 0 };
}

type Metadata = { display_name?: string; icon?: string; category?: string; sort_order?: number };

function buildBody(
  sourceKey: string,
  meta: Metadata,
  existing: Awaited<ReturnType<typeof loadExisting>>,
  metrics: Metric[],
  rawData: unknown,
): DataPush {
  const body: DataPush = {
    display_name: meta.display_name ?? existing?.data.display_name ?? humanize(sourceKey),
    icon: meta.icon ?? existing?.data.icon ?? "circle.fill",
    category: meta.category ?? existing?.data.category ?? "general",
    sort_order: meta.sort_order ?? existing?.sortOrder ?? 0,
    metrics,
  };
  const raw = rawData !== undefined ? rawData : existing?.data.raw_data;
  if (raw !== undefined && raw !== null) body.raw_data = raw;
  return body;
}

function pushSummary(verb: string, s: SourceData): string {
  return (
    `${verb} '${s.source_key}' on WidgetDash. It now shows:\n${formatSource(s)}\n\n` +
    "The WidgetDash iPhone Home Screen / Lock Screen widgets pick this up on their next refresh; " +
    "running Live Activities for this source update automatically."
  );
}

export const SERVER_INSTRUCTIONS =
  "WidgetDash (https://widgetdash.app) shows any numbers on the user's iPhone Home Screen widgets, Lock Screen widgets " +
  "and Live Activities. Use push_number for a single value (e.g. 'put my Stripe MRR on my widget') and push_metrics " +
  "to set a whole source (title, SF Symbol icon, several metrics). Use get_widget_data / list_sources to see what is " +
  "currently shown. Pick a stable, descriptive source_key and reuse it for later updates. The user needs the free " +
  "WidgetDash iOS app (https://apps.apple.com/us/app/widgetdash/id6761054679) with a widget added to see the data.";

export function createServer(client: WidgetDashClient, version: string): McpServer {
  const server = new McpServer({ name: "widgetdash", version }, { instructions: SERVER_INSTRUCTIONS });

  server.registerTool(
    "push_metrics",
    {
      title: "Push metrics to iPhone widget",
      description:
        "Create or update a WidgetDash data source shown on the user's iPhone Home Screen / Lock Screen widgets and Live Activities. " +
        "Sets the source's title, SF Symbol icon, category and its full list of metrics (label + value + type + color). " +
        "The metrics list REPLACES the source's current metrics; use push_number to change a single value. " +
        "Omitted display_name/icon/category keep their current values; sort_order only applies when the source is created. " +
        "Requires WIDGETDASH_WRITE_KEY.",
      inputSchema: {
        source_key: sourceKeySchema,
        ...metadataShape,
        metrics: z
          .array(metricSchema)
          .min(1)
          .max(MAX_METRICS)
          .describe("Metrics to show, in display order. Small widgets show the first few, so put the most important first."),
        raw_data: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Optional arbitrary JSON object stored alongside the metrics (not shown on the widget). If omitted, existing raw_data is kept."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const metrics = args.metrics.map(normalizeMetric);
        assertUniqueLabels(metrics);
        const existing = await loadExisting(client, args.source_key);
        const body = buildBody(args.source_key, args, existing, metrics, args.raw_data);
        const result = await client.pushData(args.source_key, body);
        return ok(pushSummary(existing ? "Updated" : "Created", result));
      } catch (err) {
        return toolError(client, err);
      }
    },
  );

  server.registerTool(
    "push_number",
    {
      title: "Push one number to iPhone widget",
      description:
        "Quickest way to put a single number or value on the user's iPhone Home Screen / Lock Screen widget via WidgetDash, " +
        "e.g. 'Stripe MRR = $12,400' or 'Open tickets = 7'. Sets one metric (matched by label) on a source, keeping the " +
        "source's other metrics, title and icon; creates the source if it does not exist. Requires WIDGETDASH_WRITE_KEY.",
      inputSchema: {
        source_key: sourceKeySchema,
        label: metricSchema.shape.label,
        value: valueSchema,
        type: typeSchema.optional().describe("Optional; defaults to the existing metric's type, else inferred from the value."),
        color: colorSchema.optional().describe("Optional accent color (green/red/yellow/blue/gray/orange/purple/cyan); defaults to the existing metric's color."),
        ...metadataShape,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const existing = await loadExisting(client, args.source_key);
        const current = existing?.data.metrics ?? [];
        const label = args.label;
        const idx = current.findIndex((m) => m.label === label);
        const prev = idx >= 0 ? current[idx] : undefined;
        // Omitted type/color keep the existing metric's style.
        const prevType = METRIC_TYPES.find((t) => t === prev?.type);
        const prevColor = METRIC_COLORS.find((c) => c === prev?.color);
        const metric = normalizeMetric({ label, value: args.value, type: args.type ?? prevType, color: args.color ?? prevColor });
        let metrics: Metric[];
        if (idx >= 0) {
          metrics = current.map((m, i) => (i === idx ? metric : m));
        } else {
          if (current.length >= MAX_METRICS) throw new InputError(`Source '${args.source_key}' already has ${MAX_METRICS} metrics.`);
          metrics = [...current, metric];
        }
        const body = buildBody(args.source_key, args, existing, metrics, undefined);
        const result = await client.pushData(args.source_key, body);
        return ok(pushSummary(existing ? "Updated" : "Created", result));
      } catch (err) {
        return toolError(client, err);
      }
    },
  );

  server.registerTool(
    "list_sources",
    {
      title: "List WidgetDash sources",
      description:
        "List the data sources on the user's WidgetDash iPhone widgets (source_key, title, icon, enabled/hidden) plus the " +
        "plan's source usage (the free plan allows 5 sources). Uses WIDGETDASH_READ_KEY, or the write key if no read key is set.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      try {
        const [sources, me] = await Promise.all([client.listSources(), client.getMe()]);
        const limit = me.source_limit === null ? "unlimited" : String(me.source_limit);
        const header = `Plan: ${me.tier} -- ${me.source_count} of ${limit} sources used.`;
        if (sources.length === 0) return ok(`${header}\nNo sources yet. Use push_number or push_metrics to create one.`);
        const lines = sources.map(
          (s) =>
            `- ${s.source_key}: ${s.display_name} (icon: ${s.icon}, category: ${s.category}, sort_order: ${s.sort_order}${s.enabled ? "" : ", hidden in app"})`,
        );
        return ok(`${header}\n${lines.join("\n")}`);
      } catch (err) {
        return toolError(client, err);
      }
    },
  );

  server.registerTool(
    "get_widget_data",
    {
      title: "Read iPhone widget data",
      description:
        "Read what is currently shown on the user's WidgetDash iPhone widgets: every enabled source with its metrics and " +
        "last update time, or one source if source_key is given. Uses WIDGETDASH_READ_KEY, or the write key if no read key is set.",
      inputSchema: {
        source_key: sourceKeySchema.optional().describe("Only return this source. Omit to return all sources shown on the widget."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        if (args.source_key) {
          const s = await client.getSource(args.source_key);
          if (!s) return toolError(client, new ApiError(404, `Source '${args.source_key}' not found. Use list_sources to see existing keys.`));
          return ok(formatSource(s));
        }
        const w = await client.getWidget();
        if (w.sources.length === 0) return ok("The widget has no (enabled) sources yet. Use push_number or push_metrics to add one.");
        return ok(`${w.sources.length} source(s) on the widget:\n\n${w.sources.map(formatSource).join("\n\n")}`);
      } catch (err) {
        return toolError(client, err);
      }
    },
  );

  server.registerTool(
    "delete_source",
    {
      title: "Delete WidgetDash source",
      description:
        "Permanently delete a data source (and its data) from the user's WidgetDash iPhone widgets. Ends any Live Activity " +
        "for it. Only do this when the user asks to remove it. Requires WIDGETDASH_WRITE_KEY.",
      inputSchema: { source_key: sourceKeySchema.describe("The source_key to delete (see list_sources).") },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const res = await client.deleteSource(args.source_key);
        return ok(`${res.message}. It will disappear from the iPhone widgets on their next refresh.`);
      } catch (err) {
        return toolError(client, err);
      }
    },
  );

  return server;
}
