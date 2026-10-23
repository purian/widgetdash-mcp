/**
 * In-memory stand-in for the WidgetDash REST API, used by the e2e tests when no
 * real server checkout is available (WIDGETDASH_TEST_SERVER_DIR unset).
 *
 * It mirrors the public contract of https://api.widgetdash.app for the
 * endpoints this package calls: auth rules (read vs write key), request
 * defaults, ordering, the free-plan source limit and the exact error details.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";

const FREE_SOURCE_LIMIT = 5;

// Like the real API (app/services/metrics.py): a timestamp value is ISO 8601
// (Z, offset, or no zone = UTC) or Unix epoch seconds, stored as
// YYYY-MM-DDTHH:MM:SSZ and read back as a relative time plus the ISO time.
function parseTimestamp(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  let ms;
  if (/^-?\d+(\.\d+)?$/.test(text)) ms = Number(text) * 1000;
  else if (/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?(Z|[+-]\d{2}:?\d{2})?$/.test(text)) {
    const iso = text.replace(" ", "T");
    ms = Date.parse(/(Z|[+-]\d{2}:?\d{2})$/.test(iso) || iso.length === 10 ? iso : `${iso}Z`);
  } else return null;
  return Number.isFinite(ms) ? new Date(ms) : null;
}

const formatTimestamp = (d) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

function relativeTime(d) {
  const seconds = (Date.now() - d.getTime()) / 1000;
  const span = Math.abs(seconds);
  if (span < 60) return "just now";
  const [amount, unit] = span < 3600 ? [Math.floor(span / 60), "m"] : span < 86400 ? [Math.floor(span / 3600), "h"] : [Math.floor(span / 86400), "d"];
  return seconds < 0 ? `in ${amount}${unit}` : `${amount}${unit} ago`;
}

function ruleMatches(rule, value) {
  if ("equals" in rule && value.trim().toLowerCase() !== String(rule.equals).trim().toLowerCase()) return false;
  if ("below" in rule || "above" in rule) {
    const m = value.match(/-?\d[\d,]*(?:\.\d+)?|-?\.\d+/);
    if (!m) return false;
    const n = Number(m[0].replace(/,/g, ""));
    if ("below" in rule && !(n < rule.below)) return false;
    if ("above" in rule && !(n > rule.above)) return false;
  }
  return true;
}

// Reads are rendered: timestamps become relative, and a metric pushed without a
// color gets the first matching color rule's color.
function renderMetrics(metrics, colorRules) {
  return metrics.map((stored) => {
    const m = { ...stored, timestamp: null };
    if (m.type === "timestamp") {
      const d = parseTimestamp(m.value);
      if (d) Object.assign(m, { timestamp: formatTimestamp(d), value: relativeTime(d) });
    }
    if (!m.color) {
      const rule = (colorRules?.[m.label] ?? []).find((r) => ruleMatches(r, String(m.value)));
      if (rule) m.color = rule.color;
    }
    return m;
  });
}

export async function startMockApi() {
  const users = []; // { id, name, readKey, writeKey, tier, createdAt, sources: Map }

  const now = () => new Date().toISOString();
  const byKey = (token, { write }) =>
    users.find((u) => u.writeKey === token || (!write && u.readKey === token));

  function sourceData(s) {
    return {
      source_key: s.source_key,
      display_name: s.display_name,
      icon: s.icon,
      category: s.category,
      sort_order: s.sort_order,
      metrics: renderMetrics(s.metrics, s.color_rules),
      raw_data: s.raw_data,
      updated_at: s.updated_at,
      changed_at: s.changed_at,
      color_rules: s.color_rules ?? null,
    };
  }

  const sorted = (user) =>
    [...user.sources.values()].sort(
      (a, b) => a.sort_order - b.sort_order || a.display_name.localeCompare(b.display_name),
    );

  const server = createServer(async (req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    let body = null;
    const chunks = [];
    for await (const c of req) chunks.push(c);
    if (chunks.length) body = JSON.parse(Buffer.concat(chunks).toString());

    const url = new URL(req.url, "http://mock");
    const path = decodeURIComponent(url.pathname);
    const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    const auth = (write) => {
      const user = byKey(token, { write });
      if (!user) {
        send(401, {
          detail: write ? "Invalid API key or insufficient permissions (write key required)" : "Invalid API key",
        });
      }
      return user;
    };

    if (req.method === "GET" && path === "/health") return send(200, { status: "ok" });

    if (req.method === "POST" && path === "/api/v1/users") {
      const user = {
        id: randomUUID(),
        name: body?.name ?? "user",
        readKey: randomBytes(32).toString("hex"),
        writeKey: randomBytes(32).toString("hex"),
        tier: "free",
        createdAt: now(),
        sources: new Map(),
      };
      users.push(user);
      return send(201, {
        id: user.id,
        name: user.name,
        api_key_read: user.readKey,
        api_key_write: user.writeKey,
        created_at: user.createdAt,
      });
    }

    if (req.method === "GET" && path === "/api/v1/users/me") {
      const user = auth(false);
      if (!user) return;
      return send(200, {
        id: user.id,
        name: user.name,
        email: null,
        email_verified: false,
        tier: user.tier,
        live_activities_enabled: false,
        source_count: user.sources.size,
        source_limit: user.tier === "pro" ? null : FREE_SOURCE_LIMIT,
        subscription_status: null,
        subscription_period_end: null,
        created_at: user.createdAt,
      });
    }

    let m = path.match(/^\/api\/v1\/data\/([^/]+)$/);
    if (m && req.method === "PUT") {
      const user = auth(true);
      if (!user) return;
      const key = m[1];
      let s = user.sources.get(key);
      if (!s && user.tier !== "pro" && user.sources.size >= FREE_SOURCE_LIMIT) {
        return send(403, {
          detail: `Free plan limited to ${FREE_SOURCE_LIMIT} sources. Upgrade to Pro for unlimited.`,
        });
      }
      const t = now();
      const metrics = (body.metrics ?? []).map((x) => ({
        label: x.label,
        value: x.value,
        type: x.type ?? "text",
        color: x.color ?? null,
      }));
      for (const [i, x] of metrics.entries()) {
        if (x.type !== "timestamp") continue;
        const d = parseTimestamp(x.value);
        if (!d) {
          const msg =
            `Value error, metric "${x.label}": a timestamp value must be ISO 8601 ` +
            "(for example 2026-10-18T05:00:00Z) or Unix epoch seconds";
          return send(422, { detail: [{ type: "value_error", loc: ["body", "metrics", i], msg }] });
        }
        x.value = formatTimestamp(d);
      }
      if (!s) {
        s = {
          source_key: key,
          enabled: true,
          created_at: t,
          changed_at: t,
          display_name: "Unnamed",
          icon: "circle.fill",
          category: "general",
          // Like the real API, sort_order only places a new source.
          sort_order: body.sort_order ?? 0,
        };
        user.sources.set(key, s);
      } else if (JSON.stringify(s.metrics) !== JSON.stringify(metrics)) {
        s.changed_at = t;
      }
      // Like the real API: omitted display_name/icon/category keep their values,
      // sort_order is ignored for an existing source, and raw_data is replaced.
      for (const field of ["display_name", "icon", "category"]) {
        if (body[field] != null) s[field] = body[field];
      }
      Object.assign(s, { metrics, raw_data: body.raw_data ?? null, updated_at: t });
      // color_rules: present replaces them, {} clears them, absent keeps them.
      if (body.color_rules != null) s.color_rules = Object.keys(body.color_rules).length ? body.color_rules : null;
      return send(200, sourceData(s));
    }
    if (m && req.method === "GET") {
      const user = auth(false);
      if (!user) return;
      const s = user.sources.get(m[1]);
      if (!s) return send(404, { detail: "Source not found" });
      const { sort_order, ...detail } = sourceData(s);
      return send(200, detail);
    }

    if (req.method === "GET" && path === "/api/v1/widget") {
      const user = auth(false);
      if (!user) return;
      return send(200, {
        user: user.name,
        // Like the real API, /widget leaves color_rules out (null); their colors are in the metrics.
        sources: sorted(user).filter((s) => s.enabled).map((s) => ({ ...sourceData(s), color_rules: null })),
        fetched_at: now(),
      });
    }

    if (req.method === "GET" && path === "/api/v1/sources") {
      const user = auth(false);
      if (!user) return;
      return send(
        200,
        sorted(user).map((s) => ({
          id: s.source_key,
          source_key: s.source_key,
          display_name: s.display_name,
          icon: s.icon,
          category: s.category,
          sort_order: s.sort_order,
          enabled: s.enabled,
          created_at: s.created_at,
        })),
      );
    }

    if (req.method === "PATCH" && path === "/api/v1/sources/reorder") {
      const user = auth(true);
      if (!user) return;
      body.source_keys.forEach((k, i) => {
        const s = user.sources.get(k);
        if (s) s.sort_order = i;
      });
      return send(200, { message: "Sources reordered" });
    }

    m = path.match(/^\/api\/v1\/sources\/([^/]+)$/);
    if (m && req.method === "DELETE") {
      const user = auth(true);
      if (!user) return;
      if (!user.sources.delete(m[1])) return send(404, { detail: "Source not found" });
      return send(200, { message: `Source '${m[1]}' deleted` });
    }

    send(404, { detail: "Not Found" });
  });

  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((r) => server.close(r)),
  };
}
