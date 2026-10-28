# WidgetDash MCP server

**Let your AI agent put any number on your iPhone.**

[WidgetDash](https://widgetdash.app) shows numbers from any service on iPhone Home Screen widgets, Lock Screen widgets and Live Activities. This [Model Context Protocol](https://modelcontextprotocol.io) server lets Claude Desktop, Claude Code, Cursor and other MCP clients push data to your widgets and read it back. You just ask:

> "Put my Stripe MRR on my iPhone widget."

## What you need

1. The free **WidgetDash** iOS app: <https://apps.apple.com/us/app/widgetdash/id6761054679>, with a WidgetDash widget on your Home Screen or Lock Screen.
2. Your API keys. **Get them at <https://widgetdash.app/app>.**
   - **Write key**: lets the agent create and update your widget data.
   - **Read key** (optional): read-only access. If you leave it out, the read tools use the write key.
3. Node.js 18 or newer (`npx` comes with it).

## Setup

### Claude Code

```bash
claude mcp add widgetdash -e WIDGETDASH_WRITE_KEY=your-write-key -- npx -y widgetdash-mcp
```

### Claude Desktop

Edit `claude_desktop_config.json` (Settings → Developer → Edit Config), then restart Claude Desktop:

```json
{
  "mcpServers": {
    "widgetdash": {
      "command": "npx",
      "args": ["-y", "widgetdash-mcp"],
      "env": {
        "WIDGETDASH_WRITE_KEY": "your-write-key",
        "WIDGETDASH_READ_KEY": "your-read-key"
      }
    }
  }
}
```

### Cursor

Add this to `~/.cursor/mcp.json` for all projects, or `.cursor/mcp.json` for one project:

```json
{
  "mcpServers": {
    "widgetdash": {
      "command": "npx",
      "args": ["-y", "widgetdash-mcp"],
      "env": { "WIDGETDASH_WRITE_KEY": "your-write-key" }
    }
  }
}
```

Other MCP clients that can launch a stdio server work the same way. The command is `npx -y widgetdash-mcp`, and the keys go in the environment variables below.

### Environment variables

| Variable | Required | Description |
| --- | --- | --- |
| `WIDGETDASH_WRITE_KEY` | For writes | Write key from <https://widgetdash.app/app>. `push_metrics`, `push_number` and `delete_source` need it. |
| `WIDGETDASH_READ_KEY` | No | Read key. `list_sources` and `get_widget_data` use it, or the write key if it isn't set. |
| `WIDGETDASH_API_URL` | No | API base URL. Default: `https://api.widgetdash.app`. |

## Example prompts

- "Put my Stripe MRR on my iPhone widget." (The agent reads the number with a Stripe tool, then calls `push_number`.)
- "Show today's GitHub stars, open issues and open PRs for my repo on my Lock Screen widget."
- "Make a 'Server' widget with CPU as a progress bar, uptime as a number and a green 'Healthy' status badge."
- "Every time you finish a build, set the 'CI' widget status to Passing or Failing."
- "What's on my WidgetDash widget right now?"
- "Remove the old 'test' source from my widget."

## Tools

| Tool | What it does |
| --- | --- |
| `push_number` | Sets one value on a source, e.g. `MRR = $12,400`. Other metrics on the source stay as they are. The metric is matched by label. If the source doesn't exist yet, it is created. |
| `push_metrics` | Creates or updates a source: title (`display_name`), SF Symbol `icon`, `category`, `sort_order` (new sources only; reorder in the app) and the full `metrics` list. The list **replaces** the source's current metrics. |
| `list_sources` | Lists your sources (key, title, icon, hidden or shown) and how many your plan allows. The free plan allows 5. |
| `get_widget_data` | Shows what's on the widget now: every enabled source with its metrics and last update time, or a single source. |
| `delete_source` | Permanently deletes a source and ends any Live Activity for it. |

### Metrics

Each metric has a `label`, a `value`, an optional `type`, an optional `color` and an optional `wide`:

- **`type`** sets how the widget draws the value:
  - `number`: a big bold figure.
  - `text`: a plain string.
  - `status`: a colored badge.
  - `progress`: a bar. The value must be 0 to 100, and a trailing `%` is removed for you.
  - `percentage`: compact percent text.
  - `timestamp`: a moment, shown as a live relative time such as "8 hours ago". Send an ISO 8601 time (`2026-10-23T05:00:00Z`) or Unix epoch seconds. Reads show the relative time plus the exact time.

  If you leave `type` out, values that look like numbers (`42`, `$12,400`, `3.5%`) become `number` and everything else becomes `text`. With `push_number`, an existing metric keeps its current type, color and `wide`, and the source's other metrics are re-sent as they were stored: timestamps keep their exact time, and colors chosen by the source's color rules stay under the rules' control.
- **`color`**: `green`, `red`, `yellow`, `blue`, `gray`, `orange`, `purple` or `cyan`.
- **`wide`**: `true` gives the metric a full-width row of its own on Large widgets (iOS app 1.8 or later), for long text such as a title. Other text that shares a row shows up to two lines. Put wide metrics last to keep the others in one row.
- **`icon`**: any [SF Symbol](https://developer.apple.com/sf-symbols/) name, e.g. `dollarsign.circle.fill`, `chart.bar.fill`, `server.rack` or `heart.fill`.

Fields you leave out (`display_name`, `icon`, `category`, `raw_data`) keep their current values. `sort_order` only places a new source: once it exists, its order is the one set in the app, so an agent can't undo it.

## Security

- The **write key can only write your own widget data**. It can't reach other users' data or your account's billing.
- Keys go only in the `Authorization` header of requests to the WidgetDash API. The server never logs them and removes them from any error text it returns.
- Treat the write key like a password. If it leaks, rotate it at <https://widgetdash.app/app>.
- The server only talks to `WIDGETDASH_API_URL`, which is `https://api.widgetdash.app` by default.

## Development

```bash
npm install
npm run build        # compiles src/ to dist/
npm test             # builds, then runs the end-to-end tests
```

`npm test` runs every tool through a real MCP client over stdio, against an in-memory mock of the WidgetDash API (`test/mock-api.mjs`). It needs no network and no keys, and it never contacts production.

To try it interactively, run `npx @modelcontextprotocol/inspector node dist/index.js`.

### MCP Registry

`server.json` is the entry for the [official MCP Registry](https://registry.modelcontextprotocol.io) under the name `io.github.purian/widgetdash-mcp`, following schema `2025-12-11`. The `mcpName` field in `package.json` must match that name for npm ownership verification. **Status: draft.** It hasn't been published yet, and the registry is still in preview, so check `server.json` against the current schema before running `mcp-publisher publish`.

## License

MIT © WidgetDash
