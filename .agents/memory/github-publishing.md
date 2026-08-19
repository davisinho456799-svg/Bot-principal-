---
name: GitHub publishing
description: Replit/GitHub authorization behavior when pushing an existing branch.
---

For an existing GitHub branch, the connector can be authorized but a bearer-style HTTPS header may still be rejected by Git. Basic authentication using `x-access-token:<token>` works for fetch and push when the token has repository write permission. The remote branch may also be far ahead of the local starter branch and must be fetched and integrated before pushing.

**Why:** GitHub's accepted auth format and non-fast-forward protection are separate concerns; force-pushing would risk overwriting the bot's existing history.

**How to apply:** Prefer the secure secret flow for `GITHUB_TOKEN`, authenticate Git operations with Basic `x-access-token`, fetch the target branch, preserve its history, and push a normal fast-forward update.