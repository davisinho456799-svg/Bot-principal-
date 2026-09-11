import { EmbedBuilder } from "discord.js";

export const PANEL_WATCH_NAME = "Panel Watch";
export const PANEL_WATCH_TAGLINE = "Radar de leitura";

export const PANEL_WATCH_COLORS = {
  primary: 0x6d5dfc,
  manhwa: 0x8b5cf6,
  manga: 0xf59e0b,
  anime: 0x06b6d4,
  adult: 0xe11d48,
  success: 0x22c55e,
  status: 0x3b82f6,
  warning: 0xf97316,
  finished: 0xa855f7,
} as const;

export type WorkIdentity = {
  icon: string;
  label: string;
  color: number;
  unit: string;
  unitPlural: string;
};

function isAnimeSource(source?: string): boolean {
  return source === "anilist-anime" || source === "jikan-anime";
}

export function getWorkIdentity(source?: string, adult = false): WorkIdentity {
  if (adult) {
    const anime = isAnimeSource(source);
    return {
      icon: "🔞",
      label: "Conteúdo +18",
      color: PANEL_WATCH_COLORS.adult,
      unit: anime ? "episódio" : "capítulo",
      unitPlural: anime ? "episódios" : "capítulos",
    };
  }

  if (isAnimeSource(source)) {
    return {
      icon: "📺",
      label: "Anime",
      color: PANEL_WATCH_COLORS.anime,
      unit: "episódio",
      unitPlural: "episódios",
    };
  }

  if (source === "manga" || source === "mangadex" || source === "mangaupdates") {
    return {
      icon: "📚",
      label: "Manga",
      color: PANEL_WATCH_COLORS.manga,
      unit: "capítulo",
      unitPlural: "capítulos",
    };
  }

  return {
    icon: "🔮",
    label: "Manhwa",
    color: PANEL_WATCH_COLORS.manhwa,
    unit: "capítulo",
    unitPlural: "capítulos",
  };
}

export function createPanelWatchEmbed(color: number = PANEL_WATCH_COLORS.primary): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(color)
    .setAuthor({ name: `${PANEL_WATCH_NAME} · ${PANEL_WATCH_TAGLINE}` })
    .setFooter({ text: `${PANEL_WATCH_NAME} • ${PANEL_WATCH_TAGLINE}` })
    .setTimestamp();
}

export function setPanelWatchFooter(
  embed: EmbedBuilder,
  context: string,
): EmbedBuilder {
  return embed.setFooter({ text: `${PANEL_WATCH_NAME} • ${context}` });
}