# Changelog

All notable changes to `widgetdash-mcp` are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-10-24

First release: a stdio MCP server that lets AI agents push numbers to WidgetDash iPhone Home Screen / Lock Screen widgets and Live Activities.

### Added

- Tools: `push_metrics`, `push_number`, `list_sources`, `get_widget_data` and `delete_source`.
- Configured with the `WIDGETDASH_WRITE_KEY`, `WIDGETDASH_READ_KEY` and `WIDGETDASH_API_URL` environment variables.
- Input validation with zod that matches the API schema: source key format, the metric types and colors the iOS app renders, progress values from 0 to 100, and unique labels.
- The `timestamp` metric type: send an ISO 8601 time or Unix epoch seconds and the widget shows it as a live relative time ("8 hours ago"). `get_widget_data` shows the exact time next to the relative one.
- Updates keep existing metadata: fields left out of an update (display name, icon, category, raw data) keep their current values instead of being reset to the API defaults. `sort_order` only places a new source; after that the order set in the app wins.
- `push_number` changes one metric and keeps the source's other metrics as stored: timestamps keep their exact time, and metrics colored by the source's color rules stay driven by those rules.
- End-to-end tests (`node:test`) that drive every tool through a real MCP client over stdio, against an in-memory mock of the WidgetDash API that renders reads like the real API. No network or keys are needed; set `WIDGETDASH_TEST_SERVER_DIR` to run them against a local WidgetDash server instead.
- Draft `server.json` for the official MCP Registry.

[Unreleased]: https://github.com/purian/widgetdash-mcp/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/purian/widgetdash-mcp/releases/tag/v0.1.0
