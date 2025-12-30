require("dotenv").config();
const { REST, Routes, SlashCommandBuilder } = require("discord.js");

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;     // bắt buộc
const GUILD_ID = process.env.GUILD_ID || ""; // optional (nếu muốn guild commands nhanh)

if (!DISCORD_BOT_TOKEN) throw new Error("Missing DISCORD_BOT_TOKEN in .env");
if (!CLIENT_ID) throw new Error("Missing CLIENT_ID in .env");

const commands = [];

// /show
commands.push(
  new SlashCommandBuilder().setName("show").setDescription("Show config của channel hiện tại")
);

// /source (autocomplete ở bot runtime)
commands.push(
  new SlashCommandBuilder()
    .setName("source")
    .setDescription("Set source wallet (pubkey hoặc preset)")
    .addStringOption((o) =>
      o
        .setName("wallet")
        .setDescription("Pubkey hoặc preset name (ví dụ: kucoin)")
        .setRequired(true)
        .setAutocomplete(true)
    )
);

// /min
commands.push(
  new SlashCommandBuilder()
    .setName("min")
    .setDescription("Set min SOL từ source")
    .addNumberOption((o) =>
      o.setName("sol").setDescription("Min SOL (ví dụ 50)").setRequired(true)
    )
);

// /time
commands.push(
  new SlashCommandBuilder()
    .setName("time")
    .setDescription("Set time window (giờ) - oldest signature phải nằm trong window")
    .addNumberOption((o) =>
      o.setName("hours").setDescription("Hours (1 -> 168)").setRequired(true)
    )
);

// /scan
commands.push(
  new SlashCommandBuilder()
    .setName("scan")
    .setDescription("Scan 1 wallet theo config channel")
    .addStringOption((o) =>
      o.setName("wallet").setDescription("Target wallet pubkey").setRequired(true)
    )
);

// /scanlist
commands.push(
  new SlashCommandBuilder()
    .setName("scanlist")
    .setDescription("Scan list wallets (paste hoặc upload .txt trong 60s)")
);

// /preset add/del/list
const preset = new SlashCommandBuilder().setName("preset").setDescription("Manage source presets");

preset.addSubcommand((s) =>
  s
    .setName("add")
    .setDescription("Add preset name -> wallet")
    .addStringOption((o) => o.setName("name").setDescription("preset name (a-z0-9_.-)").setRequired(true))
    .addStringOption((o) => o.setName("wallet").setDescription("source wallet pubkey").setRequired(true))
);

preset.addSubcommand((s) =>
  s
    .setName("del")
    .setDescription("Delete user preset (default preset không xoá được)")
    .addStringOption((o) => o.setName("name").setDescription("preset name").setRequired(true))
);

preset.addSubcommand((s) => s.setName("list").setDescription("List tất cả preset"));

commands.push(preset);

// /cacheclear
commands.push(
  new SlashCommandBuilder()
    .setName("cacheclear")
    .setDescription("Clear cache oldestSig (để scan lại fresh)")
    .addStringOption((o) =>
      o
        .setName("mode")
        .setDescription("channel: xoá cache theo list wallet | all: xoá hết")
        .setRequired(true)
        .addChoices(
          { name: "channel", value: "channel" },
          { name: "all", value: "all" }
        )
    )
    .addStringOption((o) =>
      o
        .setName("wallets")
        .setDescription("Chỉ dùng cho mode=channel: paste nhiều wallet (mỗi dòng 1 ví)")
        .setRequired(false)
    )
);

(async () => {
  const rest = new REST({ version: "10" }).setToken(DISCORD_BOT_TOKEN);

  const body = commands.map((c) => c.toJSON());

  try {
    console.log(`🚀 Deploying ${body.length} commands...`);

    if (GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body });
      console.log("✅ Deployed to GUILD (instant).");
    } else {
      await rest.put(Routes.applicationCommands(CLIENT_ID), { body });
      console.log("✅ Deployed GLOBAL (can take some minutes).");
    }
  } catch (e) {
    console.error("❌ Deploy failed:", e?.message || e);
    if (e?.rawError) console.error("Raw:", e.rawError);
    process.exit(1);
  }
})();
