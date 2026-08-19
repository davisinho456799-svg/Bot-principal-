/**
 * Comando /historico — mostra o histórico de pesquisas do usuário com paginação.
 * Fonte: tabela usage_logs (registrada automaticamente pelo bot).
 * Inclui badges de status de leitura quando disponíveis.
 */

import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ButtonInteraction,
  ComponentType,
} from "discord.js";
import { db, usageLogsTable, listaLeituraTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";

const SEARCH_COMMANDS = ["anime", "buscar", "manga", "search", "vn", "filme"];
const POR_PAGINA = 10;

const COMMAND_LABELS: Record<string, string> = {
  anime: "🎌 Anime",
  buscar: "🇰🇷 Manhwa",
  manga: "📖 Manga",
  search: "🔍 Busca",
  vn: "🎮 VN",
  filme: "🎬 Filme",
};

const STATUS_BADGES: Record<string, string> = {
  lendo: "📖",
  concluido: "✅",
  planejo: "🔖",
  pausado: "⏸️",
  abandonado: "🗑️",
};

// Formato source:id — captura para cruzar com lista_leitura
const AUTOCOMPLETE_RE = /^(anilist-anime|jikan|kitsu|anidb|vndb|erogamescape|anisearch|anilist|mangadex|comick|mangaupdates):(.+)$/;

export const data = new SlashCommandBuilder()
  .setName("historico")
  .setDescription("Mostra seu histórico de pesquisas no bot")
  .addUserOption((o) =>
    o.setName("usuario").setDescription("Ver histórico de outro usuário (opcional)").setRequired(false)
  )
  .addStringOption((o) =>
    o
      .setName("tipo")
      .setDescription("Filtrar por tipo de pesquisa")
      .setRequired(false)
      .addChoices(
        { name: "🎌 Anime", value: "anime" },
        { name: "🇰🇷 Manhwa (/buscar)", value: "buscar" },
        { name: "📖 Manga", value: "manga" },
        { name: "Todos", value: "todos" }
      )
  );

// ─── Embed de uma página ──────────────────────────────────────────────────────

function buildEmbed(opts: {
  pesquisas: { command: string; query: string | null; createdAt: Date | null }[];
  statusMap: Map<string, { status: string; capitulo: string | null }>;
  topTitulos: { query: string | null; command: string; total: number }[];
  totalPesquisas: number;
  pagina: number;
  totalPaginas: number;
  alvoName: string;
  alvoAvatar: string;
}): EmbedBuilder {
  const { pesquisas, statusMap, topTitulos, totalPesquisas, pagina, totalPaginas, alvoName, alvoAvatar } = opts;

  const inicio = pagina * POR_PAGINA;
  const paginaAtual = pesquisas.slice(inicio, inicio + POR_PAGINA);

  const linhasRecentes = paginaAtual.map((r, i) => {
    const label = COMMAND_LABELS[r.command] ?? `/${r.command}`;
    const titulo = r.query ? `**${r.query.slice(0, 50)}**` : "*filtros avançados*";
    const quando = r.createdAt
      ? `<t:${Math.floor(new Date(r.createdAt).getTime() / 1000)}:R>`
      : "";
    const num = inicio + i + 1;

    // Badge de status se a query for no formato source:id
    let badge = "";
    if (r.query) {
      const match = AUTOCOMPLETE_RE.exec(r.query);
      if (match) {
        const key = `${match[1]}:${match[2]}`;
        const entry = statusMap.get(key);
        if (entry) {
          const icon = STATUS_BADGES[entry.status] ?? "";
          const cap = entry.capitulo ? ` ep.${entry.capitulo}` : "";
          badge = ` ${icon}${cap}`;
        }
      }
    }

    return `\`${String(num).padStart(2, " ")}.\` ${label} — ${titulo}${badge} ${quando}`;
  });

  const embed = new EmbedBuilder()
    .setTitle(`🔍 Histórico de ${alvoName}`)
    .setThumbnail(alvoAvatar)
    .setColor(0x5865f2)
    .setDescription(linhasRecentes.join("\n") || "Nenhuma pesquisa nesta página.");

  if (pagina === 0 && topTitulos.length) {
    const medals = ["🥇", "🥈", "🥉", "4️⃣", "5️⃣"];
    const linhasTop = topTitulos.map((t, i) => {
      const label = COMMAND_LABELS[t.command] ?? `/${t.command}`;
      return `${medals[i] ?? "•"} **${t.query?.slice(0, 40)}** — ${label} (${t.total}x)`;
    });
    embed.addFields({ name: "🏆 Títulos mais pesquisados", value: linhasTop.join("\n"), inline: false });
  }

  embed.addFields({
    name: "📊 Total de pesquisas",
    value: `**${totalPesquisas}** pesquisas registradas`,
    inline: false,
  });

  embed.setFooter({
    text: `Página ${pagina + 1} de ${totalPaginas} • ${POR_PAGINA} por página`,
  });

  return embed;
}

// ─── Botões de navegação ─────────────────────────────────────────────────────

function buildRow(pagina: number, totalPaginas: number): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("hist_prev")
      .setLabel("⬅️ Anterior")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(pagina === 0),
    new ButtonBuilder()
      .setCustomId("hist_next")
      .setLabel("Próxima ➡️")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(pagina >= totalPaginas - 1),
  );
}

// ─── Execute ──────────────────────────────────────────────────────────────────

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const alvo = interaction.options.getUser("usuario") ?? interaction.user;
  const tipo = interaction.options.getString("tipo") ?? "todos";
  const userId = alvo.id;
  const comandosFiltro = tipo === "todos" ? SEARCH_COMMANDS : [tipo];

  // Busca pesquisas + lista de leitura em paralelo
  const [todasRaw, listaLeitura] = await Promise.all([
    db
      .select({ command: usageLogsTable.command, query: usageLogsTable.query, createdAt: usageLogsTable.createdAt })
      .from(usageLogsTable)
      .where(eq(usageLogsTable.discordUserId, userId))
      .orderBy(desc(usageLogsTable.createdAt)),
    db
      .select({ manhwaId: listaLeituraTable.manhwaId, source: listaLeituraTable.source, status: listaLeituraTable.status, capitulo: listaLeituraTable.capitulo })
      .from(listaLeituraTable)
      .where(eq(listaLeituraTable.discordUserId, userId)),
  ]);

  const todas = todasRaw.filter((r) => comandosFiltro.includes(r.command));

  if (!todas.length) {
    const filtroLabel = tipo !== "todos" ? ` de ${COMMAND_LABELS[tipo] ?? tipo}` : "";
    await interaction.editReply(
      `📭 **${alvo.displayName}** ainda não tem histórico de pesquisas${filtroLabel}.\n` +
        `Use \`/anime\`, \`/buscar\` ou \`/manga\` para começar!`
    );
    return;
  }

  // Monta mapa source:id → {status, capitulo}
  const statusMap = new Map<string, { status: string; capitulo: string | null }>();
  for (const item of listaLeitura) {
    statusMap.set(`${item.source}:${item.manhwaId}`, { status: item.status, capitulo: item.capitulo ?? null });
  }

  // Top títulos mais buscados
  const queryCount: Record<string, { count: number; command: string }> = {};
  for (const r of todas) {
    if (r.query?.trim()) {
      const k = r.query.trim().toLowerCase();
      if (!queryCount[k]) queryCount[k] = { count: 0, command: r.command };
      queryCount[k].count++;
    }
  }
  const topTitulos = Object.entries(queryCount)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 5)
    .map(([query, { count, command }]) => ({ query, command, total: count }));

  const totalPesquisas = todas.length;
  const totalPaginas = Math.ceil(todas.length / POR_PAGINA);
  let paginaAtual = 0;

  const embedInicial = buildEmbed({
    pesquisas: todas, statusMap, topTitulos, totalPesquisas,
    pagina: paginaAtual, totalPaginas,
    alvoName: alvo.displayName, alvoAvatar: alvo.displayAvatarURL(),
  });

  if (totalPaginas <= 1) {
    await interaction.editReply({ embeds: [embedInicial] });
    return;
  }

  await interaction.editReply({ embeds: [embedInicial], components: [buildRow(paginaAtual, totalPaginas)] });

  const collector = interaction.channel?.createMessageComponentCollector({
    componentType: ComponentType.Button,
    filter: (i) =>
      (i.customId === "hist_prev" || i.customId === "hist_next") &&
      i.user.id === interaction.user.id,
    time: 5 * 60 * 1000,
  });

  collector?.on("collect", async (btn: ButtonInteraction) => {
    await btn.deferUpdate();
    if (btn.customId === "hist_next") paginaAtual = Math.min(paginaAtual + 1, totalPaginas - 1);
    if (btn.customId === "hist_prev") paginaAtual = Math.max(paginaAtual - 1, 0);

    const embed = buildEmbed({
      pesquisas: todas, statusMap, topTitulos, totalPesquisas,
      pagina: paginaAtual, totalPaginas,
      alvoName: alvo.displayName, alvoAvatar: alvo.displayAvatarURL(),
    });
    await interaction.editReply({ embeds: [embed], components: [buildRow(paginaAtual, totalPaginas)] });
  });

  collector?.on("end", async () => {
    await interaction.editReply({ components: [] }).catch(() => null);
  });
}
