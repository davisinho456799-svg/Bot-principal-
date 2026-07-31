/**
 * Store temporário em memória para o fluxo de salvar status via modal.
 * Guarda os dados do anime enquanto o usuário preenche o modal (até 5 min).
 */

import type { ChatInputCommandInteraction } from "discord.js";
import type { UnifiedResult } from "./unified.js";

interface PendingEntry {
  anime: UnifiedResult;
  originalInteraction: ChatInputCommandInteraction;
  expiresAt: number;
}

const store = new Map<string, PendingEntry>();

export function setPendingAnime(
  userId: string,
  data: { anime: UnifiedResult; originalInteraction: ChatInputCommandInteraction }
) {
  store.set(userId, { ...data, expiresAt: Date.now() + 5 * 60 * 1000 });
}

export function getPendingAnime(userId: string): PendingEntry | null {
  const entry = store.get(userId);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    store.delete(userId);
    return null;
  }
  return entry;
}

export function deletePendingAnime(userId: string) {
  store.delete(userId);
}
