require("dotenv").config();
const { REST, Routes, SlashCommandBuilder } = require("discord.js");

const commands = [
  new SlashCommandBuilder()
    .setName("source")
    .setDescription("Set source wallet (ví gửi SOL) cho server này")
    .addStringOption((opt) =>
      opt
        .setName("wallet")
        .setDescription('Source wallet, ví dụ: "5tzF..."')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("min")
    .setDescription("Set min SOL (ngưỡng tối thiểu) cho server này")
    .addNumberOption((opt) =>
      opt
        .setName("sol")
        .setDescription("Min SOL, ví dụ 50")
        .setRequired(true)
        .setMinValue(0)
    ),

  new SlashCommandBuilder()
    .setName("time")
    .setDescription("Set thời gian tối đa (giờ) cho 2 tx cũ nhất")
    .addNumberOption((opt) =>
      opt
        .setName("hours")
        .setDescription("Số giờ, ví dụ 5")
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(48)
    ),

  new SlashCommandBuilder()
    .setName("show")
    .setDescription("Xem cấu hình hiện tại (source/min/time) của server"),

  new SlashCommandBuilder()
    .setName("scan")
    .setDescription("Scan 1 Solana wallet theo điều kiện")
    .addStringOption((opt) =>
      opt
        .setName("wallet")
        .setDescription('Wallet cần scan, ví dụ: "9BKT..."')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("scanlist")
    .setDescription("Scan nhiều ví: bot sẽ chờ bạn paste list (nhiều dòng) trong chat"),
].map((c) => c.toJSON());

const token = process.env.DISCORD_BOT_TOKEN;
if (!token) {
  console.error("❌ DISCORD_BOT_TOKEN missing in .env");
  process.exit(1);
}

const rest = new REST({ version: "10" }).setToken(token);

(async () => {
  await rest.put(
    Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
    { body: commands }
  );
  console.log("✅ Registered: /source /min /time /show /scan /scanlist");
})();
