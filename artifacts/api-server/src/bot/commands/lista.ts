import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  ComponentType,
} from "discord.js";
import { db, listaLeituraTable } from "@workspace/db";
import { STATUS_OPCOES, STATUS_LABELS, type StatusLeitura } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { searchAllSources } from "../unified.js";

const CORES: Record<StatusLeitura, number> = {
  lendo: 0x2ecc71,
  concluido: 0x3498db,
  planejo: 0x9b59b6,
  pausado: 0xf39c12,
  abandonado: 0xe74c3c,
};

const EMOJIS: Record<StatusLeitura, string> = {
  lendo: "📖",
  concluido: "✅",
  planejo: "🔖",
  pausado: "⏸️",
  abandonado: "🗑️",
};

export const data = new SlashCommandBuilder()
  .setName("lista")
  .setDescription("Sua lista de leitura pessoal com status por manhwa")
  .addSubcommand((s) =>
    s
      .setName("adicionar")
      .setDescription("Adiciona um manhwa à sua lista")
      .addStringOption((o) =>
        o.setName("titulo").setDescription("Nome do manhwa").setRequired(true)
      )
      .addStringOption((o) =>
        o
          .setName("status")
          .setDescription("Status de leitura")
          .setRequired(true)
          .addChoices(
            { name: "📖 Lendo", value: "lendo" },
            { name: "✅ Concluído", value: "concluido" },
            { name: "🔖 Planejo Ler", value: "planejo" },
            { name: "⏸️ Pausado", value: "pausado" },
            { name: "🗑️ Abandonado", value: "abandonado" }
          )
      )
  )
  .addSubcommand((s) =>
    s
      .setName("ver")
      .setDescription("Exibe sua lista de leitura")
      .addStringOption((o) =>
        o
          .setName("status")
          .setDescription("Filtrar por status (padrão: todos)")
          .setRequired(false)
          .addChoices(
            { name: "📖 Lendo", value: "lendo" },
            { name: "✅ Concluído", value: "concluido" },
            { name: "🔖 Planejo Ler", value: "planejo" },
            { name: "⏸️ Pausado", value: "pausado" },
            { name: "🗑️ Abandonado", value: "abandonado" }
          )
      )
  )
  .addSubcommand((s) =>
    s
      .setName("mover")
      .setDescription("Muda o status de um manhwa na sua lista")
      .addStringOption((o) =>
        o.setName("titulo").setDescription("Nome do manhwa").setRequired(true)
      )
      .addStringOption((o) =>
        o
          .setName("status")
          .setDescription("Novo status")
          .setRequired(true)
          .addChoices(
            { name: "📖 Lendo", value: "lendo" },
            { name: "✅ Concluído", value: "concluido" },
            { name: "🔖 Planejo Ler", value: "planejo" },
            { name: "⏸️ Pausado", value: "pausado" },
            { name: "🗑️ Abandonado", value: "abandonado" }
          )
      )
  )
  .addSubcommand((s) =>
    s
      .setName("remover")
      .setDescription("Remove um manhwa da sua lista")
      .addStringOption((o) =>
        o.setName("titulo").setDescription("Nome do manhwa").setRequired(true)
      )
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const sub = interaction.options.getSubcommand();
  if (sub === "adicionar") await handleAdicionar(interaction);
  else if (sub === "ver") await handleVer(interaction);
  else if (sub === "mover") await handleMover(interaction);
  else if (sub === "remover") await handleRemover(interaction);
}

async function handleAdicionar(interaction: ChatInputCommandInteraction) {
  const titulo = interaction.options.getString("titulo", true);
  const status = interaction.options.getString("status", true) as StatusLeitura;
  await interaction.deferReply({ ephemeral: true });

  const results = await searchAllSources(titulo).catch(() => []);
  if (!results.length) {
    await interaction.editReply(`❌ Nenhum manhwa encontrado para **${titulo}**.`);
    return;
  }

  const notInList: (typeof results)[number][] = [];
  for (const r of results.slice(0, 10)) {
    const [existing] = await db
      .select()
      .from(listaLeituraTable)
      .where(
        and(
          eq(listaLeituraTable.discordUserId, interaction.user.id),
          eq(listaLeituraTable.manhwaId, r.id)
        )
      );
    if (!existing) notInList.push(r);
  }

  if (!notInList.length) {
    await interaction.editReply("⚠️ Todos os resultados já estão na sua lista!");
    return;
  }

  if (notInList.length === 1) {
    const m = notInList[0];
    await db.insert(listaLeituraTable).values({
      discordUserId: interaction.user.id,
      manhwaId: m.id,
      source: m.source,
      title: m.mainTitle,
      coverUrl: m.coverUrl ?? null,
      siteUrl: m.siteUrl,
      genres: m.genres.join(", "),
      score: m.score?.toString() ?? null,
      status,
    });
    await interaction.editReply(
      `${EMOJIS[status]} **${m.mainTitle}** adicionado à lista como **${STATUS_LABELS[status]}**!`
    );
    return;
  }

  const options = notInList.slice(0, 10).map((r) => ({
    label: r.mainTitle.slice(0, 100),
    description: (r.genres.slice(0, 3).join(", ") || "Sem gênero").slice(0, 100),
    value: `${r.source}:${r.id}`,
  }));

  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("lista_add_select")
      .setPlaceholder("Selecione o manhwa correto")
      .addOptions(options)
  );

  await interaction.editReply({
    content: `📚 Encontrei **${notInList.length}** resultados. Qual deseja adicionar?`,
    components: [row],
  });

  const collector = interaction.channel?.createMessageComponentCollector({
    componentType: ComponentType.StringSelect,
    filter: (i) => i.customId === "lista_add_select" && i.user.id === interaction.user.id,
    time: 30_000,
    max: 1,
  });

  collector?.on("collect", async (sel: StringSelectMenuInteraction) => {
    await sel.deferUpdate();
    const [src, id] = sel.values[0].split(":");
    const chosen = notInList.find((r) => r.source === src && r.id === id);
    if (!chosen) {
      await interaction.editReply({ content: "❌ Erro ao selecionar.", components: [] });
      return;
    }
    await db.insert(listaLeituraTable).values({
      discordUserId: interaction.user.id,
      manhwaId: chosen.id,
      source: chosen.source,
      title: chosen.mainTitle,
      coverUrl: chosen.coverUrl ?? null,
      siteUrl: chosen.siteUrl,
      genres: chosen.genres.join(", "),
      score: chosen.score?.toString() ?? null,
      status,
    });
    await interaction.editReply({
      content: `${EMOJIS[status]} **${chosen.mainTitle}** adicionado à lista como **${STATUS_LABELS[status]}**!`,
      components: [],
    });
  });

  collector?.on("end", async (_c, reason) => {
    if (reason === "time")
      await interaction.editReply({ content: "⏱️ Tempo esgotado.", components: [] });
  });
}

async function handleVer(interaction: ChatInputCommandInteraction) {
  const statusFiltro = interaction.options.getString("status") as StatusLeitura | null;
  await interaction.deferReply({ ephemeral: true });

  const rows = await db
    .select()
    .from(listaLeituraTable)
    .where(
      statusFiltro
        ? and(
            eq(listaLeituraTable.discordUserId, interaction.user.id),
            eq(listaLeituraTable.status, statusFiltro)
          )
        : eq(listaLeituraTable.discordUserId, interaction.user.id)
    );

  if (!rows.length) {
    await interaction.editReply(
      statusFiltro
        ? `📭 Você não tem nenhum manhwa com status **${STATUS_LABELS[statusFiltro]}**.`
        : "📭 Sua lista está vazia. Use `/lista adicionar` para começar!"
    );
    return;
  }

  const grouped: Partial<Record<StatusLeitura, typeof rows>> = {};
  for (const r of rows) {
    const s = r.status as StatusLeitura;
    if (!grouped[s]) grouped[s] = [];
    grouped[s]!.push(r);
  }

  const statusOrder: StatusLeitura[] = ["lendo", "concluido", "planejo", "pausado", "abandonado"];
  const fields = statusOrder
    .filter((s) => grouped[s]?.length)
    .map((s) => {
      const items = grouped[s]!.slice(0, 15);
      const lines = items.map((r) => `> [${r.title}](${r.siteUrl})`).join("\n");
      const extra = grouped[s]!.length > 15 ? `\n> *...e mais ${grouped[s]!.length - 15}*` : "";
      return { name: `${STATUS_LABELS[s]} — ${grouped[s]!.length}`, value: lines + extra, inline: false };
    });

  const cor = statusFiltro ? CORES[statusFiltro] : 0x7b68ee;
  const embed = new EmbedBuilder()
    .setTitle(`📚 Lista de Leitura de ${interaction.user.displayName}`)
    .setColor(cor)
    .addFields(fields)
    .setFooter({ text: `${rows.length} manhwa(s) na lista` });

  await interaction.editReply({ embeds: [embed] });
}

async function handleMover(interaction: ChatInputCommandInteraction) {
  const titulo = interaction.options.getString("titulo", true);
  const novoStatus = interaction.options.getString("status", true) as StatusLeitura;
  await interaction.deferReply({ ephemeral: true });

  const todos = await db
    .select()
    .from(listaLeituraTable)
    .where(eq(listaLeituraTable.discordUserId, interaction.user.id));

  const matches = todos.filter((r) =>
    r.title.toLowerCase().includes(titulo.toLowerCase())
  );

  if (!matches.length) {
    await interaction.editReply(`❌ Nenhum manhwa com esse nome na sua lista.`);
    return;
  }

  if (matches.length === 1) {
    await db
      .update(listaLeituraTable)
      .set({ status: novoStatus })
      .where(eq(listaLeituraTable.id, matches[0].id));
    await interaction.editReply(
      `✅ **${matches[0].title}** movido para **${STATUS_LABELS[novoStatus]}**!`
    );
    return;
  }

  const options = matches.slice(0, 10).map((r) => ({
    label: r.title.slice(0, 100),
    description: STATUS_LABELS[r.status as StatusLeitura] ?? r.status,
    value: String(r.id),
  }));

  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("lista_mover_select")
      .setPlaceholder("Selecione o manhwa")
      .addOptions(options)
  );

  await interaction.editReply({
    content: `📋 Vários resultados encontrados. Qual deseja mover?`,
    components: [row],
  });

  const collector = interaction.channel?.createMessageComponentCollector({
    componentType: ComponentType.StringSelect,
    filter: (i) => i.customId === "lista_mover_select" && i.user.id === interaction.user.id,
    time: 30_000,
    max: 1,
  });

  collector?.on("collect", async (sel: StringSelectMenuInteraction) => {
    await sel.deferUpdate();
    const chosen = matches.find((r) => String(r.id) === sel.values[0]);
    if (!chosen) {
      await interaction.editReply({ content: "❌ Erro.", components: [] });
      return;
    }
    await db
      .update(listaLeituraTable)
      .set({ status: novoStatus })
      .where(eq(listaLeituraTable.id, chosen.id));
    await interaction.editReply({
      content: `✅ **${chosen.title}** movido para **${STATUS_LABELS[novoStatus]}**!`,
      components: [],
    });
  });

  collector?.on("end", async (_c, reason) => {
    if (reason === "time")
      await interaction.editReply({ content: "⏱️ Tempo esgotado.", components: [] });
  });
}

async function handleRemover(interaction: ChatInputCommandInteraction) {
  const titulo = interaction.options.getString("titulo", true);
  await interaction.deferReply({ ephemeral: true });

  const todos = await db
    .select()
    .from(listaLeituraTable)
    .where(eq(listaLeituraTable.discordUserId, interaction.user.id));

  const matches = todos.filter((r) =>
    r.title.toLowerCase().includes(titulo.toLowerCase())
  );

  if (!matches.length) {
    await interaction.editReply(`❌ Nenhum manhwa com esse nome na sua lista.`);
    return;
  }

  if (matches.length === 1) {
    await db
      .delete(listaLeituraTable)
      .where(eq(listaLeituraTable.id, matches[0].id));
    await interaction.editReply(`🗑️ **${matches[0].title}** removido da sua lista.`);
    return;
  }

  const options = matches.slice(0, 10).map((r) => ({
    label: r.title.slice(0, 100),
    description: STATUS_LABELS[r.status as StatusLeitura] ?? r.status,
    value: String(r.id),
  }));

  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("lista_rem_select")
      .setPlaceholder("Selecione o manhwa a remover")
      .addOptions(options)
  );

  await interaction.editReply({
    content: `📋 Qual deseja remover?`,
    components: [row],
  });

  const collector = interaction.channel?.createMessageComponentCollector({
    componentType: ComponentType.StringSelect,
    filter: (i) => i.customId === "lista_rem_select" && i.user.id === interaction.user.id,
    time: 30_000,
    max: 1,
  });

  collector?.on("collect", async (sel: StringSelectMenuInteraction) => {
    await sel.deferUpdate();
    const chosen = matches.find((r) => String(r.id) === sel.values[0]);
    if (!chosen) {
      await interaction.editReply({ content: "❌ Erro.", components: [] });
      return;
    }
    await db.delete(listaLeituraTable).where(eq(listaLeituraTable.id, chosen.id));
    await interaction.editReply({
      content: `🗑️ **${chosen.title}** removido da sua lista.`,
      components: [],
    });
  });

  collector?.on("end", async (_c, reason) => {
    if (reason === "time")
      await interaction.editReply({ content: "⏱️ Tempo esgotado.", components: [] });
  });
}
