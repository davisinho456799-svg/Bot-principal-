import { type ChatInputCommandInteraction, SlashCommandBuilder } from "discord.js";
import {
  buildCalendarPanel, isAdultCalendarChannel, type CalendarPeriod,
} from "../calendar-panel.js";

export const data = new SlashCommandBuilder()
  .setName("calendario18")
  .setDescription("+18 — Painel permanente de anime, manhwa, manga e visual novels")
  .setNSFW(true)
  .addStringOption((option) =>
    option.setName("periodo")
      .setDescription("Período dos próximos episódios de anime, calculado a cada consulta")
      .addChoices(
        { name: "Todos em lançamento", value: "todos" },
        { name: "Hoje", value: "hoje" },
        { name: "Amanhã", value: "amanha" },
        { name: "Esta semana", value: "semana" },
        { name: "Este mês", value: "mes" },
      ),
  )
  // Keep the existing option compatible with registered Discord commands.
  .addStringOption((option) =>
    option.setName("aba").setDescription("Categoria destacada no painel")
      .addChoices(
        { name: "Anime", value: "anime" },
        { name: "Manhwa", value: "manhwa" },
        { name: "Manga", value: "manga" },
        { name: "Visual Novel", value: "vn" },
      ),
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  if (!isAdultCalendarChannel(interaction)) {
    await interaction.reply({
      content: "O calendário +18 só pode ser usado em canais marcados como NSFW.",
      ephemeral: true,
    });
    return;
  }
  const period = (interaction.options.getString("periodo") ?? "todos") as CalendarPeriod;
  await interaction.reply(buildCalendarPanel(true, period, interaction.options.getString("aba")));
}
