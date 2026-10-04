import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { addReleaseBanner } from "./monitor-service";
import { renderToptoonPairCard } from "./toptoon-pair-render";

describe("monitor release image", () => {
  it("renders two portrait panels for the browser-less experiment, with no primary panel", async () => {
    const images = await Promise.all(["#d43b35", "#37a36b"].map(background =>
      sharp({ create: { width: 260, height: 360, channels: 3, background } }).png().toBuffer(),
    ));
    const png = await renderToptoonPairCard({
      number: "36", thumbnailUrl: "unused-primary", subtitlePt: "Um encontro inesperado",
    }, [images[0], images[1]]);
    const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const pixel = (x: number, y: number) => Array.from(data.subarray((y * info.width + x) * info.channels, (y * info.width + x) * info.channels + 3));
    expect(info.width).toBe(1024);
    expect(info.height).toBe(162);
    expect(pixel(60, 70)).toEqual([212, 59, 53]);
    expect(pixel(170, 70)).toEqual([55, 163, 107]);
  });

  it("adds the release banner above a browser capture", async () => {
    const source = await sharp({
      create: {
        width: 320,
        height: 120,
        channels: 3,
        background: "#213547",
      },
    })
      .png()
      .toBuffer();

    const decorated = await addReleaseBanner(source, "Obra de teste", 2);

    expect(decorated).not.toBeNull();
    const metadata = await sharp(decorated!).metadata();
    expect(metadata.width).toBe(320);
    expect(metadata.height).toBe(212);
  });
});