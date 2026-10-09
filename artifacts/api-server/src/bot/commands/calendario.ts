import { type ChatInputCommandInteraction, SlashCommandBuilder } from "discord.js";
import { buildCalendarPanel, type CalendarPeriod } from "../calendar-panel.js";

export const data = new SlashCommandBuilder()
  .setName("calendario")
  .setDescription("Painel permanente de anime, manhwa, manga e visual novels")
  .addStringOption((option) =>
    option.setName("periodo")
      .setDescription("Período dos episódios de anime, calculado a cada consulta")
      .addChoices(
        { name: "Hoje", value: "hoje" },
        { name: "Amanhã", value: "amanha" },
        { name: "Esta semana (7 dias)", value: "semana" },
        { name: "Este mês", value: "mes" },
      ),
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const period = (interaction.options.getString("periodo") ?? "hoje") as CalendarPeriod;
  await interaction.reply(buildCalendarPanel(false, period));
}
