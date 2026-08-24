import { Router, type IRouter } from "express";
import { and, eq } from "drizzle-orm";
import { db, botConfigTable } from "@workspace/db";
import {
  GetDiscordConfigResponse,
  GetDiscordStatusResponse,
  ListDiscordChannelsResponse,
  ListDiscordGuildsResponse,
  ListDiscordChannelsParams,
  SaveDiscordConfigBody,
  SaveDiscordConfigResponse,
  SyncDiscordTableResponse,
} from "@workspace/api-zod";
import { getSeasonCatalog } from "./season-service";

const router: IRouter = Router();
const discordApi = "https://discord.com/api/v10";

function botHeaders() {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) throw new Error("DISCORD_BOT_TOKEN is not configured");
  return { Authorization: `Bot ${token}`, "Content-Type": "application/json" };
}

async function discordFetch(path: string, init?: RequestInit) {
  const response = await fetch(`${discordApi}${path}`, {
    ...init,
    headers: { ...botHeaders(), ...(init?.headers ?? {}) },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Discord ${response.status}: ${body.slice(0, 240)}`);
  }
  return response;
}

export async function config() {
  const found = await db.select().from(botConfigTable).limit(1);
  if (found[0]) return found[0];
  const [created] = await db.insert(botConfigTable).values({}).returning();
  return created;
}

function publicConfig(value: Awaited<ReturnType<typeof config>>) {
  return {
    guildId: value.guildId,
    channelId: value.channelId,
    intervalMinutes: value.intervalMinutes,
    includeAnime: value.includeAnime,
    includeManga: value.includeManga,
    enabled: value.enabled,
    lastSyncedAt: value.lastSyncedAt,
    messageId: value.messageId,
  };
}

router.get("/discord/guilds", async (req, res) => {
  try {
    const response = await discordFetch("/users/@me/guilds?limit=100");
    const data = (await response.json() as Array<{ id: string; name: string; icon?: string | null }>).map((guild) => ({
      id: guild.id,
      name: guild.name,
      iconUrl: guild.icon ? `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png` : null,
    }));
    res.json(ListDiscordGuildsResponse.parse(data));
  } catch (error) {
    req.log.error({ err: error }, "Failed to list Discord guilds");
    res.status(502).json({ error: "Não foi possível acessar os servidores do Discord." });
  }
});

router.get("/discord/guilds/:guildId/channels", async (req, res) => {
  try {
    const params = ListDiscordChannelsParams.parse(req.params);
    const response = await discordFetch(`/guilds/${params.guildId}/channels`);
    const data = (await response.json() as Array<{ id: string; name: string; type: number }>)
      .filter((channel) => channel.type === 0 || channel.type === 5)
      .map((channel) => ({ id: channel.id, name: channel.name, type: channel.type === 5 ? "announcement" : "text" }));
    res.json(ListDiscordChannelsResponse.parse(data));
  } catch (error) {
    req.log.error({ err: error }, "Failed to list Discord channels");
    res.status(502).json({ error: "Não foi possível carregar os canais desse servidor." });
  }
});

router.get("/discord/config", async (_req, res) => {
  const value = await config();
  res.json(GetDiscordConfigResponse.parse(publicConfig(value)));
});

router.put("/discord/config", async (req, res) => {
  try {
    const input = SaveDiscordConfigBody.parse(req.body);
    const current = await config();
    const [updated] = await db.update(botConfigTable).set(input).where(eq(botConfigTable.id, current.id)).returning();
    res.json(SaveDiscordConfigResponse.parse(publicConfig(updated)));
  } catch (error) {
    req.log.error({ err: error }, "Failed to save Discord config");
    res.status(400).json({ error: "As configurações do Discord são inválidas." });
  }
});

router.get("/discord/status", async (_req, res) => {
  const value = await config();
  let connected = false;
  if (process.env.DISCORD_BOT_TOKEN) {
    try {
      await discordFetch("/users/@me");
      connected = true;
    } catch {
      connected = false;
    }
  }
  res.json(GetDiscordStatusResponse.parse({
    configured: Boolean(value.guildId && value.channelId),
    connected,
    enabled: value.enabled,
    lastSyncedAt: value.lastSyncedAt,
  }));
});

export async function syncConfiguredChannel() {
  const value = await config();
  if (!value.channelId) throw new Error("Escolha um canal antes de sincronizar.");
    const catalog = await getSeasonCatalog();
    const content = formatDiscordTable(catalog, value.includeAnime, value.includeManga);
    let messageId = value.messageId;
    if (messageId) {
      try {
        await discordFetch(`/channels/${value.channelId}/messages/${messageId}`, { method: "PATCH", body: JSON.stringify({ content }) });
      } catch {
        messageId = null;
      }
    }
    if (!messageId) {
      const response = await discordFetch(`/channels/${value.channelId}/messages`, { method: "POST", body: JSON.stringify({ content }) });
      messageId = (await response.json() as { id: string }).id;
    }
    const syncedAt = new Date();
    await db.update(botConfigTable).set({ messageId, lastSyncedAt: syncedAt }).where(eq(botConfigTable.id, value.id));
    return SyncDiscordTableResponse.parse({ success: true, message: "Tabela publicada e atualizada no Discord.", updatedAt: syncedAt });
}

router.post("/discord/sync", async (req, res) => {
  try {
    res.json(await syncConfiguredChannel());
  } catch (error) {
    req.log.error({ err: error }, "Failed to sync Discord table");
    res.status(502).json({ error: "Não foi possível atualizar a tabela no Discord." });
  }
});

function formatDiscordTable(catalog: Awaited<ReturnType<typeof getSeasonCatalog>>, includeAnime: boolean, includeManga: boolean) {
  const seasonNames: Record<string, string> = { winter: "Inverno", spring: "Primavera", summer: "Verão", fall: "Outono" };
  const seasonName = seasonNames[catalog.season] ?? catalog.season;
  const lines = [
    `📺 **CALENDÁRIO DE ANIME — ${seasonName} ${catalog.year}**`,
    "_Atualizado automaticamente pelo Anime Season Board_",
    "",
  ];

  const formatItem = (item: (typeof catalog.anime)[number], statusLabel: string) => {
    const score = item.score !== null ? `⭐ ${item.score.toFixed(1)}` : "⭐ —";
    const episodes = item.episodes ? ` • ${item.episodes} episódios` : "";
    const genres = item.genres.slice(0, 2).join(", ");
    return [
      `**[${item.title.slice(0, 70)}](${item.url})** ${score}`,
      `> ${statusLabel}${episodes}${genres ? ` • 🏷️ ${genres}` : ""}`,
    ];
  };

  if (includeAnime) {
    const airing = catalog.anime.filter((item) => item.status === "airing").slice(0, 8);
    const upcoming = catalog.anime.filter((item) => item.status === "upcoming").slice(0, 6);
    if (airing.length) {
      lines.push("🟢 **ANIMES NO AR**", "");
      for (const item of airing) lines.push(...formatItem(item, "No ar"), "");
    }
    if (upcoming.length) {
      lines.push("🔜 **ANIMES QUE VÃO ENTRAR**", "");
      for (const item of upcoming) lines.push(...formatItem(item, "Em breve"), "");
    }
  }

  if (includeManga && catalog.manga.length) {
    lines.push("📚 **MANGÁS EM PUBLICAÇÃO**", "");
    for (const item of catalog.manga.slice(0, 4)) lines.push(...formatItem(item, "Publicando"), "");
  }

  const output = lines.join("\n");
  return output.length <= 1990 ? output : output.slice(0, 1980) + "\n\n…_Lista reduzida para caber no Discord._";
}

export default router;