# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] - 2026-08-09

### Fixed

- The "you overrode N routes" routing-log stat now counts the model the user
  actually chose, instead of miscounting the switch away from it.
- The widget and `/fission-routing` "now:" line show the model a session
  actually stayed on when a route failed, instead of the one it tried to
  switch to.
- `/fission-setup` no longer downgrades the persisted mode when a probe run
  fails — the previous mode is kept on disk, and mode only advances to
  active on a fully passing probe run.
- Probes retry once with `max_completion_tokens` when an endpoint rejects
  `max_tokens` with a 400 naming it, instead of failing profiles on
  endpoints that require the newer parameter name.
- The packaged extension entry point now catches initialization errors and
  logs `[pi-fission] initialization failed: ...` to stderr instead of
  throwing into Pi, so a broken config or provider degrades to "fission is
  off" rather than blocking Pi from starting.

### Changed

- Project overrides are now validated against the provider's catalogue: an
  override target the provider does not list makes that profile ineligible
  (routing falls through to another profile), and a catalogued override
  target is capability-checked against its own discovered entry.
  `/fission-setup` probes each distinct override target and shows it as an
  extra `override` row in the setup table; an override probe failure never
  blocks active mode.
- Continuation decay is now exact: an inherited confidence decays by 0.05
  per turn, rounded to two decimals, against an inclusive floor of 0.5 — so
  the fifth continued turn (0.7, 0.65, 0.60, 0.55, 0.5) is the one that
  stops routing.
- Project overrides now prefix-match their configured repository, so
  launching Pi from a subdirectory of the configured repo still keeps the
  override in effect.

### Removed

- Dropped the dead `telemetry` and `tuning` config sections — validated but
  never read. Config files written before this release that still contain
  them keep loading; the sections are silently ignored. The example config
  also dropped its leftover identity aliases.

## [0.2.0]

Seven-profile semantic routing on any OpenAI-compatible endpoint; three
commands; live agents widget; routing log.
