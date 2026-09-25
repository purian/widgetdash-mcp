/**
 * Minimal WidgetDash REST client (global fetch, no extra deps).
 *
 * Mirrors the public WidgetDash REST API (https://widgetdash.app/llms-full.txt).
 * API keys are only ever placed in the Authorization header; they are never
 * logged and are redacted from any error text we surface.
 */

export const DEFAULT_API_URL = "https://api.widgetdash.app";
const REQUEST_TIMEOUT_MS = 15_000;

export interface Metric {
  label: string;
  value: string;
  type: string;
  color?: string | null;
}

/** Body of PUT /api/v1/data/{source_key}. */
export interface DataPush {
  display_name: string;
  icon: string;
  category: string;
  sort_order: number;
  metrics: Metric[];
  raw_data?: unknown;
}

/** Response of PUT/GET /api/v1/data/{source_key}. */
export interface SourceData {
  source_key: string;
  display_name: string;
  icon: string;
  category: string;
  sort_order?: number;
  metrics: Metric[];
  raw_data?: unknown;
  updated_at: string | null;
  changed_at: string | null;
}

/** Response of GET /api/v1/widget. */
export interface WidgetResponse {
  user: string;
  sources: SourceData[];
  fetched_at: string;
}

/** Item of GET /api/v1/sources. */
export interface SourceInfo {
  id: string;
  source_key: string;
  display_name: string;
  icon: string;
  category: string;
  sort_order: number;
  enabled: boolean;
  created_at: string;
}

/** Response of GET /api/v1/users/me (the subset we use). */
export interface UserInfo {
  name: string;
  tier: string;
  source_count: number;
  source_limit: number | null;
}

export interface Config {
  apiUrl: string;
  writeKey?: string;
  readKey?: string;
  userAgent: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
  ) {
    super(`WidgetDash API error ${status}: ${detail}`);
    this.name = "ApiError";
  }
}

/** A user-facing configuration/usage problem (missing key, bad URL...). */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function loadConfig(env: NodeJS.ProcessEnv, userAgent: string): Config {
  const rawUrl = (env.WIDGETDASH_API_URL ?? "").trim() || DEFAULT_API_URL;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ConfigError(`WIDGETDASH_API_URL is not a valid URL: ${rawUrl}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ConfigError("WIDGETDASH_API_URL must start with https:// (or http:// for local testing).");
  }
  return {
    apiUrl: url.toString().replace(/\/+$/, ""),
    writeKey: env.WIDGETDASH_WRITE_KEY?.trim() || undefined,
    readKey: env.WIDGETDASH_READ_KEY?.trim() || undefined,
    userAgent,
  };
}

function extractDetail(body: unknown, fallback: string): string {
  if (body && typeof body === "object" && "detail" in body) {
    const detail = (body as { detail: unknown }).detail;
    if (typeof detail === "string") return detail;
    // FastAPI validation errors: [{loc: [...], msg: "..."}]
    if (Array.isArray(detail)) {
      return detail
        .map((d) => {
          if (d && typeof d === "object") {
            const loc = Array.isArray(d.loc) ? d.loc.join(".") : "";
            return loc ? `${loc}: ${d.msg}` : String(d.msg);
          }
          return String(d);
        })
        .join("; ");
    }
    return JSON.stringify(detail);
  }
  return fallback;
}

export class WidgetDashClient {
  constructor(private readonly config: Config) {}

  get apiUrl(): string {
    return this.config.apiUrl;
  }

  /** Remove any configured key from text before it reaches the model. */
  redact(text: string): string {
    let out = text;
    for (const key of [this.config.writeKey, this.config.readKey]) {
      if (key) out = out.split(key).join("[redacted]");
    }
    return out;
  }

  private requireWriteKey(): string {
    if (!this.config.writeKey) {
      throw new ConfigError(
        "WIDGETDASH_WRITE_KEY is not set. Get your write key at https://widgetdash.app/app " +
          "and add it to this MCP server's env config (e.g. WIDGETDASH_WRITE_KEY=...).",
      );
    }
    return this.config.writeKey;
  }

  /**
   * Key for read endpoints. The API accepts either the read or the write key
   * for reads, so fall back to the write key.
   */
  private requireReadKey(): string {
    const key = this.config.readKey ?? this.config.writeKey;
    if (!key) {
      throw new ConfigError(
        "No WidgetDash key configured. Set WIDGETDASH_READ_KEY (read-only) or WIDGETDASH_WRITE_KEY " +
          "in this MCP server's env config. Get your keys at https://widgetdash.app/app",
      );
    }
    return key;
  }

  private async request<T>(method: string, path: string, key: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${key}`,
      Accept: "application/json",
      "User-Agent": this.config.userAgent,
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";

    let res: Response;
    try {
      res = await fetch(`${this.config.apiUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      const reason = err instanceof Error ? (err.cause instanceof Error ? err.cause.message : err.message) : String(err);
      throw new ConfigError(`Could not reach the WidgetDash API at ${this.config.apiUrl} (${reason}).`);
    }

    const text = await res.text();
    let parsed: unknown = undefined;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
    }
    if (!res.ok) {
      const fallback = text ? text.slice(0, 300) : res.statusText || "request failed";
      throw new ApiError(res.status, this.redact(extractDetail(parsed, fallback)));
    }
    return parsed as T;
  }

  async pushData(sourceKey: string, body: DataPush): Promise<SourceData> {
    return this.request("PUT", `/api/v1/data/${encodeURIComponent(sourceKey)}`, this.requireWriteKey(), body);
  }

  /** GET /api/v1/data/{key}; returns null on 404. Uses the given key kind. */
  async getSource(sourceKey: string, use: "read" | "write" = "read"): Promise<SourceData | null> {
    const key = use === "write" ? this.requireWriteKey() : this.requireReadKey();
    try {
      return await this.request<SourceData>("GET", `/api/v1/data/${encodeURIComponent(sourceKey)}`, key);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return null;
      throw err;
    }
  }

  async getWidget(): Promise<WidgetResponse> {
    return this.request("GET", "/api/v1/widget", this.requireReadKey());
  }

  async listSources(use: "read" | "write" = "read"): Promise<SourceInfo[]> {
    const key = use === "write" ? this.requireWriteKey() : this.requireReadKey();
    return this.request("GET", "/api/v1/sources", key);
  }

  async getMe(): Promise<UserInfo> {
    return this.request("GET", "/api/v1/users/me", this.requireReadKey());
  }

  async deleteSource(sourceKey: string): Promise<{ message: string }> {
    return this.request("DELETE", `/api/v1/sources/${encodeURIComponent(sourceKey)}`, this.requireWriteKey());
  }
}
