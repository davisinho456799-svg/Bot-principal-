import { pool } from "@workspace/db";
import type { ReportSection, MonitorReportData } from "./monitor-report-format";

export interface ReportConfig {
  guildId: string;
  channelId: string;
  enabled: boolean;
  nextReportAt: Date;
  lastReportAt: Date | null;
  lastError: string | null;
}
const selectConfig = `SELECT guild_id AS "guildId", channel_id AS "channelId", enabled,
  next_report_at AS "nextReportAt", last_report_at AS "lastReportAt", last_error AS "lastError"
  FROM monitor_report_configs`;
export async function getReportConfig(guildId: string): Promise<ReportConfig | undefined> {
  return (await pool.query<ReportConfig>(`${selectConfig} WHERE guild_id=$1`, [guildId])).rows[0];
}
export async function configureReport(guildId: string, channelId: string, enabled: boolean, now = new Date()) {
  const due = new Date(now.getTime() + 86400000);
  await pool.query(`INSERT INTO monitor_report_configs(guild_id,channel_id,enabled,next_report_at)
    VALUES($1,$2,$3,$4) ON CONFLICT(guild_id) DO UPDATE SET channel_id=$2, enabled=$3,
      next_report_at=CASE WHEN $3 THEN $4 ELSE monitor_report_configs.next_report_at END,
      lease_until=NULL, lease_token=NULL, last_error=NULL, updated_at=now()`,
  [guildId, channelId, enabled, due]);
  return getReportConfig(guildId);
}
export async function dueReports(now: Date): Promise<ReportConfig[]> {
  return (await pool.query<ReportConfig>(`${selectConfig} WHERE enabled=true AND next_report_at <= $1
    AND (lease_until IS NULL OR lease_until <= $1) ORDER BY next_report_at LIMIT 50`, [now])).rows;
}
export async function claimReport(config: ReportConfig, token: string, now: Date) {
  const result = await pool.query(`UPDATE monitor_report_configs SET lease_until=$4,lease_token=$5
    WHERE guild_id=$1 AND channel_id=$2 AND enabled=true AND next_report_at=$3
      AND (lease_until IS NULL OR lease_until <= $6)`,
  [config.guildId, config.channelId, config.nextReportAt, new Date(now.getTime() + 300000), token, now]);
  return result.rowCount === 1;
}
export async function completeReport(config: ReportConfig, token: string, messageId: string, now: Date) {
  await pool.query(`UPDATE monitor_report_configs SET last_report_at=$3,last_message_id=$4,
    next_report_at=$5,lease_until=NULL,lease_token=NULL,last_error=NULL,updated_at=now()
    WHERE guild_id=$1 AND lease_token=$2`, [config.guildId, token, now, messageId,
    new Date(now.getTime() + 86400000)]);
}
export async function failReport(config: ReportConfig, token: string, now: Date) {
  await pool.query(`UPDATE monitor_report_configs SET lease_until=$3,lease_token=NULL,
    last_error='Não foi possível enviar ou confirmar o resumo; haverá nova tentativa.',updated_at=now()
    WHERE guild_id=$1 AND lease_token=$2`, [config.guildId, token, new Date(now.getTime() + 900000)]);
}
export async function imageDestination(): Promise<string | null> {
  return (await pool.query<{ channel_id: string | null }>(
    "SELECT discord_channel_id AS channel_id FROM monitor_config ORDER BY id LIMIT 1")).rows[0]?.channel_id ?? null;
}
const empty = (): ReportSection => ({ available: false, works: 0, messages: 0, latestCheck: null,
  latestDelivery: null, pending: 0, errors: 0, latestError: null, failedWorks: 0 });
export async function collectReport(guildId: string, imageChannelId: string | null, now = new Date()): Promise<MonitorReportData> {
  const since = new Date(now.getTime() - 86400000);
  const embed = (await pool.query<ReportSection>(`
    SELECT EXISTS(SELECT 1 FROM notificacao_canais WHERE guild_id=$1) AS available,
      (SELECT count(DISTINCT (s.source,s.manhwa_id))::integer FROM assinaturas s WHERE s.guild_id=$1) AS works,
      (SELECT count(*)::integer FROM notificacao_eventos e WHERE e.sent_at >= $2
        AND e.channel_id IN (SELECT channel_id FROM notificacao_canais WHERE guild_id=$1)) AS messages,
      (SELECT max(t.last_checked) FROM capitulos_rastreados t WHERE EXISTS(
        SELECT 1 FROM assinaturas s WHERE s.guild_id=$1 AND s.manhwa_id=t.manhwa_id AND s.source=t.source)) AS "latestCheck",
      (SELECT max(e.sent_at) FROM notificacao_eventos e WHERE e.channel_id
        IN (SELECT channel_id FROM notificacao_canais WHERE guild_id=$1)) AS "latestDelivery",
      (SELECT count(*)::integer FROM notificacao_eventos e WHERE e.sent_at IS NULL AND e.channel_id
        IN (SELECT channel_id FROM notificacao_canais WHERE guild_id=$1)) AS pending,
      (SELECT count(*)::integer FROM error_logs e WHERE e.created_at >= $2
        AND e.source IN ('notification','notification_source') AND
        (e.discord_guild_id=$1 OR EXISTS(SELECT 1 FROM assinaturas s WHERE s.guild_id=$1
          AND s.manhwa_id=e.context->>'manhwaId' AND (s.source=e.context->>'source'
            OR (s.tipo='anime' AND s.source IN ('jikan','tenrai')
              AND e.context->>'source'='jikan-anime'))))) AS errors,
      (SELECT max(e.created_at) FROM error_logs e WHERE e.source IN ('notification','notification_source')
        AND (e.discord_guild_id=$1 OR EXISTS(SELECT 1 FROM assinaturas s WHERE s.guild_id=$1
          AND s.manhwa_id=e.context->>'manhwaId' AND (s.source=e.context->>'source'
            OR (s.tipo='anime' AND s.source IN ('jikan','tenrai')
              AND e.context->>'source'='jikan-anime'))))) AS "latestError",
      0 AS "failedWorks"`, [guildId, since])).rows[0]!;
  const image = imageChannelId ? (await pool.query<ReportSection>(`
    SELECT true AS available,
      (SELECT count(*)::integer FROM monitored_works WHERE active=true) AS works,
      (SELECT count(*)::integer FROM monitor_activity WHERE status LIKE 'Published%' AND created_at >= $1) AS messages,
      (SELECT max(last_checked_at) FROM monitored_works WHERE active=true) AS "latestCheck",
      (SELECT max(created_at) FROM monitor_activity WHERE status LIKE 'Published%') AS "latestDelivery",
      (SELECT count(*)::integer FROM detected_chapters d JOIN monitored_works w ON w.id=d.work_id
        WHERE w.active=true AND d.delivery_pending=true) AS pending,
      (SELECT count(*)::integer FROM error_logs WHERE source='image_monitor' AND created_at >= $1
        AND context->>'channelId'=$2) AS errors,
      (SELECT max(created_at) FROM error_logs WHERE source='image_monitor' AND context->>'channelId'=$2) AS "latestError",
      (SELECT count(*)::integer FROM monitored_works WHERE active=true AND last_status='Check failed') AS "failedWorks",
      (SELECT count(*)::integer FROM monitor_activity WHERE status LIKE 'Published%'
        AND status LIKE '%image: none%' AND created_at >= $1) AS "textOnly"`, [since, imageChannelId])).rows[0]!
    : empty();
  return { now, image, embed };
}
