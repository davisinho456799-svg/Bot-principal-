---
name: MangaUpdates releases API
description: External API behavior for tracking MangaUpdates releases.
---

MangaUpdates authentication uses `PUT /v1/account/login` with the account credentials and returns `context.session_token`; protected calls use `Authorization: Bearer <token>`.

The public `rss.php?type=series&id=...` feed is global and ignores the series ID. Do not use it as a per-series chapter source. Authenticated `GET /v1/series/{id}` returns `latest_chapter`, but webtoon records may report `0` or an unreliable value; the `status` text can contain the authoritative total such as `227 Chapters`.

**Why:** The notification checker can silently skip a subscribed title or notify using another work's release if it assumes the public RSS query is scoped by ID.

**How to apply:** Cache the session token only in memory, refresh it after HTTP 401, prefer a positive `latest_chapter`, and otherwise extract the greatest `N Chapters` value from the authenticated series status. Treat missing/zero values as no data.