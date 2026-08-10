---
name: GitHub publishing
description: Replit/GitHub authorization behavior when pushing an existing branch.
---

The GitHub connector can appear available in account-level discovery while still being unavailable to the current Repl. In that state, the managed push reports that an existing branch cannot be updated, and direct HTTPS Git push fails authentication; force-push does not bypass authorization.

**Why:** A force flag only changes ref overwrite behavior. It cannot supply missing GitHub credentials or bind an account connection to the environment.

**How to apply:** Check the connection status for the current Repl before retrying publication. If it is not bound, leave the remote branch unchanged and document the authentication block rather than repeatedly forcing the push.