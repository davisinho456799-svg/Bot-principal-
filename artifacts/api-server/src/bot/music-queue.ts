import {
  createAudioPlayer,
  createAudioResource,
  joinVoiceChannel,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  StreamType,
  entersState,
  type VoiceConnection,
  type AudioPlayer,
  type DiscordGatewayAdapterCreator,
} from "@discordjs/voice";
import type { TextBasedChannel } from "discord.js";
import * as playdl from "play-dl";
import { spawn } from "child_process";
import * as https from "https";
import * as http from "http";
import type { IncomingMessage } from "http";
import { logger } from "../lib/logger.js";

export interface QueueEntry {
  title: string;
  url: string;
  durationSec: number;
  durationStr: string;
  requestedBy: string;
  thumbnail?: string;
}

export const QUEUE_LIMIT = 50;

// ── Invidious (proxy para YouTube — bypassa bloqueio de IP) ──────────────────
// Instâncias públicas com proxy ativo — tentadas em ordem
const INVIDIOUS_INSTANCES = [
  "https://inv.riverside.rocks",
  "https://invidious.nerdvpn.de",
  "https://yewtu.be",
  "https://invidious.privacydev.net",
];

function extractVideoId(youtubeUrl: string): string | null {
  try {
    const u = new URL(youtubeUrl);
    if (u.hostname === "youtu.be") return u.pathname.slice(1);
    return u.searchParams.get("v");
  } catch {
    return null;
  }
}

interface InvFormat {
  url: string;
  type: string;
  bitrate?: number;
}

function isInvFormat(value: unknown): value is InvFormat {
  if (!value || typeof value !== "object") return false;
  const format = value as Record<string, unknown>;
  return typeof format.url === "string" && typeof format.type === "string";
}

/** Tenta obter URL de stream via API Invidious (proxiada — sem bloqueio de IP) */
async function getInvidiousStreamUrl(videoId: string): Promise<string | null> {
  for (const instance of INVIDIOUS_INSTANCES) {
    try {
      const apiUrl = `${instance}/api/v1/videos/${videoId}?local=true&fields=adaptiveFormats`;
      const res = await fetchJson(apiUrl, 8_000);
      if (!res) continue;

      const formats: InvFormat[] = Array.isArray(res.adaptiveFormats)
        ? res.adaptiveFormats.filter(isInvFormat)
        : [];
      // Prefere WebM/Opus; aceita qualquer áudio como fallback
      const best =
        formats.find((f) => f.type?.includes("audio/webm") && f.url) ??
        formats.find((f) => f.type?.startsWith("audio/") && f.url);

      if (best?.url) {
        logger.info({ instance, videoId }, "Invidious stream OK");
        return best.url;
      }
    } catch (err) {
      logger.warn({ err, instance }, "Invidious instance failed, trying next");
    }
  }
  return null;
}

function fetchJson(url: string, timeoutMs: number): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const proto = url.startsWith("https") ? https : http;
    const req = proto.get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
      if ((res.statusCode ?? 0) >= 400) { res.resume(); resolve(null); return; }
      let body = "";
      res.on("data", (c: Buffer) => { body += c.toString(); });
      res.on("end", () => { try { resolve(JSON.parse(body) as Record<string, unknown>); } catch { resolve(null); } });
    });
    req.on("error", () => resolve(null));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(null); });
  });
}

function streamFromHttpUrl(url: string, timeoutMs = 30_000): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith("https") ? https : http;
    const req = proto.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Range": "bytes=0-",
      },
    }, (res) => {
      if ((res.statusCode ?? 0) >= 400) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} ao baixar stream`));
      } else {
        resolve(res);
      }
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error("Stream timeout")); });
  });
}

class GuildMusicQueue {
  readonly guildId: string;
  readonly connection: VoiceConnection;
  readonly player: AudioPlayer;
  queue: QueueEntry[] = [];
  current: QueueEntry | null = null;
  notifyChannel: TextBasedChannel | null = null;
  private _destroyed = false;

  constructor(guildId: string, connection: VoiceConnection) {
    this.guildId = guildId;
    this.connection = connection;
    this.player = createAudioPlayer();
    this.connection.subscribe(this.player);

    // Quando a música termina, toca a próxima
    this.player.on(AudioPlayerStatus.Idle, () => {
      if (!this._destroyed) void this._playNext();
    });

    this.player.on("error", (err) => {
      logger.error({ err, guildId }, "Erro no AudioPlayer");
      if (this.notifyChannel && this.current) {
        if (this.notifyChannel?.isSendable()) {
          this.notifyChannel
            .send(`⚠️ Erro no player para **${this.current.title}**:\n\`\`\`${err.message.slice(0, 300)}\`\`\``)
            .catch(() => null);
        }
      }
      void this._playNext();
    });

    // Reconexão automática se desconectado brevemente
    this.connection.on(VoiceConnectionStatus.Disconnected, () => {
      Promise.race([
        entersState(this.connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(this.connection, VoiceConnectionStatus.Connecting, 5_000),
      ]).catch(() => {
        if (!this._destroyed) this._destroy();
      });
    });
  }

  async _playNext(): Promise<void> {
    const next = this.queue.shift();
    if (!next) { this.current = null; return; }
    this.current = next;

    const loadingMsg = this.notifyChannel?.isSendable()
      ? await this.notifyChannel.send(`⏳ Carregando **${next.title}**…`).catch(() => null)
      : null;

    const fail = (msg: string) => {
      logger.error({ msg, title: next.title }, "Falha ao tocar");
      loadingMsg?.delete().catch(() => null);
      if (this.notifyChannel?.isSendable()) {
        this.notifyChannel
          .send(`❌ Não consegui tocar **${next.title}**:\n\`\`\`${msg.slice(0, 400)}\`\`\``)
          .catch(() => null);
      }
      this.current = null;
      void this._playNext();
    };

    try {
      // ── 1ª tentativa: Invidious (proxy — não usa IP do Railway) ────────────
      const videoId = extractVideoId(next.url);
      if (videoId) {
        const streamUrl = await getInvidiousStreamUrl(videoId);
        if (streamUrl) {
          try {
            const httpStream = await streamFromHttpUrl(streamUrl);
            const isWebm = httpStream.headers["content-type"]?.includes("webm");
            const resource = createAudioResource(httpStream, {
              inputType: isWebm ? StreamType.WebmOpus : StreamType.Arbitrary,
            });
            loadingMsg?.delete().catch(() => null);
            this.player.play(resource);
            return;
          } catch (err) {
            logger.warn({ err }, "Invidious stream fetch failed — trying yt-dlp");
          }
        }
      }

      // ── 2ª tentativa: yt-dlp direto (com cookies se disponível) ────────────
      const args = [
        "-f", "bestaudio/best",
        "-o", "-",
        "--no-playlist", "--quiet", "--no-warnings", "--no-check-certificate",
        "--extractor-args", "youtube:player_client=tv_embedded,ios,android",
      ];
      args.push(next.url);

      const ytdlp = spawn("yt-dlp", args);
      let stderrBuf = "";
      let hasData = false;
      let errNotified = false;

      ytdlp.stderr.on("data", (d: Buffer) => { stderrBuf += d.toString(); });
      ytdlp.stdout.once("data", () => { hasData = true; });

      ytdlp.on("error", (err) => {
        if (errNotified) return; errNotified = true;
        const isEnoent = (err as NodeJS.ErrnoException).code === "ENOENT";
        fail(isEnoent ? "yt-dlp não instalado no container" : err.message);
      });

      ytdlp.on("close", (code) => {
        if (code !== 0 && !hasData && !errNotified) {
          errNotified = true;
          fail(stderrBuf.trim() || `yt-dlp saiu com código ${code}`);
        } else if (hasData) {
          loadingMsg?.delete().catch(() => null);
        }
      });

      const resource = createAudioResource(ytdlp.stdout, {
        inputType: StreamType.Arbitrary,
      });
      this.player.play(resource);
    } catch (err: unknown) {
      fail(err instanceof Error ? err.message : String(err));
    }
  }

  pause(): boolean {
    return this.player.pause();
  }

  resume(): boolean {
    return this.player.unpause();
  }

  skip(): void {
    // Parar o player dispara o evento 'idle' → _playNext automaticamente
    this.player.stop(true);
  }

  stop(): void {
    this.queue = [];
    this.current = null;
    this._destroy();
  }

  _destroy(): void {
    if (this._destroyed) return;
    this._destroyed = true;
    this.player.stop(true);
    if (this.connection.state.status !== VoiceConnectionStatus.Destroyed) {
      this.connection.destroy();
    }
    queues.delete(this.guildId);
  }

  get isPaused(): boolean {
    return this.player.state.status === AudioPlayerStatus.Paused;
  }

  get isPlaying(): boolean {
    return this.player.state.status === AudioPlayerStatus.Playing;
  }

  get isIdle(): boolean {
    return this.player.state.status === AudioPlayerStatus.Idle;
  }
}

const queues = new Map<string, GuildMusicQueue>();

export function getOrCreateQueue(
  guildId: string,
  voiceChannelId: string,
  adapterCreator: DiscordGatewayAdapterCreator
): GuildMusicQueue {
  const existing = queues.get(guildId);
  if (existing) return existing;

  const connection = joinVoiceChannel({
    channelId: voiceChannelId,
    guildId,
    adapterCreator,
    selfDeaf: false,
    selfMute: false,
  });

  const queue = new GuildMusicQueue(guildId, connection);
  queues.set(guildId, queue);
  return queue;
}

export function getQueue(guildId: string): GuildMusicQueue | undefined {
  return queues.get(guildId);
}

/** Resolve informações de uma música: URL YouTube ou nome para busca */
export async function resolveTrack(
  query: string,
  requestedBy: string
): Promise<QueueEntry | null> {
  try {
    const isUrl =
      query.startsWith("http://") || query.startsWith("https://");

    if (isUrl && playdl.yt_validate(query) === "video") {
      // Link direto do YouTube
      const info = await playdl.video_info(query);
      const v = info.video_details;
      return {
        title: v.title ?? "Título desconhecido",
        url: v.url,
        durationSec: v.durationInSec,
        durationStr: v.durationRaw ?? "?",
        requestedBy,
        thumbnail: v.thumbnails[0]?.url,
      };
    }

    // Busca por nome
    const results = await playdl.search(query, {
      source: { youtube: "video" },
      limit: 1,
    });

    if (!results.length) return null;
    const v = results[0];
    return {
      title: v.title ?? "Título desconhecido",
      url: v.url,
      durationSec: v.durationInSec ?? 0,
      durationStr: v.durationRaw ?? "?",
      requestedBy,
      thumbnail: v.thumbnails[0]?.url,
    };
  } catch (err) {
    logger.error({ err, query }, "Erro ao resolver track");
    return null;
  }
}
