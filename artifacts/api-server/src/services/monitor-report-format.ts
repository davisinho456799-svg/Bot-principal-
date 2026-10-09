import { EmbedBuilder } from "discord.js";

export const REPORT_INTERVAL_MS = 24 * 60 * 60 * 1000;
export interface ReportSection {
  available: boolean;
  works: number;
  messages: number;
  latestCheck: Date | null;
  latestDelivery: Date | null;
  pending: number;
  errors: number;
  latestError: Date | null;
  failedWorks: number;
  textOnly?: number;
}
export interface MonitorReportData {
  now: Date;
  image: ReportSection;
  embed: ReportSection;
}
const time = (value: Date | null) => value
  ? `<t:${Math.floor(new Date(value).getTime() / 1000)}:F> (<t:${Math.floor(new Date(value).getTime() / 1000)}:R>)`
  : "Sem registro";
function section(data: ReportSection, image: boolean, now: Date): string {
  if (!data.available) return "Não configurado neste servidor; dados de outros servidores não são exibidos.";
  const late = data.works > 0 && (!data.latestCheck ||
    now.getTime() - new Date(data.latestCheck).getTime() > (image ? 2 : 26) * 60 * 60 * 1000);
  return [
    `Obras acompanhadas: **${data.works}**`,
    `Mensagens confirmadas nas últimas 24h: **${data.messages}**`,
    `Último envio confirmado: ${time(data.latestDelivery)}`,
    `Última checagem de obra: ${time(data.latestCheck)}`,
    `${image ? "Capítulos pendentes" : "Avisos sem confirmação de envio"}: **${data.pending}**`,
    `Falhas registradas nas últimas 24h: **${data.errors}**`,
    ...(data.latestError ? [`Última falha registrada: ${time(data.latestError)}`] : []),
    ...(image ? [`Obras com falha na última checagem: **${data.failedWorks}**`,
      `Avisos enviados sem imagem nas últimas 24h: **${data.textOnly ?? 0}**`] : []),
    ...(late ? ["Atenção: há obras acompanhadas, mas a última checagem está ausente ou antiga."] : []),
  ].join("\n");
}
export function formatMonitorReport(data: MonitorReportData) {
  return new EmbedBuilder().setTitle("Resumo dos monitores — últimas 24 horas")
    .setColor(data.image.errors || data.embed.errors || data.image.failedWorks ? 0xf59e0b : 0x06b6d4)
    .setDescription("Consulta do histórico salvo. Não executa verificações nem envia avisos de lançamentos.")
    .addFields(
      { name: "Monitor por imagem", value: section(data.image, true, data.now) },
      { name: "Monitor por embed", value: section(data.embed, false, data.now) },
    )
    .setTimestamp(data.now)
    .setFooter({ text: "Sem títulos ou dados pessoais • Horários no seu fuso • Offline completo exige monitor externo" });
}
