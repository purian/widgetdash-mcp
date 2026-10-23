# Changelog

All notable changes to `widgetdash-mcp` are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- `sort_order` only places a new source. The WidgetDash API ignores it when updating an existing source, whose order is set in the app; the `push_metrics` and `sort_order` descriptions and the README now say so, and the test mock matches the API.

## [0.1.0] - 2026-09-25

### Added

- First release: a stdio MCP server that lets AI agents push numbers to WidgetDash iPhone Home Screen / Lock Screen widgets and Live Activities.
- Tools: `push_metrics`, `push_number`, `list_sources`, `get_widget_data` and `delete_source`.
- Configured with the `WIDGETDASH_WRITE_KEY`, `WIDGETDASH_READ_KEY` and `WIDGETDASH_API_URL` environment variables.
- Input validation with zod that matches the API schema: source key format, the metric types and colors the iOS app renders, progress values from 0 to 100, and unique labels.
- Updates keep existing metadata: fields left out of an update (display name, icon, category, sort order, raw data) keep their current values instead of being reset to the API defaults.
- End-to-end tests (`node:test`) that drive every tool through a real MCP client over stdio, against an in-memory mock of the WidgetDash API. No network or keys are needed.
- Draft `server.json` for the official MCP Registry.
