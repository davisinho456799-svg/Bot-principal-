import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, StringSelectMenuBuilder,
  type ButtonInteraction, type StringSelectMenuInteraction, type ChatInputCommandInteraction,
} from "discord.js";
import { db, assinaturasTable } from "@workspace/db";
import { getUnifiedAnimeById, getUnifiedById } from "./unified.js";
import { loadCalendarEntries, type CalendarEntry } from "./calendar-data.js";
import { logger } from "../lib/logger.js";

export type CalendarTab = "anime" | "manhwa" | "manga" | "vn";
export type CalendarPeriod = "hoje" | "amanha" | "semana" | "mes" | "todos";
type CalendarAction = "open" | "page" | "subscribe";
interface CalendarState {
  adult: boolean;
  tab: CalendarTab;
  period: CalendarPeriod;
  page: number;
  action: CalendarAction;
}
const TABS: { id: CalendarTab; label: string }[] = [
  { id: "anime", label: "Anime" }, { id: "manhwa", label: "Manhwa" },
  { id: "manga", label: "Manga" }, { id: "vn", label: "Visual Novel" },
];
const PERIODS: Record<CalendarPeriod, string> = {
  hoje: "Hoje", amanha: "Amanhã", semana: "Próximos 7 dias", mes: "Este mês", todos: "Em lançamento",
};
const PREFIX = "calendar:v1:";
const MAX_PAGE = 100;

export function calendarCustomId(state: CalendarState): string {
  return `${PREFIX}${state.adult ? "adult" : "normal"}:${state.tab}:${state.period}:${state.page}:${state.action}`;
}

export function parseCalendarCustomId(id: string): CalendarState | null {
  const match = /^calendar:v1:(adult|normal):(anime|manhwa|manga|vn):(hoje|amanha|semana|mes|todos):(\d{1,3}):(open|page|subscribe)$/.exec(id);
  if (!match || Number(match[4]) > MAX_PAGE || (match[1] === "normal" && match[3] === "todos")) return null;
  return {
    adult: match[1] === "adult", tab: match[2] as CalendarTab,
    period: match[3] as CalendarPeriod, page: Number(match[4]),
    action: match[5] as CalendarAction,
  };
}

export function isAdultCalendarChannel(
  interaction: Pick<ChatInputCommandInteraction, "channel" | "guildId">,
): boolean {
  const channel = interaction.channel;
  if (!interaction.guildId || !channel) return false;
  if ("nsfw" in channel) return channel.nsfw === true;
  if (channel.isThread()) return channel.parent !== null &&
    "nsfw" in channel.parent && channel.parent.nsfw === true;
  return false;
}

function tabRow(adult: boolean, period: CalendarPeriod, active?: string | null) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(TABS.map((tab) =>
    new ButtonBuilder().setCustomId(calendarCustomId({
      adult, period, tab: tab.id, page: 0, action: "open",
    })).setLabel(tab.label).setStyle(active === tab.id ? ButtonStyle.Primary : ButtonStyle.Secondary),
  ));
}

export function buildCalendarPanel(adult: boolean, period: CalendarPeriod, active?: string | null) {
  return {
    embeds: [new EmbedBuilder()
      .setTitle(adult ? "Calendário +18" : "Calendário de lançamentos")
      .setColor(adult ? 0xc0392b : 0x02a9ff)
      .setDescription(
        "Escolha uma categoria nos botões abaixo.\n\n" +
        "Os resultados aparecem só para você, sem alterar este painel.\n" +
        `Período de anime: **${PERIODS[period]}**, calculado no momento do clique.\n` +
        "Manga e manhwa: séries em lançamento. Visual novels: lançamentos recentes e próximos." +
        (adult ? "\n\nConteúdo +18. Disponível apenas em canais NSFW." : ""),
      )
      .setFooter({ text: "Painel sem prazo de interação • Consulte novamente quando quiser" })],
    components: [tabRow(adult, period, active)],
  };
}

function escapeTitle(text: string) {
  return text.replace(/[\n\r]/g, " ").replace(/([\\[\]*_`])/g, "\\$1").slice(0, 120);
}

function entryLine(entry: CalendarEntry, index: number) {
  return `**${index + 1}.** [${escapeTitle(entry.title)}](${entry.siteUrl})\n> ${entry.details.replace(/[\n\r]/g, " ").slice(0, 180)}`;
}

// Respect the embed limit without truncating away titles offered in the select.
function resultPages(entries: CalendarEntry[]) {
  const pages: CalendarEntry[][] = [[]];
  let length = 0;
  for (const [index, entry] of entries.entries()) {
    const size = entryLine(entry, index).length + 2;
    if (pages.at(-1)!.length >= 10 || (length + size > 3500 && pages.at(-1)!.length)) {
      pages.push([]);
      length = 0;
    }
    pages.at(-1)!.push(entry);
    length += size;
  }
  return pages;
}

export function buildCalendarResults(state: CalendarState, entries: CalendarEntry[]) {
  const pages = resultPages(entries);
  const page = Math.min(state.page, pages.length - 1);
  const slice = pages[page];
  const offset = pages.slice(0, page).reduce((sum, rows) => sum + rows.length, 0);
  const label = TABS.find((tab) => tab.id === state.tab)!.label;
  const scope = state.tab === "anime" ? PERIODS[state.period]
    : state.tab === "vn" ? "Últimos 2 meses e próximo mês" : "Séries em lançamento";
  const embed = new EmbedBuilder()
    .setTitle(`${state.adult ? "Calendário +18" : "Calendário"} — ${label}`)
    .setColor(state.adult ? 0xc0392b : 0x02a9ff)
    .setDescription(
      `**${scope}**\n\n` +
      (slice.length ? slice.map((entry, index) => entryLine(entry, offset + index)).join("\n\n")
        : "Nenhum resultado encontrado nesta categoria para o período. Você pode consultar novamente pelo painel."),
    )
    .setFooter({ text: `Página ${page + 1}/${pages.length} • ${entries.length} resultado(s) • Horários de Brasília • AniList/Tenrai/VNDB` })
    .setTimestamp();
  const components: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] = [
    tabRow(state.adult, state.period, state.tab),
  ];
  if (pages.length > 1) {
    components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setLabel("Anterior").setStyle(ButtonStyle.Secondary)
        .setDisabled(page === 0).setCustomId(calendarCustomId({ ...state, page: Math.max(0, page - 1), action: "page" })),
      new ButtonBuilder().setLabel(`${page + 1}/${pages.length}`).setStyle(ButtonStyle.Secondary)
        .setDisabled(true).setCustomId(calendarCustomId({ ...state, page, action: "page" })),
      new ButtonBuilder().setLabel("Próxima").setStyle(ButtonStyle.Secondary)
        .setDisabled(page === pages.length - 1).setCustomId(calendarCustomId({ ...state, page: page + 1, action: "page" })),
    ));
  }
  if (state.tab !== "vn" && slice.length) {
    const options = new Map(slice.map((entry) => [
      `${entry.source}:${entry.id}`,
      { label: entry.title.slice(0, 100) || "Sem título", value: `${entry.source}:${entry.id}` },
    ]));
    components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder().setCustomId(calendarCustomId({ ...state, page, action: "subscribe" }))
        .setPlaceholder("Assinar um título desta página").addOptions([...options.values()]),
    ));
  }
  return { embeds: [embed], components };
}

async function subscribe(interaction: StringSelectMenuInteraction, state: CalendarState) {
  if (!interaction.guildId || state.tab === "vn") throw new Error("Calendar subscription invalid category");
  const selected = interaction.values[0];
  const allowed = interaction.message.components.some((row) =>
    "components" in row && row.components.some((component) => "customId" in component &&
      component.customId === interaction.customId && "options" in component &&
      component.options.some((option) => option.value === selected)),
  );
  const match = /^(anilist-anime|anilist|tenrai):(\d+)$/.exec(selected ?? "");
  if (!allowed || !match || (match[1] === "anilist-anime" && state.tab !== "anime") ||
      (match[1] === "anilist" && state.tab === "anime")) {
    throw new Error("Calendar subscription invalid selection");
  }
  const source = match[1] as "anilist-anime" | "anilist" | "tenrai";
  const id = match[2];
  const entry = state.tab === "anime"
    ? await getUnifiedAnimeById(source as "anilist-anime" | "tenrai", id)
    : await getUnifiedById(source as "anilist" | "tenrai", id);
  if (!entry) throw new Error("Calendar subscription title unavailable");
  // The existing database unique key also prevents simultaneous duplicate clicks.
  const inserted = await db.insert(assinaturasTable).values({
    discordUserId: interaction.user.id, guildId: interaction.guildId,
    manhwaId: id, source, title: entry.mainTitle, coverUrl: entry.coverUrl ?? null,
    siteUrl: entry.siteUrl, tipo: state.tab, adult: state.adult,
  }).onConflictDoNothing().returning({ id: assinaturasTable.id });
  await interaction.editReply({
    content: inserted.length
      ? `Assinatura${state.adult ? " +18" : ""} confirmada para **${escapeTitle(entry.mainTitle)}**. Você será mencionado quando houver novos conteúdos.`
      : `Você já tem uma assinatura com este identificador neste servidor. Consulte \`/assinar listar\` ou \`/assinar18 listar\` para conferir.`,
  });
}

export async function handleCalendarComponent(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
): Promise<boolean> {
  if (!interaction.customId.startsWith(PREFIX)) return false;
  const state = parseCalendarCustomId(interaction.customId);
  if (!state || (state.action === "subscribe") !== interaction.isStringSelectMenu()) {
    await interaction.reply({ content: "Esta opção de calendário é inválida.", ephemeral: true });
    return true;
  }
  if (state.adult && !isAdultCalendarChannel(interaction)) {
    await interaction.reply({
      content: "O calendário +18 só pode ser usado em canais marcados como NSFW.", ephemeral: true,
    });
    return true;
  }
  try {
    // Acknowledge before any provider/database work. Each click has a fresh token.
    if (state.action === "page") await interaction.deferUpdate();
    else await interaction.deferReply({ ephemeral: true });
    if (interaction.isStringSelectMenu()) {
      await subscribe(interaction, state);
    } else {
      const entries = await loadCalendarEntries(state.adult, state.tab, state.period);
      await interaction.editReply(buildCalendarResults(state, entries));
    }
  } catch (err) {
    logger.error({ err, customId: interaction.customId }, "Falha na interação do calendário");
    const content = "Não foi possível carregar esta opção agora. Tente novamente pelo painel; os botões continuam disponíveis.";
    if (interaction.deferred || interaction.replied) {
      if (state.action === "page") await interaction.followUp({ content, ephemeral: true }).catch(() => null);
      else await interaction.editReply({ content }).catch(() => null);
    } else await interaction.reply({ content, ephemeral: true }).catch(() => null);
  }
  return true;
}
