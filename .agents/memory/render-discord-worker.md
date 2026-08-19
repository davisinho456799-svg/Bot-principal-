---
name: Discord Render worker
description: Deployment constraints for the Discord bot and its PostgreSQL dependency on Render
---

Discord bot deployments on Render should run as an always-on Background Worker, with `DATABASE_URL` pointing to the same PostgreSQL database used by the bot and the Discord token configured as a Render secret. The process must not fail solely because `PORT` is absent; if a port is present, it may also expose the optional API.

**Why:** Render workers do not provide the web-service `PORT` contract, while the bot needs a persistent process and database access before handling commands.

**How to apply:** When diagnosing this bot on Render, check service type, branch, build/start commands, `DATABASE_URL`, the Discord token secret, and database schema before investigating command logic.