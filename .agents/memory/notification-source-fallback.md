---
name: Notification source fallback
description: Rules for recovering chapter and episode checks when the saved source is unavailable.
---

The saved source remains the priority. Only when it fails or returns no real chapter/episode should the checker search alternative sources, and it must select one matching title so a single update cannot produce duplicate notifications.

**Why:** External catalog APIs can fail independently, while proxy timestamps and metadata updates are not reliable chapter or episode counts.

**How to apply:** Keep source attempts visible in the admin diagnostic, reject proxy-only values as successful content data, and update/notify from only the selected real-count result.