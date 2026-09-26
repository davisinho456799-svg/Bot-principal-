import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { addReleaseBanner } from "./monitor-service";

describe("monitor release image", () => {
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