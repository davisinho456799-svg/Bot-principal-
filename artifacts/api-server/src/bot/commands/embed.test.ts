import { ChatInputCommandInteraction, PermissionFlagsBits } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { data, execute } from "./embed.js";

function makeInteraction({
  guild = true,
  isAdmin = true,
  canEmbed = true,
  message = "Mensagem de teste",
}: {
  guild?: boolean;
  isAdmin?: boolean;
  canEmbed?: boolean;
  message?: string;
} = {}) {
  const reply = vi.fn().mockResolvedValue(undefined);
  const interaction = {
    inGuild: () => guild,
    memberPermissions: { has: (permission: bigint) =>
      permission === PermissionFlagsBits.Administrator && isAdmin },
    appPermissions: { has: (permission: bigint) =>
      permission === PermissionFlagsBits.EmbedLinks && canEmbed },
    options: { getString: () => message },
    reply,
  } as unknown as ChatInputCommandInteraction;
  return { interaction, reply };
}

describe("/embed", () => {
  it("publishes the supplied text as an embed without triggering mentions", async () => {
    const { interaction, reply } = makeInteraction({ message: "Olá @everyone" });

    await execute(interaction);

    expect(reply).toHaveBeenCalledOnce();
    const response = reply.mock.calls[0][0];
    expect(response.embeds?.[0]?.toJSON()).toMatchObject({
      description: "Olá @everyone",
      color: 0x5865f2,
    });
    expect(response.allowedMentions).toEqual({ parse: [] });
  });

  it("requires administrator permission", async () => {
    const { interaction, reply } = makeInteraction({ isAdmin: false });

    await execute(interaction);

    expect(reply).toHaveBeenCalledWith(expect.objectContaining({
      ephemeral: true,
      content: expect.stringContaining("administrador"),
    }));
  });

  it("rejects direct messages", async () => {
    const { interaction, reply } = makeInteraction({ guild: false });

    await execute(interaction);

    expect(reply).toHaveBeenCalledWith(expect.objectContaining({
      ephemeral: true,
      content: expect.stringContaining("servidor"),
    }));
  });

  it("reports when the bot cannot embed links or the message is blank", async () => {
    const missingPermission = makeInteraction({ canEmbed: false });
    await execute(missingPermission.interaction);
    expect(missingPermission.reply).toHaveBeenCalledWith(expect.objectContaining({
      ephemeral: true,
      content: expect.stringContaining("Inserir links"),
    }));

    const blankMessage = makeInteraction({ message: "   " });
    await execute(blankMessage.interaction);
    expect(blankMessage.reply).toHaveBeenCalledWith(expect.objectContaining({
      ephemeral: true,
      content: expect.stringContaining("mensagem"),
    }));
  });

  it("registers a required message option", () => {
    expect(data.toJSON()).toMatchObject({
      name: "embed",
      options: [{ name: "mensagem", required: true, type: 3 }],
      default_member_permissions: String(PermissionFlagsBits.Administrator),
    });
  });
});
