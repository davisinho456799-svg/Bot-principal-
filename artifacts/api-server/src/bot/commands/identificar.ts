/**
 * Comando /identificar — identifica uma cena de anime a partir de uma imagem.
 * Fonte: Trace.moe
 */

import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  EmbedBuilder,
} from "discord.js";
import { searchByImageUrl, searchByImageUpload, formatTimestamp } from "../tracemoe.js";

export const data = new SlashCommandBuilder()
  .setName("identificar")
  .setDescription("Identifica de qual anime é uma cena a partir de uma imagem")
  .addAttachmentOption((opt) =>
    opt
      .setName("imagem")
      .setDescription("Imagem ou screenshot da cena do anime")
      .setRequired(false)
  )
  .addStringOption((opt) =>
    opt
      .setName("url")
      .setDescription("URL pública da imagem (se não tiver o arquivo)")
      .setRequired(false)
  );

export async function execute(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  const attachment = interaction.options.getAttachment("imagem");
  const urlOption = interaction.options.getString("url");

  if (!attachment && !urlOption) {
    await interaction.reply({
      content:
        "❌ Envie uma **imagem** ou informe uma **URL** para identificar a cena.",
      ephemeral: true,
    });
    return;
  }

  // Valida URL mínima
  if (urlOption && !urlOption.startsWith("http")) {
    await interaction.reply({
      content: "❌ URL inválida. Use `http://` ou `https://`.",
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply();

  try {
    // Anexos: upload multipart direto (mais confiável que URL do Discord)
    // URL externa: passa a URL diretamente
    const results = attachment
      ? await searchByImageUpload(attachment.url)
      : await searchByImageUrl(urlOption!);

    if (!results.length) {
      await interaction.editReply(
        "❌ Nenhum anime identificado com similaridade suficiente.\n" +
          "💡 Dica: use imagens nítidas, sem filtros, de preferência screenshots diretos do anime."
      );
      return;
    }

    const top = results[0]!;
    const similarity = Math.round(top.similarity * 100);

    const simEmoji =
      similarity >= 95 ? "🟢" : similarity >= 85 ? "🟡" : "🟠";
    const timeFrom = formatTimestamp(top.from);
    const timeTo = formatTimestamp(top.to);

    const embed = new EmbedBuilder()
      .setTitle(`🎯 ${top.title}`)
      .setURL(`https://anilist.co/anime/${top.anilistId}`)
      .setColor(similarity >= 95 ? 0x57f287 : similarity >= 85 ? 0xfee75c : 0xffa500)
      .addFields(
        {
          name: "Similaridade",
          value: `${simEmoji} **${similarity}%**`,
          inline: true,
        },
        {
          name: "Episódio",
          value: top.episode ? `Ep. ${top.episode}` : "Desconhecido",
          inline: true,
        },
        {
          name: "Timestamp",
          value: `${timeFrom} – ${timeTo}`,
          inline: true,
        }
      )
      .setThumbnail(top.imageUrl)
      .setFooter({ text: "🔍 Trace.moe • Identificação por IA" });

    if (top.titleNative) {
      embed.setDescription(`*${top.titleNative}*`);
    }

    if (top.isAdult) {
      embed.addFields({
        name: "⚠️ Aviso",
        value: "Este anime é classificado como conteúdo adulto.",
        inline: false,
      });
    }

    if (results.length > 1) {
      const others = results
        .slice(1)
        .map(
          (r) =>
            `• **${r.title}** — ${Math.round(r.similarity * 100)}% (Ep. ${r.episode ?? "?"})`
        )
        .join("\n");
      embed.addFields({
        name: "Outras possibilidades",
        value: others,
        inline: false,
      });
    }

    embed.addFields({
      name: "🎬 Cena identificada",
      value: `[Ver clipe no Trace.moe](${top.videoUrl})`,
      inline: false,
    });

    await interaction.editReply({ content: null, embeds: [embed] });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Erro desconhecido";
    await interaction.editReply(
      `❌ Erro ao consultar o Trace.moe: ${msg}\nTente novamente em alguns instantes.`
    );
  }
}
