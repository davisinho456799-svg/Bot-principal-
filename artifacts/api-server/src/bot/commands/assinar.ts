import {
  ChatInputCommandInteraction,
  AutocompleteInteraction,
  SlashCommandBuilder,
  EmbedBuilder,
  TextChannel,
} from "discord.js";
import { db, assinaturasTable, notificacaoCanaisTable } from "@workspace/db";
import { eq, and, ilike } from "drizzle-orm";
import { getUnifiedById, getUnifiedAnimeById } from "../unified.js";
import {
  respondAutocomplete,
  respondAutocompleteAnime,
  respondAutocompleteVN,
  respondAutocompleteVN18,
  respondAutocompleteEroge,
} from "../autocomplete.js";
import { logger } from "../../lib/logger.js";
import { recordBotError } from "../error-log.js";

export const data = new SlashCommandBuilder()
  .setName("assinar")
  .setDescription("Receba uma menção quando novos episódios/capítulos de um anime ou manhwa saírem")
  .addSubcommand((sub) =>
    sub
      .setName("adicionar")
      .setDescription("Inscreva-se para receber notificações de um título")
      .addStringOption((opt) =>
        opt
          .setName("tipo")
          .setDescription("Tipo do título")
          .setRequired(true)
          .addChoices(
            { name: "📺 Anime",    value: "anime"   },
            { name: "🇯🇵 Manga",   value: "manga"   },
            { name: "🇰🇷 Manhwa",  value: "manhwa"  },
            { name: "📖 VN",      value: "vn"      },
            { name: "🔞 VN +18",  value: "vn18"    },
            { name: "🔞 Eroge",   value: "eroge"   },
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
      .setDescription("Cancele sua inscrição de notificações de um título")
      .addStringOption((opt) =>
        opt
          .setName("titulo")
          .setDescription("Nome ou parte do título da assinatura a cancelar")
          .setRequired(true)
      )
  )
  .addSubcommand((sub) =>
    sub.setName("listar").setDescription("Veja todos os títulos que você está assinando")
  );

export async function autocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const tipo    = interaction.options.getString("tipo") ?? "manhwa";
  const focused = interaction.options.getFocused();
  if (tipo === "anime") {
    await respondAutocompleteAnime(interaction, focused);
  } else if (tipo === "vn") {
    await respondAutocompleteVN(interaction, focused);
  } else if (tipo === "vn18") {
    await respondAutocompleteVN18(interaction, focused);
  } else if (tipo === "eroge") {
    await respondAutocompleteEroge(interaction, focused);
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

  // IMPORTANTE: não usar required=true aqui. O Discord pode demorar até 1h
  // para propagar a nova definição do comando globalmente. Se o usuário usar
  // o comando com o cache antigo (sem o campo "tipo"), getString com required=true
  // lança TypeError e o bot mostra a mensagem de erro genérica.
  // Por isso usamos fallback "manhwa" para manter compatibilidade durante a transição.
  const tipo   = (interaction.options.getString("tipo") ?? "manhwa") as "anime" | "manga" | "manhwa" | "vn" | "vn18" | "eroge";
  const titulo = interaction.options.getString("titulo", true);

  // Conteúdo adulto só pode ser assinado em canais NSFW
  const isAdult = tipo === "vn18" || tipo === "eroge";
  if (isAdult) {
    const channel = interaction.channel;
    const isNsfw  = channel && "nsfw" in channel && (channel as TextChannel).nsfw;
    if (!isNsfw) {
      await interaction.reply({
        content: "🔞 Conteúdo adulto só pode ser assinado em canais marcados como **NSFW**.\nAtive o modo NSFW no canal nas configurações do servidor e tente novamente.",
        ephemeral: true,
      });
      return;
    }
  }

  await interaction.deferReply({ ephemeral: true });

  const userId  = interaction.user.id;
  const guildId = interaction.guildId;

  // Só aceita valores vindos do autocomplete no formato "source:id"
  if (!/^(anilist|anilist-anime|comick|mangadex|mangaupdates|jikan|vndb|erogamescape):[^\s]+$/.test(titulo)) {
    await interaction.editReply("❌ Por favor, selecione um título da lista de sugestões ao digitar.");
    return;
  }

  const [src, ...idParts] = titulo.split(":");
  const id = idParts.join(":");

  let result;
  try {
    result = src === "anilist-anime"
      ? await getUnifiedAnimeById("anilist-anime", id)
      : await getUnifiedById(
          src as "anilist" | "mangadex" | "comick" | "mangaupdates" | "jikan" | "vndb" | "erogamescape",
          id
        );
  } catch (err) {
    logger.error({ err, src, id }, "Erro ao buscar título externo em /assinar adicionar");
    void recordBotError({
      source: "command",
      errorCode: "SUBSCRIPTION_EXTERNAL_LOOKUP_FAILED",
      error: err,
      discordGuildId: guildId,
      discordUserId: userId,
      command: "assinar adicionar",
      context: { source: src },
    });
    await interaction.editReply("❌ Erro ao consultar a fonte externa. Tente novamente em alguns instantes.");
    return;
  }

  if (!result) {
    await interaction.editReply("❌ Não foi possível buscar as informações desse título. Tente novamente.");
    return;
  }

  const { id: manhwaId, source, mainTitle: title, coverUrl, siteUrl } = result;

  let existing;
  try {
    existing = await db
      .select({ id: assinaturasTable.id })
      .from(assinaturasTable)
      .where(and(
        eq(assinaturasTable.discordUserId, userId),
        eq(assinaturasTable.manhwaId, manhwaId),
        eq(assinaturasTable.guildId, guildId),
      ));
  } catch (err) {
    logger.error({ err }, "Erro de DB ao verificar assinatura existente em /assinar adicionar");
    void recordBotError({
      source: "database",
      errorCode: "SUBSCRIPTION_LOOKUP_FAILED",
      error: err,
      discordGuildId: guildId,
      discordUserId: userId,
      command: "assinar adicionar",
    });
    await interaction.editReply("❌ Erro ao acessar o banco de dados. Tente novamente.");
    return;
  }

  if (existing.length) {
    await interaction.editReply(`⚠️ Você já está assinando **${title}** neste servidor!`);
    return;
  }

  try {
    await db.insert(assinaturasTable).values({
      discordUserId: userId,
      guildId,
      manhwaId,
      source,
      title,
      coverUrl: coverUrl ?? null,
      siteUrl,
      tipo: isAdult ? "vn" : tipo,   // normaliza vn18/eroge → "vn" no campo tipo (compatibilidade)
      adult: isAdult,
    });
  } catch (err) {
    logger.error({ err }, "Erro de DB ao inserir assinatura em /assinar adicionar");
    void recordBotError({
      source: "database",
      errorCode: "SUBSCRIPTION_INSERT_FAILED",
      error: err,
      discordGuildId: guildId,
      discordUserId: userId,
      command: "assinar adicionar",
    });
    await interaction.editReply("❌ Erro ao salvar a assinatura. Tente novamente.");
    return;
  }

  const tipoLabel: Record<string, string> = {
    anime:  "📺 episódios",
    manga:  "🇯🇵 capítulos",
    manhwa: "🇰🇷 capítulos",
    vn:     "📖 novas releases",
    vn18:   "🔞 novas releases (+18)",
    eroge:  "🔞 novas releases (+18)",
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
    .setTitle("🔔 Assinatura Confirmada!")
    .setColor(isAdult ? 0xe74c3c : 0x2ecc71)
    .setDescription(
      `Você será **mencionado** neste servidor quando saírem novos ${tipoLabel[tipo] ?? "capítulos"} de:\n\n` +
      `📖 **[${title}](${siteUrl})**\n\n` +
      `> ✅ Verificações automáticas a cada **2 horas**.\n` +
      `> 📋 \`/assinar listar\` para ver suas assinaturas.\n` +
      `> ❌ \`/assinar remover\` para cancelar.` +
      avisoCanal
    )
    .setFooter({ text: "Notificações automáticas • Bot de Manga/Anime" });

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

  let subs;
  try {
    // Busca em todas as assinaturas (SFW e adulto) para que o usuário
    // consiga remover qualquer título independente do tipo
    subs = await db
      .select()
      .from(assinaturasTable)
      .where(and(
        eq(assinaturasTable.discordUserId, userId),
        eq(assinaturasTable.guildId, guildId),
        ilike(assinaturasTable.title, `%${titulo}%`),
      ));
  } catch (err) {
    logger.error({ err }, "Erro de DB em /assinar remover");
    void recordBotError({
      source: "database",
      errorCode: "SUBSCRIPTION_LIST_FAILED",
      error: err,
      discordGuildId: guildId,
      discordUserId: userId,
      command: "assinar remover",
    });
    await interaction.editReply("❌ Erro ao acessar o banco de dados. Tente novamente.");
    return;
  }

  if (!subs.length) {
    await interaction.editReply(
      `❌ Nenhuma assinatura encontrada com **${titulo}**.\nUse \`/assinar listar\` para ver suas assinaturas.`
    );
    return;
  }

  await db.delete(assinaturasTable).where(eq(assinaturasTable.id, subs[0].id));
  await interaction.editReply(`✅ Assinatura de **${subs[0].title}** cancelada.`);
}

async function handleListar(interaction: ChatInputCommandInteraction) {
  if (!interaction.guildId) {
    await interaction.reply({ content: "❌ Este comando só pode ser usado em servidores.", ephemeral: true });
    return;
  }
  await interaction.deferReply({ ephemeral: true });

  let subs;
  try {
    subs = await db
      .select()
      .from(assinaturasTable)
      .where(and(
        eq(assinaturasTable.discordUserId, interaction.user.id),
        eq(assinaturasTable.guildId, interaction.guildId!),
      ))
      .orderBy(assinaturasTable.addedAt);
  } catch (err) {
    logger.error({ err }, "Erro de DB em /assinar listar");
    void recordBotError({
      source: "database",
      errorCode: "SUBSCRIPTION_LIST_FAILED",
      error: err,
      discordGuildId: interaction.guildId,
      discordUserId: interaction.user.id,
      command: "assinar listar",
    });
    await interaction.editReply("❌ Erro ao acessar o banco de dados. Tente novamente.");
    return;
  }

  if (!subs.length) {
    await interaction.editReply({
      content: "📭 Você não tem assinaturas neste servidor.\nUse `/assinar adicionar` para começar!",
    });
    return;
  }

  const tipoIcon: Record<string, string> = {
    anime:  "📺",
    manga:  "🇯🇵",
    manhwa: "🇰🇷",
    vn:     "📖",
  };

  const sfwSubs   = subs.filter((s) => !s.adult);
  const adultSubs = subs.filter((s) => s.adult);

  const sfwLines   = sfwSubs.map((s, i) =>
    `**${i + 1}.** ${tipoIcon[s.tipo] ?? "📖"} [${s.title}](${s.siteUrl})`
  );
  const adultLines = adultSubs.map((s, i) =>
    `**${i + 1}.** 🔞 [${s.title}](${s.siteUrl})`
  );

  const embed = new EmbedBuilder()
    .setTitle(`🔔 Suas Assinaturas — ${interaction.user.displayName}`)
    .setColor(0x3498db)
    .setFooter({
      text: `${subs.length} assinatura(s) • Você será mencionado quando saírem novos conteúdos`,
    });

  if (sfwLines.length) {
    embed.addFields({ name: "📚 Títulos", value: sfwLines.join("\n").slice(0, 1024), inline: false });
  }
  if (adultLines.length) {
    embed.addFields({ name: "🔞 Conteúdo Adulto", value: adultLines.join("\n").slice(0, 1024), inline: false });
  }

  await interaction.editReply({ embeds: [embed] });
}
