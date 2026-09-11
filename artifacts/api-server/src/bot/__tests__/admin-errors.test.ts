import { describe, expect, it } from "vitest";
import type { ErrorRow } from "../commands/admin.js";

process.env.DATABASE_URL ??= "postgres://test:test@localhost:5432/test";

const {
  buildErrorEmbed,
  buildErrorPageButtons,
  clampErrorPage,
  describeErrorRow,
} = await import("../commands/admin.js");

function errorRow(overrides: Partial<ErrorRow> = {}): ErrorRow {
  return {
    id: 1,
    discordGuildId: "guild-1",
    discordUserId: null,
    command: "admin erros",
    source: "notification_source",
    route: null,
    errorCode: "SOURCE_NO_DATA",
    message: "fonte sem dados",
    context: {
      attemptedSource: "mangadex",
      title: "Obra de teste",
    },
    httpStatus: null,
    createdAt: new Date("2026-09-10T12:00:00.000Z"),
    ...overrides,
  };
}

describe("histórico de erros do admin", () => {
  it("mantém cinco registros por página e nunca ultrapassa o limite do embed", () => {
    const rows = Array.from({ length: 11 }, (_, index) =>
      errorRow({
        id: index + 1,
        context: {
          attemptedSource: "mangadex",
          title: "A".repeat(1_000),
        },
      }),
    );

    const firstPage = buildErrorEmbed(rows, 0, 3, null).toJSON();
    const secondPage = buildErrorEmbed(rows, 1, 3, null).toJSON();
    const lastPage = buildErrorEmbed(rows, 2, 3, null).toJSON();

    expect(firstPage.title).toContain("página 1/3");
    expect(firstPage.description).toBeDefined();
    expect(firstPage.description!.length).toBeLessThanOrEqual(4096);
    expect((firstPage.description!.match(/registro `/g) ?? []).length).toBe(5);
    expect((secondPage.description!.match(/registro `/g) ?? []).length).toBe(5);
    expect((lastPage.description!.match(/registro `/g) ?? []).length).toBe(1);
  });

  it("mantém a navegação dentro da primeira e da última página", () => {
    expect(clampErrorPage(-1, 3)).toBe(0);
    expect(clampErrorPage(99, 3)).toBe(2);
    expect(clampErrorPage(1.5, 3)).toBe(0);

    const firstPageButtons = buildErrorPageButtons(0, 3)[0]!.components.map(
      (button) => button.toJSON().custom_id,
    );
    const lastPageButtons = buildErrorPageButtons(2, 3)[0]!.components.map(
      (button) => button.toJSON().custom_id,
    );

    expect(firstPageButtons).toEqual([
      "admin_errors_jump",
      "admin_errors_next",
    ]);
    expect(lastPageButtons).toEqual(["admin_errors_prev", "admin_errors_jump"]);
    expect(buildErrorPageButtons(0, 1)).toEqual([]);
  });

  it("mantém descrições claras para fonte sem dados, HTTP 403 e falha de envio", () => {
    expect(
      describeErrorRow(
        errorRow({
          errorCode: "SOURCE_NO_DATA",
          context: { attemptedSource: "mangadex", title: "Obra sem capítulo" },
        }),
      ),
    ).toContain("Fonte não retornou dados");

    expect(
      describeErrorRow(
        errorRow({
          errorCode: "SOURCE_HTTP_403",
          message: "MangaDex HTTP 403",
          httpStatus: null,
          context: { attemptedSource: "mangadex", title: "Obra bloqueada" },
        }),
      ),
    ).toContain("HTTP `403`");

    expect(
      describeErrorRow(
        errorRow({
          errorCode: "NOTIFICATION_SEND_FAILED",
          context: {
            source: "mangadex",
            title: "Obra com falha",
            channelId: "channel-1",
          },
        }),
      ),
    ).toContain("Falha ao enviar notificação");
  });
});