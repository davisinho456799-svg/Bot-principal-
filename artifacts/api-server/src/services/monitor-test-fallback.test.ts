import { describe, expect, it, vi } from "vitest";
import { selectPairTestImage } from "./monitor-test-fallback";

describe("two-image test notification safety", () => {
  const pair = Buffer.from("pair");
  const primary = Buffer.from("primary");

  it("keeps a valid captured pair without downloading a replacement", async () => {
    const renderPair = vi.fn();
    const renderPrimary = vi.fn();
    expect(await selectPairTestImage({ captured: pair, renderPair, renderPrimary }))
      .toEqual({ image: pair, selection: "extras", browser: true });
    expect(renderPair).not.toHaveBeenCalled();
    expect(renderPrimary).not.toHaveBeenCalled();
  });

  it("tries the pair renderer before the principal", async () => {
    const renderPrimary = vi.fn();
    expect(await selectPairTestImage({ renderPair: async () => pair, renderPrimary }))
      .toEqual({ image: pair, selection: "extras", browser: false });
    expect(renderPrimary).not.toHaveBeenCalled();
  });

  it.each(["null", "throw", "empty"])("uses the same chapter's primary after pair failure (%s)", async failure => {
    const renderPrimary = vi.fn(async () => primary);
    const report = vi.fn(async () => {});
    const result = await selectPairTestImage({
      renderPair: async () => {
        if (failure === "throw") throw new Error("missing extra 3");
        return failure === "null" ? null : Buffer.alloc(0);
      },
      renderPrimary, report,
    });
    expect(result).toEqual({ image: primary, selection: "primary", browser: false });
    expect(renderPrimary).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledWith(expect.stringContaining("mesmo capítulo"));
  });

  it.each(["null", "throw"])("keeps a text notification when neither image works (%s)", async failure => {
    const report = vi.fn(async () => {});
    const onFailure = vi.fn();
    const render = async () => {
      if (failure === "throw") throw new Error("images unavailable");
      return null;
    };
    expect(await selectPairTestImage({ renderPair: render, renderPrimary: render, report, onFailure }))
      .toEqual({ image: null, selection: "text", browser: false });
    expect(report).toHaveBeenLastCalledWith(expect.stringContaining("somente em texto"));
    if (failure === "throw") expect(onFailure).toHaveBeenCalledTimes(2);
  });
});