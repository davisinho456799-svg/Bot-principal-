import { type Client, EmbedBuilder, TextChannel } from "discord.js";
import { db, notificacaoCanaisTable, capitulosRastreados, favoritosTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { logger } from "../lib/logger.js";
import { buildScanLinksExternal } from "./commands/search.js";

const ANILIST_API = "https://graphql.anilist.co";
const CHECK_INTERVAL_MS = 2 * 60 * 60 * 1000; // 2 horas

const CHAPTERS_QUERY = `
query GetChapters($id: Int!) {
  Media(id: $id, type: MANGA) {
    chapters
    status
    title { english romaji }
    siteUrl
    coverImage { large color }
  }
}
`;

interface MediaInfo {
  chapters: number | null;
  status: string | null;
  title: { english: string | null; romaji: string };
  siteUrl: string;
  coverImage: { large: string; color: string | null };
}

async function fetchChapters(manhwaId: string, source: string): Promise<number | null> {
  if (source === "anilist") {
    try {
      const res = await fetch(ANILIST_API, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ query: CHAPTERS_QUERY, variables: { id: parseInt(manhwaId, 10) } }),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return null;
      const json = (await res.json()) as { data: { Media: MediaInfo } };
      return json.data?.Media?.chapters ?? null;
    } catch {
      return null;
    }
  }

  if (source === "mangadex") {
    try {
      const params = new URLSearchParams({ manga: manhwaId, "translatedLanguage[]": "pt-br", limit: "1", "order[chapter]": "desc" });
      const res = await fetch(`https://api.mangadex.org/chapter?${params}`, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) return null;
      const json = (await res.json()) as { data: { attributes: { chapter: string | null } }[]; total: number };
      if (!json.data?.length) return null;
      const chap = json.data[0].attributes.chapter;
      return chap ? parseFloat(chap) : json.total;
    } catch {
      return null;
    }
  }

  return null;
}

async function getTrackedManhwas() {
  const favorites = await db
    .selectDistinctOn([favoritosTable.manhwaId], {
      manhwaId: favoritosTable.manhwaId,
      source: favoritosTable.source,
      title: favoritosTable.title,
      coverUrl: favoritosTable.coverUrl,
      siteUrl: favoritosTable.siteUrl,
    })
    .from(favoritosTable);

  return favorites;
}

async function sendNotification(
  client: Client,
  channelId: string,
  title: string,
  newChapters: number,
  oldChapters: number | null,
  siteUrl: string,
  coverUrl: string | null
) {
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || !(channel instanceof TextChannel)) return;

    const newCount = Math.floor(newChapters);
    const oldCount = oldChapters ? Math.floor(oldChapters) : 0;
    const diff = newCount - oldCount;

    const embed = new EmbedBuilder()
      .setTitle(`📬 Novo(s) Capítulo(s): ${title}`)
      .setURL(siteUrl)
      .setColor(0x2ecc71)
      .setDescription(
        `**${diff > 0 ? diff : "Alguns"}** novo(s) capítulo(s) disponível(eis)!\n\n` +
        `📖 Total agora: **${newCount}** capítulos\n\n` +
        `🔎 **Buscar nos sites BR:**\n${buildScanLinksExternal(title)}`
      )
      .setFooter({ text: "Notificação automática • Bot de Manhwa" });

    if (coverUrl) embed.setThumbnail(coverUrl);

    await channel.send({ embeds: [embed] });
  } catch (err) {
    logger.error({ err, channelId }, "Erro ao enviar notificação");
  }
}

async function runCheck(client: Client) {
  logger.info("Verificando atualizações de capítulos...");

  const canais = await db.select().from(notificacaoCanaisTable);
  if (!canais.length) return;

  const manhwas = await getTrackedManhwas();
  if (!manhwas.length) return;

  for (const m of manhwas) {
    try {
      const newChapters = await fetchChapters(m.manhwaId, m.source);
      if (newChapters === null) continue;

      const [existing] = await db
        .select()
        .from(capitulosRastreados)
        .where(eq(capitulosRastreados.manhwaId, m.manhwaId));

      if (!existing) {
        await db.insert(capitulosRastreados).values({
          manhwaId: m.manhwaId,
          source: m.source,
          title: m.title,
          coverUrl: m.coverUrl,
          siteUrl: m.siteUrl,
          lastChapters: newChapters,
        });
        continue;
      }

      const lastChapters = existing.lastChapters ?? 0;

      if (newChapters > lastChapters) {
        logger.info({ title: m.title, lastChapters, newChapters }, "Novos capítulos detectados!");

        for (const canal of canais) {
          await sendNotification(client, canal.channelId, m.title, newChapters, lastChapters, m.siteUrl, m.coverUrl ?? null);
        }

        await db
          .update(capitulosRastreados)
          .set({ lastChapters: newChapters, lastChecked: sql`now()` })
          .where(eq(capitulosRastreados.manhwaId, m.manhwaId));
      } else {
        await db
          .update(capitulosRastreados)
          .set({ lastChecked: sql`now()` })
          .where(eq(capitulosRastreados.manhwaId, m.manhwaId));
      }

      await new Promise((r) => setTimeout(r, 500));
    } catch (err) {
      logger.error({ err, manhwa: m.title }, "Erro ao verificar capítulos");
    }
  }

  logger.info("Verificação de capítulos concluída.");
}

export function startNotificacaoService(client: Client) {
  const runSafe = async () => {
    try {
      await runCheck(client);
    } catch (err) {
      logger.error({ err }, "Erro no serviço de notificações");
    }
  };

  setTimeout(runSafe, 60_000);
  setInterval(runSafe, CHECK_INTERVAL_MS);
  logger.info({ intervalHoras: 2 }, "Serviço de notificações iniciado");
}
