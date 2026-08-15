import {
  ChatInputCommandInteraction,
  AutocompleteInteraction,
  SlashCommandBuilder,
  EmbedBuilder,
} from "discord.js";
import { db, assinaturasTable, notificacaoCanaisTable } from "@workspace/db";
import { eq, and, ilike } from "drizzle-orm";
import { getUnifiedById, getUnifiedAnimeById } from "../unified.js";
import { respondAutocomplete, respondAutocompleteAnime } from "../autocomplete.js";

export const data = new SlashCommandBuilder()
  .setName("assinar18")
  .setDescription("⚠️ +18 — Receba uma menção quando saírem novos episódios/capítulos de um título adulto")
  .setNSFW(true)
  .addSubcommand((sub) =>
    sub
      .setName("adicionar")
      .setDescription("Inscreva-se para receber notificações de um título +18")
      .addStringOption((opt) =>
        opt
          .setName("tipo")
          .setDescription("Tipo do título")
          .setRequired(true)
          .addChoices(
            { name: "🎬 Anime +18",    value: "anime"   },
            { name: "🇯🇵 Manga +18",   value: "manga"   },
            { name: "🇰🇷 Manhwa +18",  value: "manhwa"  },
          )
      )
      .addStringOption((opt) =>
        opt
          .setName("titulo")
          .setDescription("Nome do título para pesquisar")
          .setRequired(true)
          .setAutocomplete(true)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName("remover")
      .setDescription("Cancele sua inscrição de notificações de um título +18")
      .addStringOption((opt) =>
        opt
          .setName("titulo")
          .setDescription("Digite para filtrar suas assinaturas +18")
          .setRequired(true)
          .setAutocomplete(true)
      )
  )
  .addSubcommand((sub) =>
    sub.setName("listar").setDescription("Veja todos os títulos +18 que você está assinando")
  );

export async function autocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const sub = interaction.options.getSubcommand(false);

  // Autocomplete do /assinar18 remover — mostra só as assinaturas +18 do próprio usuário
  if (sub === "remover") {
    if (!interaction.guildId) { await interaction.respond([]); return; }
    const focused  = interaction.options.getFocused();
    const userId   = interaction.user.id;
    const guildId  = interaction.guildId;
    try {
      const subs = await db
        .select({ title: assinaturasTable.title, manhwaId: assinaturasTable.manhwaId })
        .from(assinaturasTable)
        .where(and(
          eq(assinaturasTable.discordUserId, userId),
          eq(assinaturasTable.guildId, guildId),
          eq(assinaturasTable.adult, true),
          focused ? ilike(assinaturasTable.title, `%${focused}%`) : undefined,
        ))
        .limit(25);
      await interaction.respond(
        subs.map((s) => ({ name: s.title.slice(0, 100), value: s.manhwaId })),
      );
    } catch {
      await interaction.respond([]);
    }
    return;
  }

  // Autocomplete do /assinar18 adicionar
  const tipo    = interaction.options.getString("tipo") ?? "manhwa";
  const focused = interaction.options.getFocused();
  if (tipo === "anime") {
    await respondAutocompleteAnime(interaction, focused);
  } else {
    await respondAutocomplete(interaction, focused);
  }
}

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const sub = interaction.options.getSubcommand();
  if (sub === "adicionar") await handleAdicionar(interaction);
  else if (sub === "remover") await handleRemover(interaction);
  else if (sub === "listar") await handleListar(interaction);
}

async function handleAdicionar(interaction: ChatInputCommandInteraction) {
  if (!interaction.guildId) {
    await interaction.reply({ content: "❌ Este comando só pode ser usado em servidores.", ephemeral: true });
    return;
  }

  const tipo   = interaction.options.getString("tipo", true) as "anime" | "manga" | "manhwa";
  const titulo = interaction.options.getString("titulo", true);
  await interaction.deferReply({ ephemeral: true });

  if (!/^(anilist|anilist-anime|comick|mangadex|mangaupdates|jikan|vndb|erogamescape):[^\s]+$/.test(titulo)) {
    await interaction.editReply("❌ Por favor, selecione um título da lista de sugestões ao digitar.");
    return;
  }

  const [src, ...idParts] = titulo.split(":");
  const id = idParts.join(":");
  const result = src === "anilist-anime"
    ? await getUnifiedAnimeById("anilist-anime", id)
    : await getUnifiedById(src as "anilist" | "mangadex" | "comick" | "mangaupdates" | "jikan" | "vndb" | "erogamescape", id);

  if (!result) {
    await interaction.editReply("❌ Não foi possível buscar as informações desse título. Tente novamente.");
    return;
  }

  const { id: manhwaId, source, mainTitle: title, coverUrl, siteUrl } = result;
  const userId  = interaction.user.id;
  const guildId = interaction.guildId;

  const existing = await db
    .select({ id: assinaturasTable.id })
    .from(assinaturasTable)
    .where(and(
      eq(assinaturasTable.discordUserId, userId),
      eq(assinaturasTable.manhwaId, manhwaId),
      eq(assinaturasTable.guildId, guildId),
    ));

  if (existing.length) {
    await interaction.editReply(`⚠️ Você já está assinando **${title}** neste servidor!`);
    return;
  }

  await db.insert(assinaturasTable).values({
    discordUserId: userId,
    guildId,
    manhwaId,
    source,
    title,
    coverUrl: coverUrl ?? null,
    siteUrl,
    tipo,
    adult: true,
  });

  const tipoLabel: Record<string, string> = {
    anime:  "🎬 episódios",
    manga:  "🇯🇵 capítulos",
    manhwa: "🇰🇷 capítulos",
  };

  // Verifica se o servidor tem canal de notificações configurado
  const [canalConfigurado] = await db
    .select({ channelId: notificacaoCanaisTable.channelId })
    .from(notificacaoCanaisTable)
    .where(eq(notificacaoCanaisTable.guildId, guildId));

  const avisoCanal = canalConfigurado
    ? ""
    : "\n> ⚠️ **Atenção:** este servidor ainda não tem canal de notificações configurado. Um moderador precisa usar `/notificar canal` para ativar as notificações.";

  const embed = new EmbedBuilder()
    .setTitle("🔔 Assinatura +18 Confirmada!")
    .setColor(0xe74c3c)
    .setDescription(
      `Você será **mencionado** neste servidor quando saírem novos ${tipoLabel[tipo] ?? "capítulos"} de:\n\n` +
      `🔞 **[${title}](${siteUrl})**\n\n` +
      `> ✅ Verificações automáticas a cada **2 horas**.\n` +
      `> 📋 \`/assinar18 listar\` para ver suas assinaturas +18.\n` +
      `> ❌ \`/assinar18 remover\` para cancelar.` +
      avisoCanal
    )
    .setFooter({ text: "⚠️ Conteúdo adulto (+18) • Notificações automáticas" });

  if (coverUrl) embed.setThumbnail(coverUrl);
  await interaction.editReply({ embeds: [embed] });
}

async function handleRemover(interaction: ChatInputCommandInteraction) {
  if (!interaction.guildId) {
    await interaction.reply({ content: "❌ Este comando só pode ser usado em servidores.", ephemeral: true });
    return;
  }
  await interaction.deferReply({ ephemeral: true });

  const userId  = interaction.user.id;
  const guildId = interaction.guildId;
  const titulo  = interaction.options.getString("titulo", true);

  // Valor do autocomplete = manhwaId exato; texto livre = busca por título.
  let subs = await db
    .select()
    .from(assinaturasTable)
    .where(and(
      eq(assinaturasTable.discordUserId, userId),
      eq(assinaturasTable.guildId, guildId),
      eq(assinaturasTable.adult, true),
      eq(assinaturasTable.manhwaId, titulo),
    ));

  if (!subs.length) {
    subs = await db
      .select()
      .from(assinaturasTable)
      .where(and(
        eq(assinaturasTable.discordUserId, userId),
        eq(assinaturasTable.guildId, guildId),
        eq(assinaturasTable.adult, true),
        ilike(assinaturasTable.title, `%${titulo}%`),
      ));
  }

  if (!subs.length) {
    await interaction.editReply(`❌ Nenhuma assinatura +18 encontrada com **${titulo}**.\nUse \`/assinar18 listar\` para ver suas assinaturas.`);
    return;
  }

  await db.delete(assinaturasTable).where(eq(assinaturasTable.id, subs[0].id));
  await interaction.editReply(`✅ Assinatura +18 de **${subs[0].title}** cancelada.`);
}

async function handleListar(interaction: ChatInputCommandInteraction) {
  if (!interaction.guildId) {
    await interaction.reply({ content: "❌ Este comando só pode ser usado em servidores.", ephemeral: true });
    return;
  }
  await interaction.deferReply({ ephemeral: true });

  const subs = await db
    .select()
    .from(assinaturasTable)
    .where(and(
      eq(assinaturasTable.discordUserId, interaction.user.id),
      eq(assinaturasTable.guildId, interaction.guildId),
      eq(assinaturasTable.adult, true),
    ))
    .orderBy(assinaturasTable.addedAt);

  if (!subs.length) {
    await interaction.editReply({
      content: "📭 Você não tem assinaturas +18 neste servidor.\nUse `/assinar18 adicionar` para começar!",
    });
    return;
  }

  const tipoIcon: Record<string, string> = { anime: "🎬", manga: "🇯🇵", manhwa: "🇰🇷" };
  const lines = subs.map((s, i) =>
    `**${i + 1}.** 🔞 ${tipoIcon[s.tipo] ?? "📖"} [${s.title}](${s.siteUrl})`
  );

  const embed = new EmbedBuilder()
    .setTitle(`🔔 Suas Assinaturas +18 — ${interaction.user.displayName}`)
    .setDescription(lines.join("\n"))
    .setColor(0xe74c3c)
    .setFooter({ text: `${subs.length} assinatura(s) +18 • Você será mencionado quando saírem novos conteúdos` });

  await interaction.editReply({ embeds: [embed] });
}
