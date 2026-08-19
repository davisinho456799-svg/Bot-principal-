---
name: Notification channel schema
description: The notification channel table has legacy database columns that can make Drizzle schema push ask for interactive conflict resolution.
---

The notification-channel schema should be extended additively. The live development database may contain legacy columns not represented by the current Drizzle model, so a schema push can prompt for a column conflict instead of completing non-interactively.

**Why:** The bot already has stored channel configuration and replacing or renaming the table columns risks losing existing server settings.

**How to apply:** Prefer nullable additive columns for new notification destinations, verify the live development schema before changing it, and let the publish flow apply the same schema change to production.