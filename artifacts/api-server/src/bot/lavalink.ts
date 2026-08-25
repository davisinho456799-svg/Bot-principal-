import { Client } from "discord.js";
import { Riffy } from "riffy";
import { logger } from "../lib/logger.js";
let manager: any = null;
export function initLavalink(client: Client): any | null {
  const host=process.env["LAVALINK_HOST"], password=process.env["LAVALINK_PASSWORD"];
  if(!host||!password){logger.warn("Lavalink paralelo desativado: defina LAVALINK_HOST e LAVALINK_PASSWORD");return null;}
  const port=Number(process.env["LAVALINK_PORT"]??2333), secure=process.env["LAVALINK_SECURE"]==="true";
  logger.info({host,port,secure},"Configurando conexão com Lavalink");
  manager=new Riffy(client as any,[{name:process.env["LAVALINK_NAME"]??"railway-lavalink",host,port,password,secure}],{send:(p:any)=>{const g=client.guilds.cache.get(p.d.guild_id);if(g)g.shard.send(p);},defaultSearchPlatform:process.env["LAVALINK_SEARCH_PLATFORM"]??"ytmsearch",restVersion:"v4"} as any);
  client.on("raw",(p:any)=>{if(p?.t==="VOICE_STATE_UPDATE"||p?.t==="VOICE_SERVER_UPDATE")manager.updateVoiceState(p);});
  manager.on("nodeConnect",(n:any)=>logger.info({node:n.name},"Lavalink paralelo conectado"));
  manager.on("nodeReconnect",(n:any)=>logger.warn({node:n.name},"Lavalink paralelo reconectando"));
  manager.on("nodeDisconnect",(n:any,r:any)=>logger.warn({node:n.name,reason:r},"Lavalink paralelo desconectado"));
  manager.on("nodeError",(n:any,e:any)=>logger.error({node:n.name,err:e},"Erro no Lavalink paralelo"));
  manager.on("trackError",(p:any,t:any,e:any)=>logger.error({guildId:p?.guildId,title:t?.info?.title,error:e},"Erro na faixa Lavalink"));
  manager.on("trackStuck",(p:any,t:any,d:any)=>logger.warn({guildId:p?.guildId,title:t?.info?.title,data:d},"Faixa travada no Lavalink"));
  manager.on("trackStart",(p:any,t:any)=>logger.info({guildId:p?.guildId,title:t?.info?.title},"Faixa Lavalink iniciada"));
  manager.on("queueEnd",(p:any)=>{logger.info({guildId:p?.guildId},"Fila Lavalink encerrada");p.destroy();});
  client.once("ready",()=>{
    logger.info("Inicializando conexão do Riffy com Lavalink");
    try {
      const result=manager.init(client.user!.id);
      if(result&&typeof result.catch==="function") void result.catch((err:any)=>logger.error({err},"Falha ao inicializar Riffy/Lavalink"));
    } catch(err) {
      logger.error({err},"Falha ao inicializar Riffy/Lavalink");
    }
  }); return manager;
}
export function getLavalink():any|null{return manager;}
export function getLavalinkPlayer(guildId:string):any|null{return manager?.players?.get(guildId)??null;}
