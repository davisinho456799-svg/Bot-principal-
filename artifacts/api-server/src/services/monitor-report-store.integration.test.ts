import { expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { pool } from "@workspace/db";
import { collectReport, configureReport, claimReport, dueReports, completeReport, getReportConfig } from "./monitor-report-store";
import { REPORT_INTERVAL_MS } from "./monitor-report-format";

it.skipIf(process.env.RUN_REPORT_DB_TEST !== "1")(
  "reads real development SQL and persists report deadlines without changing release history",
  async () => {
    const connection = await pool.connect();
    const query = vi.spyOn(pool, "query").mockImplementation(connection.query.bind(connection) as typeof pool.query);
    const key = randomUUID(), guild = `report-test-${key}`, channel = `report-channel-${key}`;
    const now = new Date();
    try {
      await connection.query("BEGIN");
      const baselineImage = (await collectReport(guild, channel, now)).image;
      await connection.query(`INSERT INTO notificacao_canais(guild_id,channel_id) VALUES($1,$2)`, [guild, channel]);
      await connection.query(`INSERT INTO assinaturas(discord_user_id,guild_id,manhwa_id,source,title,site_url,tipo)
        VALUES($1,$2,$3,'report-test-source','Report test','https://example.invalid','anime')`, [key, guild, key]);
      await connection.query(`INSERT INTO capitulos_rastreados(manhwa_id,source,title,site_url,last_chapters,last_checked)
        VALUES($1,'report-test-source','Report test','https://example.invalid',3,$2)`, [key, now]);
      await connection.query(`INSERT INTO notificacao_eventos(event_key,channel_id,title,chapter,sent_at)
        VALUES($1,$2,'Report test',3,$3),($4,$2,'Report test',4,NULL)`, [key, channel, now, `pending-${key}`]);
      const work = await connection.query(`INSERT INTO monitored_works(title,platform,listing_url,last_checked_at)
        VALUES('Report test','toptoon',$1,$2) RETURNING id`, [`https://example.invalid/${key}`, now]);
      const workId = work.rows[0].id;
      await connection.query(`INSERT INTO monitor_activity(work_id,chapter_count,status,created_at)
        VALUES($1,1,'Published (image: none)',$2)`, [workId, now]);
      await connection.query(`INSERT INTO detected_chapters(work_id,chapter_key,chapter_number,thumbnail_url,delivery_pending)
        VALUES($1,$2,'3','https://example.invalid/image.png',true)`, [workId, key]);
      const report = await collectReport(guild, channel, now);
      expect(report.embed.messages).toBe(1);
      expect(report.embed.pending).toBe(1);
      expect(report.embed.works).toBe(1);
      expect(report.image.messages).toBe(baselineImage.messages + 1);
      expect(report.image.pending).toBe(baselineImage.pending + 1);
      expect(report.image.textOnly).toBe((baselineImage.textOnly ?? 0) + 1);
      expect((await collectReport(`other-${key}`, null, now)).embed.messages).toBe(0);
      expect((await collectReport(`other-${key}`, null, now)).image.available).toBe(false);
      await connection.query("UPDATE assinaturas SET source='tenrai' WHERE manhwa_id=$1", [key]);
      await connection.query(`INSERT INTO error_logs(source,error_code,message,context)
        VALUES('notification_source','REPORT_TEST','Synthetic source failure',$1::json)`,
      [JSON.stringify({ source: "jikan-anime", manhwaId: key })]);
      expect((await collectReport(guild, channel, now)).embed.errors).toBe(1);
      expect((await collectReport(`other-${key}`, null, now)).embed.errors).toBe(0);
      const saved = await configureReport(guild, channel, true, now);
      expect(saved!.nextReportAt.getTime()).toBe(now.getTime() + REPORT_INTERVAL_MS);
      expect((await dueReports(now)).some(config => config.guildId === guild)).toBe(false);
      await connection.query("UPDATE monitor_report_configs SET next_report_at=$2 WHERE guild_id=$1", [guild, now]);
      const current = (await getReportConfig(guild))!;
      expect(await claimReport(current, "claim-a", now)).toBe(true);
      expect(await claimReport(current, "claim-b", now)).toBe(false);
      expect((await dueReports(now)).some(config => config.guildId === guild)).toBe(false);
      await completeReport(current, "claim-a", "fake-report-message", now);
      expect((await getReportConfig(guild))!.nextReportAt.getTime()).toBe(now.getTime() + REPORT_INTERVAL_MS);
      const tracked = await connection.query("SELECT last_chapters FROM capitulos_rastreados WHERE manhwa_id=$1", [key]);
      expect(tracked.rows[0].last_chapters).toBe(3);
      const event = await connection.query("SELECT sent_at FROM notificacao_eventos WHERE event_key=$1", [key]);
      expect(event.rows[0].sent_at.getTime()).toBe(now.getTime());
      await configureReport(guild, channel, false, now);
      expect((await getReportConfig(guild))!.enabled).toBe(false);
    } finally {
      await connection.query("ROLLBACK");
      query.mockRestore();
      connection.release();
      await pool.end();
    }
  },
);
