---
name: Monitor fallback rendering
description: Rendering constraint for Discord chapter notification fallback images.
---

The monitor should prefer sending a direct screenshot of the real chapter card. Only its last-resort fallback should decode and composite downloaded thumbnails with Sharp instead of embedding them as `data:` images inside the SVG. Promotional image URLs and nearly blank/transparent images must be rejected.

**Why:** The SVG can rasterize successfully while silently leaving a valid embedded thumbnail as a blank white block, producing a misleading but otherwise valid Discord attachment. Some source pages also expose internal `FULLVERSION APP` banners as chapter image URLs.

**How to apply:** Select the complete visual card container before taking the screenshot and send that PNG unchanged. Do not reject a chapter card solely because promotional text appears inside it; filter promotional media at the image level and hide it only during capture. Toptoon cards may use Korean `제N화` labels and `data-episode-id`/`data-ep_thumb2` attributes instead of English labels and `<img>` tags. If browser capture is unavailable, keep the SVG responsible for the fallback background and text, validate downloaded image bytes with Sharp, resize them, and composite them into the rasterized base PNG. Filter promotional terms from URL/alt/context and use an explicit unavailable label when no usable thumbnail remains.

Toomics may include the login form in the page HTML while keeping it inside a hidden modal, and the browser may serve different login markup from the locale and global origins. When the browser detects login-required content but no visible password field, try `/por/login` on the current origin and `https://global.toomics.com/por/login`, then use the real fields (`#user_id` and `#user_pw`) before returning to the chapter listing.

**Why:** Looking only for visible login controls on the chapter page reports “formulário de login não encontrado” even though the site has a usable login form; the hidden modal is not the login flow the browser can fill reliably.

**How to apply:** Keep credentials in environment variables, never log them, and treat CAPTCHA or rejected credentials as explicit authentication states rather than capture exceptions.

Toomics can crash the Playwright page while loading its image-heavy chapter listing or switching into the login flow. Browser capture must treat a renderer crash as recoverable: reduce non-card resources, reset the cached browser/context, and retry once before using the parser fallback.

**Why:** A crashed renderer otherwise leaves the shared browser session unusable and turns a transient resource failure into a guaranteed fallback on every following test.

**How to apply:** Attach a page crash guard, clear browser/context promises after a crash, and keep the retry bounded so monitor execution still completes.

Toomics episode cards use `a.js-episode-link` with the number in `.cell-num .num`; the episode route is embedded in `onclick` as `/ep/<number>/toon/<id>`, while thumbnail media is commonly in `img[data-original]`.

**Why:** Generic “Episode/Chapter” text and `href` parsing misses these cards even when the browser has rendered the complete episode list.

**How to apply:** Include the card class, numeric cell, and `onclick` route in browser detection before falling back to the platform parser.

This Toomics detection approach was confirmed working in the September 10, 2026 monitor test.

**Why:** The site’s rendered episode cards can now be captured directly instead of being mistaken for an unavailable browser listing.

**How to apply:** Preserve these selectors and route parsing when changing the generic chapter detector.

Keep the image-heavy listing page separate from the Toomics login page: close the listing before opening login, then create a fresh listing page after authentication.

**Why:** Navigating the same renderer from a page with many chapter thumbnails into the login flow can trigger renderer crashes even when the login page itself is valid.

**How to apply:** Preserve cookies in the browser context, but use separate pages for listing and authentication and always close the temporary login page.

Fresh Playwright login pages start at `about:blank`; derive a valid Toomics origin from the listing URL or use `https://toomics.com` before constructing `/por/login`.

**Why:** Building a relative login URL from `about:blank` produces an invalid navigation URL and hides the real authentication result.

**How to apply:** Guard origin extraction with an HTTP(S) check and retain `global.toomics.com` as the alternate login origin.