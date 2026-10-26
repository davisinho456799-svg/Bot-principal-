import { describe, expect, it } from "vitest";
import {
  formatMonitorLinkWarning,
  getMonitorLinkRedirect,
  monitorLinkWarningKey,
} from "./monitor-link-warning";

describe("monitor link redirect warnings", () => {
  it("accepts the platform domain and its subdomains", () => {
    expect(getMonitorLinkRedirect("https://www.toptoon.com/comic/ep_list/x", "toptoon")).toBeNull();
    expect(getMonitorLinkRedirect("https://toptoon.com/comic/ep_list/x", "toptoon")).toBeNull();
  });

  it("warns for a Google wrapper even when it points at the right platform", () => {
    const link = "https://www.google.com/url?url=https%3A%2F%2Ftoptoon.com%2Fcomic%2Fep_list%2Fx";
    const warning = getMonitorLinkRedirect(link, "toptoon");
    expect(formatMonitorLinkWarning("Test work", warning)).toContain("Link não direto");
    expect(warning?.inputHost).toBe("www.google.com");
    expect(monitorLinkWarningKey(5, "toptoon", link))
      .toBe(monitorLinkWarningKey(5, "toptoon", "https://toptoon.com/comic/ep_list/x"));
  });

  it("detects a direct site URL that ends outside the platform domain", () => {
    const warning = getMonitorLinkRedirect(
      "https://toptoon.com/comic/ep_list/x",
      "toptoon",
      "https://www.google.com/url",
    );
    expect(warning?.finalHost).toBe("www.google.com");
  });
});
