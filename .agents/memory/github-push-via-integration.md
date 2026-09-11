---
name: GitHub branch publishing
description: Reliable way to publish targeted branch changes when terminal Git authentication is unavailable.
---

When the GitHub integration is connected but `git push` fails with invalid HTTPS credentials, use the connected GitHub API to publish a targeted commit. Read the branch ref, create the changed file blob(s), create a tree based on the current remote commit, create a commit with that remote commit as parent, and update the branch ref without force push.

**Why:** The Replit GitHub connection can authenticate API requests while the terminal Git credential helper may still be unset. Directly handling OAuth tokens would be unsafe, and broad synchronization can accidentally publish unrelated local history.

**How to apply:** First guard on the expected remote SHA. For a narrow fix, publish only the intended file paths and verify the returned branch SHA. The branch endpoint exposes only the commit SHA; fetch that commit separately to obtain its tree SHA. Use a forced ref reset only when the user explicitly confirms a rollback.