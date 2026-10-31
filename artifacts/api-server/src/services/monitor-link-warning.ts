import { createHash } from "node:crypto";
import type { MonitorPlatform } from "./parsers/parser-types";

const PLATFORM_HOSTS: Record<MonitorPlatform, string> = {
  lezhin: "lezhin.com",
  toomics: "toomics.com",
  toptoon: "toptoon.com",
};

export function getMonitorLinkRedirect(
  inputUrl: string,
  platform: MonitorPlatform,
  finalUrl?: string,
) {
  const expectedHost = PLATFORM_HOSTS[platform];
  const input = new URL(inputUrl);
  const final = finalUrl ? new URL(finalUrl) : undefined;
  const isOfficial = (hostname: string) =>
    hostname === expectedHost || hostname.endsWith(`.${expectedHost}`);
  if (isOfficial(input.hostname.toLowerCase()) &&
      (!final || isOfficial(final.hostname.toLowerCase()))) return null;

  return {
    expectedHost,
    inputHost: input.hostname.toLowerCase(),
    finalHost: final?.hostname.toLowerCase() ?? null,
  };
}

export function monitorLinkWarningKey(workId: number, platform: MonitorPlatform, url: string) {
  let canonical = url;
  try {
    const parsed = new URL(url);
    const nested = parsed.searchParams.get("url");
    if ((parsed.hostname === "google.com" || parsed.hostname.endsWith(".google.com")) && nested) {
      canonical = nested;
    }
  } catch {
    // Invalid URLs are handled by the command validation path.
  }
  return createHash("sha256")
    .update(`${workId}|${platform}|${canonical}`)
    .digest("hex");
}

export function formatMonitorLinkWarning(
  title: string,
  redirect: ReturnType<typeof getMonitorLinkRedirect>,
) {
  if (!redirect) return null;
  const destination = redirect.finalHost && redirect.finalHost !== redirect.inputHost
    ? ` Destino observado: **${redirect.finalHost}**.`
    : "";
  return `⚠️ **Link não direto para o site oficial**\nA obra **${title}** usa um endereço em **${redirect.inputHost}**, mas o site esperado é **${redirect.expectedHost}**.${destination}\nPrefira salvar o endereço direto do site para evitar falhas na leitura dos capítulos.`;
}
