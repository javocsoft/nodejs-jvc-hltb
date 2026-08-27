# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.2] - 2026-08-28

### Fixed
- **Searches were silently returning nothing**: HowLongToBeat moved its search route from
  `/api/locate/<key>` to `/api/search/site`. Every request hit a 404 and the library returned
  `null` without throwing, so the breakage was invisible.
- `headless: 'new'` was removed in recent Puppeteer versions; now uses `headless: true`.

### Added
- Full support for the current auth scheme: the `x-auth-token`, `x-hp-key` and `x-hp-val`
  headers, plus the body field whose **name** is the rotating key of the day (without it: 404).
- **Failure cooldown** (`failureCooldownMinutes`, default 30). After a failed capture the
  browser is not relaunched for 30 minutes. Previously a broken HLTB site meant a headless
  browser per search attempt, several per game lookup.
- `userAgent` option. The auth token embeds the client IP and User-Agent, so the same one is now
  used to capture and to replay, and it can be overridden.
- `game_alias` matching in `getGameDuration()`, for alternative and regional titles.
- Troubleshooting section in the README, including how to locate the route if HLTB moves it again.

### Changed
- Single search path instead of the old dual-method fallback; a stale credential (401/403/404)
  triggers exactly one recapture and retry, matching what the site itself does.
- Default credential cache reduced from 60 to 30 minutes (the token is time-stamped).
- Request bodies now send `useCache: true`, as the site does for anonymous visitors.
- Removed the duplicated "searching for" log line.

## [1.0.0] - 2025-12-22

### Added
- Initial release
- `HLTBClient` class with Puppeteer-based key extraction
- `getGameDuration()` method for fetching game completion times
- `searchGame()` method for raw search results
- `formatDuration()` utility for human-readable time formatting
- `secondsToHours()` conversion utility
- Dual authentication methods (search key and auth token)
- Smart caching of API keys (default: 60 minutes)
- Auto-recovery on 404 errors with key refresh
- Fallback mechanism for when key extraction fails
- TypeScript type definitions
- Comprehensive documentation and examples
