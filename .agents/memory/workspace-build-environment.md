---
name: Workspace build environment
description: Required environment variables for running the monorepo production build locally.
---

The root production build requires both `PORT` and `BASE_PATH` to be set because the mockup artifact validates them while loading its Vite configuration.

**Why:** Running the root build without these variables fails before compiling the API, even though the API itself typechecks and builds successfully.

**How to apply:** Use the artifact/deployment build context (for example, `PORT=4173 BASE_PATH=/`) when validating the whole workspace; API-only builds do not need this workaround.