# Changelog

All notable changes to `widgetdash-mcp` are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- The `timestamp` metric type: send an ISO 8601 time or Unix epoch seconds and the widget shows it as a live relative time ("8 hours ago"). `get_widget_data` shows the exact time next to the relative one.

### Fixed

- `push_number` failed with a 422 on any source that had a timestamp metric. It re-sent the other metrics as read back from the API, where a timestamp's value is the relative text ("14h ago"); it now re-sends the stored time.
- `push_number` froze colors chosen by a source's color rules: re-sending a rule-picked color made it an explicit color, which always beats the rules, so a value that changed kept its old color. Metrics covered by color rules are now re-sent without a color.
- The test mock now matches the API's read format (`timestamp` on every metric, rendered timestamps and color rules), so the e2e suite passes against a real WidgetDash server again.

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
