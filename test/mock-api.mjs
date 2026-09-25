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
      metrics: s.metrics,
      raw_data: s.raw_data,
      updated_at: s.updated_at,
      changed_at: s.changed_at,
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
      if (!s) {
        s = { source_key: key, enabled: true, created_at: t, changed_at: t };
        user.sources.set(key, s);
      } else if (JSON.stringify(s.metrics) !== JSON.stringify(metrics)) {
        s.changed_at = t;
      }
      // Like the real API, omitted fields reset to their defaults.
      Object.assign(s, {
        display_name: body.display_name ?? "Unnamed",
        icon: body.icon ?? "circle.fill",
        category: body.category ?? "general",
        sort_order: body.sort_order ?? 0,
        metrics,
        raw_data: body.raw_data ?? null,
        updated_at: t,
      });
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
        sources: sorted(user).filter((s) => s.enabled).map(sourceData),
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
