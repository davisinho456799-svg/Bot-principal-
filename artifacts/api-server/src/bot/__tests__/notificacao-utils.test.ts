import { describe, it, expect } from "vitest";
import {
  normalizeChapterValue,
  classifyHttpStatus,
  classifyException,
  isFetchError,
  fetchError,
  normalizeSynopsis,
  sameNullableNumber,
  sameNullableText,
  notificationEventKey,
} from "../notificacao-utils.js";

// ─── normalizeChapterValue ────────────────────────────────────────────────────

describe("normalizeChapterValue", () => {
  it("aceita inteiros positivos", () => {
    expect(normalizeChapterValue(150)).toBe(150);
    expect(normalizeChapterValue(1)).toBe(1);
  });

  it("aceita zero (sem capítulos ainda)", () => {
    expect(normalizeChapterValue(0)).toBe(0);
  });

  it("aceita decimais (ex: capítulo 150.5)", () => {
    expect(normalizeChapterValue(150.5)).toBe(150.5);
    expect(normalizeChapterValue("150.5")).toBe(150.5);
  });

  it("aceita strings numéricas válidas", () => {
    expect(normalizeChapterValue("42")).toBe(42);
    expect(normalizeChapterValue("0")).toBe(0);
  });

  it("rejeita strings especiais do MangaDex — EX, Oneshot, SP", () => {
    expect(normalizeChapterValue("EX")).toBeNull();
    expect(normalizeChapterValue("Oneshot")).toBeNull();
    expect(normalizeChapterValue("SP")).toBeNull();
    expect(normalizeChapterValue("Extra")).toBeNull();
  });

  it("rejeita NaN", () => {
    expect(normalizeChapterValue(NaN)).toBeNull();
    expect(normalizeChapterValue("NaN")).toBeNull();
  });

  it("rejeita Infinity", () => {
    expect(normalizeChapterValue(Infinity)).toBeNull();
    expect(normalizeChapterValue(-Infinity)).toBeNull();
  });

  it("rejeita valores negativos", () => {
    expect(normalizeChapterValue(-1)).toBeNull();
    expect(normalizeChapterValue(-0.5)).toBeNull();
  });

  it("rejeita tipos não-numéricos", () => {
    expect(normalizeChapterValue(null)).toBeNull();
    expect(normalizeChapterValue(undefined)).toBeNull();
    expect(normalizeChapterValue({})).toBeNull();
    expect(normalizeChapterValue([])).toBeNull();
    expect(normalizeChapterValue(true)).toBeNull();
  });

  it("rejeita string vazia", () => {
    expect(normalizeChapterValue("")).toBeNull();
  });
});

// ─── classifyHttpStatus ───────────────────────────────────────────────────────

describe("classifyHttpStatus", () => {
  it("mapeia 404 → http_404", () => {
    expect(classifyHttpStatus(404)).toBe("http_404");
  });

  it("mapeia 403 → http_403", () => {
    expect(classifyHttpStatus(403)).toBe("http_403");
  });

  it("mapeia 429 → http_429 (rate limit)", () => {
    expect(classifyHttpStatus(429)).toBe("http_429");
  });

  it("mapeia 500, 502, 503, 504 → http_5xx", () => {
    expect(classifyHttpStatus(500)).toBe("http_5xx");
    expect(classifyHttpStatus(502)).toBe("http_5xx");
    expect(classifyHttpStatus(503)).toBe("http_5xx");
    expect(classifyHttpStatus(504)).toBe("http_5xx");
  });

  it("mapeia outros códigos (400, 401, 422) → http_other", () => {
    expect(classifyHttpStatus(400)).toBe("http_other");
    expect(classifyHttpStatus(401)).toBe("http_other");
    expect(classifyHttpStatus(422)).toBe("http_other");
  });
});

// ─── classifyException ────────────────────────────────────────────────────────

describe("classifyException", () => {
  it("TimeoutError → timeout", () => {
    const err = new Error("signal timed out");
    err.name = "TimeoutError";
    expect(classifyException(err)).toBe("timeout");
  });

  it("AbortError → timeout", () => {
    const err = new Error("aborted");
    err.name = "AbortError";
    expect(classifyException(err)).toBe("timeout");
  });

  it("SyntaxError → invalid_response (JSON malformado)", () => {
    expect(classifyException(new SyntaxError("Unexpected token"))).toBe("invalid_response");
  });

  it("Error genérico → http_other", () => {
    expect(classifyException(new Error("network failure"))).toBe("http_other");
  });

  it("valores não-Error → http_other", () => {
    expect(classifyException("string error")).toBe("http_other");
    expect(classifyException(null)).toBe("http_other");
    expect(classifyException(42)).toBe("http_other");
  });
});

// ─── fetchError + isFetchError ────────────────────────────────────────────────

describe("fetchError / isFetchError", () => {
  it("cria FetchError com kind correto", () => {
    const e = fetchError("http_404", 404);
    expect(e._err).toBe(true);
    expect(e.kind).toBe("http_404");
    expect(e.httpStatus).toBe(404);
  });

  it("cria FetchError sem httpStatus", () => {
    const e = fetchError("no_data");
    expect(e.kind).toBe("no_data");
    expect(e.httpStatus).toBeUndefined();
  });

  it("isFetchError identifica FetchError", () => {
    expect(isFetchError(fetchError("timeout"))).toBe(true);
  });

  it("isFetchError rejeita FetchResult válido", () => {
    expect(isFetchError({ value: 100, isProxy: false })).toBe(false);
  });

  it("isFetchError rejeita null", () => {
    expect(isFetchError(null)).toBe(false);
  });
});

// ─── normalizeSynopsis ────────────────────────────────────────────────────────

describe("normalizeSynopsis", () => {
  it("colapsa espaços múltiplos em um único", () => {
    expect(normalizeSynopsis("texto  com   espaços")).toBe("texto com espaços");
  });

  it("remove quebras de linha e tabs", () => {
    expect(normalizeSynopsis("linha1\n\nlinha2\ttab")).toBe("linha1 linha2 tab");
  });

  it("remove espaços nas bordas", () => {
    expect(normalizeSynopsis("  texto  ")).toBe("texto");
  });

  it("retorna null para string vazia", () => {
    expect(normalizeSynopsis("")).toBeNull();
    expect(normalizeSynopsis("   ")).toBeNull();
  });

  it("retorna null para null", () => {
    expect(normalizeSynopsis(null)).toBeNull();
  });
});

// ─── sameNullableNumber ───────────────────────────────────────────────────────

describe("sameNullableNumber", () => {
  it("valores iguais → true", () => {
    expect(sameNullableNumber(7.5, 7.5)).toBe(true);
    expect(sameNullableNumber(0, 0)).toBe(true);
  });

  it("valores diferentes → false", () => {
    expect(sameNullableNumber(1, 2)).toBe(false);
  });

  it("null e null → true", () => {
    expect(sameNullableNumber(null, null)).toBe(true);
  });

  it("null e número → false", () => {
    expect(sameNullableNumber(null, 0)).toBe(false);
    expect(sameNullableNumber(1, null)).toBe(false);
  });
});

// ─── sameNullableText ─────────────────────────────────────────────────────────

describe("sameNullableText", () => {
  it("strings iguais → true", () => {
    expect(sameNullableText("Ongoing", "Ongoing")).toBe(true);
  });

  it("strings diferentes → false", () => {
    expect(sameNullableText("Ongoing", "Finished")).toBe(false);
  });

  it("null e null → true", () => {
    expect(sameNullableText(null, null)).toBe(true);
  });

  it("null e string → false", () => {
    expect(sameNullableText(null, "Ongoing")).toBe(false);
    expect(sameNullableText("Ongoing", null)).toBe(false);
  });
});

// ─── notificationEventKey ─────────────────────────────────────────────────────

describe("notificationEventKey", () => {
  it("considera iguais títulos com acentos e pontuação diferentes", () => {
    expect(notificationEventKey("channel-1", "Men Are Rare", 63))
      .toBe(notificationEventKey("channel-1", "Mén Are Rare!", 63));
  });

  it("separa canais e capítulos diferentes", () => {
    expect(notificationEventKey("channel-1", "Men Are Rare", 63))
      .not.toBe(notificationEventKey("channel-2", "Men Are Rare", 63));
    expect(notificationEventKey("channel-1", "Men Are Rare", 63))
      .not.toBe(notificationEventKey("channel-1", "Men Are Rare", 64));
  });

  it("preserva a separação entre títulos em alfabetos não latinos", () => {
    expect(notificationEventKey("channel-1", "作品 A", 10))
      .not.toBe(notificationEventKey("channel-1", "作品 B", 10));
  });
});
