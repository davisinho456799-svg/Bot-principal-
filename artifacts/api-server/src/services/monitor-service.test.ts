import { afterEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { addReleaseBanner, postStrip } from "./monitor-service";
import { renderToptoonPairCard } from "./toptoon-pair-render";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("monitor release image", () => {
  it.each(["pairs", "mixed", "text", "normal"])("preserves automatic notification batches: %s", async mode => {
    vi.stubEnv("DISCORD_BOT_TOKEN", "unit-test-not-a-real-token");
    const red = await sharp({ create: { width: 40, height: 60, channels: 3, background: "#d43b35" } }).png().toBuffer();
    const green = await sharp({ create: { width: 40, height: 60, channels: 3, background: "#37a36b" } }).png().toBuffer();
    const requested: string[] = [];
    let posted: FormData | undefined;
    vi.stubGlobal("fetch", vi.fn(async (input: string, options?: RequestInit) => {
      const url = String(input);
      requested.push(url);
      if (url.startsWith("https://discord.com/api/")) {
        posted = options?.body as FormData;
        return new Response("", { status: 200 });
      }
      const missing = mode === "text" || (mode === "mixed" &&
        (url.includes("/38/") || (url.includes("/37/") && url.includes("extra"))));
      if (missing) return new Response("", { status: 404 });
      return new Response(new Uint8Array(url.includes("extra3") ? green : red));
    }));
    const chapters = ["36", "37", "38"].map(number => ({
      number, key: `same-key-${number}`, parser: "test",
      subtitlePt: "Texto e capítulo preservados", releaseDate: "2026.10.04",
      thumbnailUrl: `https://example.test/${number}/primary.png`,
      extraThumbnailUrls: [`https://example.test/${number}/extra2.png`, `https://example.test/${number}/extra3.png`] as [string, string],
    }));
    const result = await postStrip("unit-test-channel", "Obra automática", chapters, 1, 1, false, undefined, mode !== "normal");
    const payload = JSON.parse(String(posted?.get("payload_json")));
    expect(payload.content).toContain("3 capítulos novos · capítulos 36, 37, 38");
    expect(payload.content).not.toContain("TESTE");
    expect(requested.filter(url => url.startsWith("https://discord.com/api/"))).toHaveLength(1);
    expect(chapters.map(chapter => chapter.key)).toEqual(["same-key-36", "same-key-37", "same-key-38"]);
    if (mode === "text") {
      expect(result).toBe("none");
      expect(posted?.get("files[0]")).toBeNull();
      expect(payload.content).toContain("somente texto: capítulos 36, 37, 38");
      return;
    }
    const image = posted!.get("files[0]") as Blob;
    const png = Buffer.from(await image.arrayBuffer());
    const metadata = await sharp(png).metadata();
    expect(metadata.width).toBe(mode === "normal" ? 920 : 1024);
    if (mode === "normal") {
      expect(requested.some(url => url.includes("extra"))).toBe(false);
    } else if (mode === "mixed") {
      expect(payload.content).toContain("principal como reserva: capítulos 37");
      expect(payload.content).toContain("somente texto: capítulos 38");
      expect(requested).not.toContain("https://example.test/36/primary.png");
      expect(requested).toContain("https://example.test/37/primary.png");
    } else {
      expect(metadata.height).toBe(92 + 3 * 162);
      expect(requested.some(url => url.includes("primary"))).toBe(false);
      const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      const pixel = (x: number, y: number) => Array.from(data.subarray((y * info.width + x) * info.channels, (y * info.width + x) * info.channels + 3));
      for (let row = 0; row < 3; row++) {
        expect(pixel(60, 92 + row * 162 + 70)).toEqual([212, 59, 53]);
        expect(pixel(170, 92 + row * 162 + 70)).toEqual([55, 163, 107]);
      }
    }
  });

  it.each(["one-extra", "missing-extras", "no-images"])("delivers a notification after extra-image failure: %s", async failure => {
    vi.stubEnv("DISCORD_BOT_TOKEN", "unit-test-not-a-real-token");
    const thumbnail = await sharp({ create: { width: 40, height: 40, channels: 3, background: "#356da2" } }).png().toBuffer();
    const requests: string[] = [];
    let posted: FormData | undefined;
    vi.stubGlobal("fetch", vi.fn(async (input: string, options?: RequestInit) => {
      requests.push(String(input));
      if (String(input).startsWith("https://discord.com/api/")) {
        posted = options?.body as FormData;
        return new Response("", { status: 200 });
      }
      const available = failure !== "no-images" && (String(input).includes("primary.png") || String(input).includes("extra2.png"));
      return available ? new Response(new Uint8Array(thumbnail)) : new Response("", { status: 404 });
    }));
    const progress = vi.fn(async () => {});
    const result = await postStrip("unit-test-channel", "Mesma obra", [{
      number: "36", key: "unchanged-chapter-key", parser: "test",
      thumbnailUrl: "https://example.test/primary.png",
      subtitlePt: "Título preservado",
      extraThumbnailUrls: failure === "missing-extras" ? undefined : ["https://example.test/extra2.png", "https://example.test/extra3.png"],
    }], 1, 1, true, undefined, true, progress);
    const payload = JSON.parse(String(posted?.get("payload_json")));
    expect(payload.content).toContain("Mesma obra");
    expect(payload.content).toContain("capítulo 36");
    expect(requests.filter(url => url.startsWith("https://discord.com/api/"))).toHaveLength(1);
    if (failure === "no-images") {
      expect(result).toBe("none");
      expect(posted?.get("files[0]")).toBeNull();
      expect(payload.content).toContain("aviso em texto");
    } else {
      expect(result).toBe("primary+banner");
      expect(posted?.get("files[0]")).toBeInstanceOf(Blob);
      expect(payload.content).toContain("imagem principal usada como reserva");
      const image = posted!.get("files[0]") as Blob;
      const metadata = await sharp(Buffer.from(await image.arrayBuffer())).metadata();
      expect(metadata.width).toBe(920);
      expect(metadata.height).toBeGreaterThan(92);
    }
    expect(progress).toHaveBeenCalledWith(expect.stringContaining("mesmo capítulo"));
  });

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