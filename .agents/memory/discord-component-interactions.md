---
name: Discord component interactions
description: Button interactions in calendar commands should be acknowledged and edited atomically, with collector failures logged
---

Discord button handlers should prefer a single `update()` response when the payload is guaranteed to be built within Discord's response window; if building or external work can approach that limit, acknowledge with `deferUpdate()` immediately and edit afterward. Commit in-memory pagination state only after the edit succeeds.

**Why:** The calendar produced `Unknown interaction (10062)` on later page clicks when `update()` missed Discord's short acknowledgement window. A fast defer prevents the click from expiring; mutating page state first can still make a retry appear to skip a page after a failed edit.

**How to apply:** Keep component handlers short, acknowledge before expensive payload construction when needed, wrap callbacks in error handling, and log the custom ID so Render logs identify failures without exposing credentials or database data.