---
name: Notification HTTP status logging
description: Durable guidance for classifying notification-source failures while preserving the Render worker and Neon error-history flow.
---

Notification-source failures should be recorded through the existing error history and `http_status` field, while the source fallback continues normally. Do not make an external API failure stop the Discord worker.

**Why:** The bot runs as a Render worker and relies on Neon; changing startup behavior or making fallback failures fatal can take the bot offline.

**How to apply:** Extract status codes from both HTTP-shaped errors and messages, keep the error-history insert non-fatal, and avoid destructive or automatic production schema changes unless explicitly requested.