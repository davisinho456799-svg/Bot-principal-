/**
 * Comando /identificar — identifica uma cena ou imagem de anime/manga.
 *
 * Pipeline de fallback:
 *   1. Trace.moe   → screenshot com timestamp (melhor para cenas de anime)
 *   2. SauceNAO    → identificação genérica de arte/cena
 *   3. OCR + APIs  → extrai texto da imagem e pesquisa em AniList, MAL, Kitsu, AniDB, TMDB
 */

import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  EmbedBuilder,
} from "discord.js";
import { identifyImage, formatTimestamp, type IdentificationResult } from "../identificar-engine.js";

// ─── Definição do comando ─────────────────────────────────────────────────────

export const data = new SlashCommandBuilder()
  .setName("identificar")
  .setDescription("Identifica de qual anime/manga é uma cena ou imagem")
  .addAttachmentOption((opt) =>
    opt
      .setName("imagem")
      .setDescription("Imagem, screenshot ou arte para identificar")
      .setRequired(false)
  )
  .addStringOption((opt) =>
    opt
      .setName("url")
      .setDescription("URL pública da imagem (alternativa ao anexo)")
      .setRequired(false)
  );

// ─── Labels e cores ───────────────────────────────────────────────────────────

const METHOD_LABELS: Record<string, string> = {
  tracemoe: "✅ Encontrado pelo Trace.moe",
  saucenao: "✅ Encontrado pelo SauceNAO",
  ocr:      "✅ Encontrado via OCR + pesquisa nas APIs",
};

const METHOD_ICONS: Record<string, string> = {
  tracemoe: "🎬",
  saucenao: "🔍",
  ocr:      "📝",
};

function confidenceColor(confidence: number, isHighConfidence: boolean): number {
  if (!isHighConfidence) return 0x95a5a6;          // cinza — incerto
  if (confidence >= 0.95) return 0x57f287;         // verde
  if (confidence >= 0.90) return 0xfee75c;         // amarelo
  return 0xffa500;                                  // laranja
}

function confidenceEmoji(confidence: number, isHighConfidence: boolean): string {
  if (!isHighConfidence) return "⚠️";
  if (confidence >= 0.95) return "🟢";
  if (confidence >= 0.90) return "🟡";
  return "🟠";
}

function formatConfidence(result: IdentificationResult): string {
  const pct = Math.round(result.confidence * 100);
  const emoji = confidenceEmoji(result.confidence, result.isHighConfidence);
  if (result.method === "ocr") return `${emoji} **${pct}%** (correspondência de texto)`;
  return `${emoji} **${pct}%**`;
}

// ─── Construção do embed ──────────────────────────────────────────────────────

function buildEmbed(result: IdentificationResult): EmbedBuilder {
  const icon = METHOD_ICONS[result.method] ?? "🔍";
  const methodLabel = METHOD_LABELS[result.method] ?? result.method;

  // Título principal
  const titleLine = result.titleNative
    ? `${result.title}\n*${result.titleNative}*`
    : result.title;

  const embed = new EmbedBuilder()
    .setTitle(`${icon} ${result.title}`)
    .setColor(confidenceColor(result.confidence, result.isHighConfidence))
    .setFooter({ text: methodLabel });

  // Descrição: nome native + romaji + sinopse
  const descParts: string[] = [];
  if (result.titleNative && result.titleNative !== result.title)
    descParts.push(`*${result.titleNative}*`);
  if (result.titleRomaji && result.titleRomaji !== result.title && result.titleRomaji !== result.titleNative)
    descParts.push(`*${result.titleRomaji}*`);
  if (result.synopsis) {
    const truncated = result.synopsis.length > 300
      ? result.synopsis.slice(0, 300).trimEnd() + "…"
      : result.synopsis;
    descParts.push(`\n${truncated}`);
  }
  if (descParts.length) embed.setDescription(descParts.join("\n"));

  // Thumbnail ou preview
  if (result.previewImageUrl) embed.setThumbnail(result.previewImageUrl);

  // ── Campos ────────────────────────────────────────────────────────────────

  // Similaridade / confiança
  embed.addFields({
    name: result.method === "ocr" ? "Correspondência" : "Similaridade",
    value: formatConfidence(result),
    inline: true,
  });

  // Tipo de mídia
  if (result.mediaType) {
    embed.addFields({ name: "Tipo", value: result.mediaType, inline: true });
  }

  // Episódio (Trace.moe / SauceNAO)
  if (result.episode) {
    embed.addFields({
      name: "Episódio",
      value: `Ep. ${result.episode}`,
      inline: true,
    });
  }

  // Timestamp (Trace.moe)
  if (result.timestampFrom !== null && result.timestampTo !== null) {
    embed.addFields({
      name: "Timestamp",
      value: `${formatTimestamp(result.timestampFrom)} – ${formatTimestamp(result.timestampTo)}`,
      inline: true,
    });
  }

  // Aviso de baixa confiança
  if (!result.isHighConfidence) {
    embed.addFields({
      name: "⚠️ Baixa confiança",
      value:
        "Este resultado pode não ser preciso. Tente com uma imagem mais nítida ou um screenshot direto do anime.",
      inline: false,
    });
  }

  // Aviso de conteúdo adulto
  if (result.isAdult) {
    embed.addFields({
      name: "⚠️ Aviso",
      value: "Este conteúdo é classificado como adulto (+18).",
      inline: false,
    });
  }

  // Links
  if (result.links.length) {
    const linkLine = result.links.map((l) => `[${l.label}](${l.url})`).join(" • ");
    embed.addFields({ name: "🔗 Links", value: linkLine, inline: false });
  }

  // Clipe Trace.moe
  if (result.previewVideoUrl) {
    embed.addFields({
      name: "🎬 Cena identificada",
      value: `[Ver clipe no Trace.moe](${result.previewVideoUrl})`,
      inline: false,
    });
  }

  // Texto OCR extraído
  if (result.ocrText) {
    const ocrDisplay =
      result.ocrText.length > 200
        ? result.ocrText.slice(0, 200).trimEnd() + "…"
        : result.ocrText;
    embed.addFields({
      name: "📝 Texto detectado na imagem",
      value: `\`\`\`${ocrDisplay}\`\`\``,
      inline: false,
    });
  }

  return embed;
}

// ─── Execute ──────────────────────────────────────────────────────────────────

export async function execute(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  const attachment = interaction.options.getAttachment("imagem");
  const urlOption  = interaction.options.getString("url");

  if (!attachment && !urlOption) {
    await interaction.reply({
      content: "❌ Envie uma **imagem** ou informe uma **URL** para identificar.",
      ephemeral: true,
    });
    return;
  }

  if (urlOption && !urlOption.startsWith("http")) {
    await interaction.reply({
      content: "❌ URL inválida. Use `http://` ou `https://`.",
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply();

  // Atualiza o status enquanto processa (informa o pipeline ao usuário)
  await interaction.editReply(
    "🔍 Analisando imagem com Trace.moe…"
  );

  const imageUrl    = (attachment?.url ?? urlOption)!;
  const isAttachment = !!attachment;

  try {
    const result = await identifyImage(imageUrl, isAttachment);

    if (!result) {
      await interaction.editReply(
        "❌ Nenhuma obra identificada com os métodos disponíveis.\n" +
          "💡 Dicas:\n" +
          "• Use screenshots nítidos, sem filtros ou textos sobrepostos\n" +
          "• Para anime, prefira capturas diretas do episódio\n" +
          "• Tente com outra cena ou frame diferente"
      );
      return;
    }

    const embed = buildEmbed(result);
    await interaction.editReply({ content: null, embeds: [embed] });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Erro desconhecido";
    await interaction.editReply(
      `❌ Erro ao processar a imagem: ${msg}\nTente novamente em alguns instantes.`
    );
  }
}
