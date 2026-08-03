---
name: Discord component interactions
description: Button interactions in calendar commands should be acknowledged and edited atomically, with collector failures logged
---

Discord button handlers should prefer a single `update()` response over `deferUpdate()` followed by a separate edit when the click immediately changes the source message, and should commit in-memory pagination state only after that update succeeds.

**Why:** Separate acknowledgement and message-edit requests create an avoidable failure window where Discord can show an unanswered interaction even when the collector received the click; mutating page state first can make a retry appear to skip a page after a failed update.

**How to apply:** Keep component handlers short, wrap collector callbacks in error handling, and log the custom ID so Render logs identify failures without exposing credentials or database data.