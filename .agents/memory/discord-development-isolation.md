---
name: Discord development isolation
description: Prevent local Replit workflows from interfering with the production Discord bot and database
---

The development workflow must not start the Discord bot or its schedulers against the empty development database. If it is intentionally used as the live Discord instance, it must explicitly bind the production database and target guild; production keeps the bot enabled separately.

**Why:** A local instance can register or clear guild commands while reading an empty development database, making production subscriptions and channel configuration appear to disappear.

**How to apply:** Prefer the production worker with its production `DATABASE_URL`. If the Replit workflow is the active worker, require explicit production database binding and `DISCORD_GUILD_ID`, and do not run development schema pushes against it.