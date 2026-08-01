---
name: MangaUpdates releases API
description: External API behavior for tracking MangaUpdates releases.
---

MangaUpdates' current per-series release endpoint is `GET /v1/series/{id}/rss` and returns RSS/XML. The older JSON-style `GET /v1/series/{id}/releases` route returns HTTP 405.

**Why:** The notification checker can silently skip a subscribed title when it assumes the old JSON response shape.

**How to apply:** Parse numeric chapter values from RSS item titles, including ranges such as `c.4-10`; ignore non-numeric labels such as `c.Prologue`.