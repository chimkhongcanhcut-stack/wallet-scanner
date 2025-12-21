require("dotenv").config();
const { REST, Routes, SlashCommandBuilder } = require("discord.js");

function cmd(builder) {
  // Chặn DM để khỏi "The application did not respond" khi gọi trong DM
  return builder.setDMPermission(false);
}

const commands = [
  // ================== /source ==================
  cmd(
    new SlashCommandBuilder()
      .setName("source")
      .setDescription("Set source wallet cho channel này (pubkey hoặc preset name)")
      .addStringOption((opt) =>
        opt
          .setName("wallet")
          .setDescription('Nhập pubkey hoặc preset name (vd: "kucoin")')
          .setAutocomplete(true) // ✅ AUTOCOMPLETE ON
          .setRequired(true)
      )
  ),

  // ================== /preset ==================
  cmd(
    new SlashCommandBuilder()
      .setName("preset")
      .setDescription("Quản lý preset source")
      .addSubcommand((sc) =>
        sc
          .setName("add")
          .setDescription("Thêm preset mới")
          .addStringOption((opt) =>
            opt
              .setName("name")
              .setDescription('Tên preset (vd: "kucoin", "binance", "mexc")')
              .setRequired(true)
          )
          .addStringOption((opt) =>
            opt
              .setName("wallet")
              .setDescription("Pubkey Solana cho preset")
              .setRequired(true)
          )
      )
      .addSubcommand((sc) =>
        sc
          .setName("del")
          .setDescription("Xoá preset")
          .addStringOption((opt) =>
            opt
              .setName("name")
              .setDescription('Tên preset cần xoá (vd: "mexc")')
              .setRequired(true)
          )
      )
      .addSubcommand((sc) => sc.setName("list").setDescription("Xem danh sách preset"))
  ),

  // ================== /min ==================
  cmd(
    new SlashCommandBuilder()
      .setName("min")
      .setDescription("Set min SOL (ngưỡng tối thiểu) cho channel này")
      .addNumberOption((opt) =>
        opt
          .setName("sol")
          .setDescription("Min SOL, ví dụ 50")
          .setRequired(true)
          .setMinValue(0)
      )
  ),

  // ================== /time ==================
  cmd(
    new SlashCommandBuilder()
      .setName("time")
      .setDescription("Set thời gian tối đa (giờ) cho 2 tx cũ nhất (channel này)")
      .addNumberOption((opt) =>
        opt
          .setName("hours")
          .setDescription("Số giờ, ví dụ 5")
          .setRequired(true)
          .setMinValue(1)
          .setMaxValue(48)
      )
  ),

  // ================== /show ==================
  cmd(
    new SlashCommandBuilder()
      .setName("show")
      .setDescription("Xem cấu hình hiện tại (source/min/time) của channel này")
  ),

  // ================== /scan ==================
  cmd(
    new SlashCommandBuilder()
      .setName("scan")
      .setDescription("Scan 1 Solana wallet theo điều kiện (channel config)")
      .addStringOption((opt) =>
        opt
          .setName("wallet")
          .setDescription('Wallet cần scan, ví dụ: "9BKT..."')
          .setRequired(true)
      )
  ),

  // ================== /scanlist ==================
  cmd(
    new SlashCommandBuilder()
      .setName("scanlist")
      .setDescription("Scan nhiều ví: bot sẽ chờ bạn paste list hoặc upload .txt")
  ),
].map((c) => c.toJSON());

const token = process.env.DISCORD_BOT_TOKEN;
const clientId = process.env.CLIENT_ID;
const guildId = process.env.GUILD_ID;

if (!token) {
  console.error("❌ DISCORD_BOT_TOKEN missing in .env");
  process.exit(1);
}
if (!clientId) {
  console.error("❌ CLIENT_ID missing in .env");
  process.exit(1);
}
if (!guildId) {
  console.error("❌ GUILD_ID missing in .env");
  process.exit(1);
}

const rest = new REST({ version: "10" }).setToken(token);

(async () => {
  try {
    console.log("📌 Registering guild commands…");
    console.log("   CLIENT_ID:", clientId);
    console.log("   GUILD_ID :", guildId);

    await rest.put(Routes.applicationGuildCommands(clientId, guildId), {
      body: commands,
    });

    console.log("✅ Registered: /source (autocomplete) /preset /min /time /show /scan /scanlist");
    console.log("ℹ️ Nếu chưa hiện autocomplete, chờ 1-2 phút hoặc restart Discord client.");
  } catch (e) {
    console.error("❌ Register failed:", e?.message || e);
    process.exit(1);
  }
})();
