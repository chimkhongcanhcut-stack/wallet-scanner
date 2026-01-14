require("dotenv").config();
const { Telegraf } = require("telegraf");

// ================== ENV ==================
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error("❌ Missing BOT_TOKEN in .env");
  process.exit(1);
}

// Allowed group chat IDs (2 group thôi cũng ok, cứ để list)
const ALLOWED = (process.env.ALLOWED_CHAT_IDS || "")
  .split(",")
  .map((x) => x.trim())
  .filter(Boolean);

if (ALLOWED.length === 0) {
  console.error("❌ Missing ALLOWED_CHAT_IDS in .env (comma-separated chat IDs)");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);// ================== PRIVATE GROUP GUARD ==================
bot.use((ctx, next) => {
  const chatId = String(ctx.chat?.id || "");
  if (!ALLOWED.includes(chatId)) {
    // chỉ reply khi là group/supergroup, tránh spam private
    if (ctx.chat?.type === "group" || ctx.chat?.type === "supergroup") {
      ctx.reply("mày chưa được cấp quyền để dùng bot, tìm @mjiohaa trên telegram để mua bot.");
    }
    return; // chặn toàn bộ logic phía dưới
  }
  return next();
});



// ================== RAM STATE ==================
// chatId => { seq, totalSaved, pendingSave }
const RAM = new Map();

function isAllowed(ctx) {
  return ALLOWED.includes(String(ctx.chat?.id || ""));
}

function bucket(chatId) {
  if (!RAM.has(chatId)) RAM.set(chatId, { seq: 0, totalSaved: 0, pendingSave: null });
  return RAM.get(chatId);
}

// Solana pubkey basic check
function extractWallets(text) {
  const re = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  return String(text || "")
    .split(/\s+/)
    .map((x) => x.trim())
    .filter((x) => re.test(x));
}

// ================== COMMANDS ==================
bot.start((ctx) => {
  if (!isAllowed(ctx)) return;
  ctx.reply(
    "🔒 Wallet Namer BOT (2 Groups)\n\n" +
      "• /save <name> → reply tin nhắn bot trong 15s để paste ví\n" +
      "• /reset → reset số đếm\n" +
      "• /stats → xem tổng\n\n" +
      `✅ Allowed groups: ${ALLOWED.length}`
  );
});

bot.command("reset", (ctx) => {
  if (!isAllowed(ctx)) return;
  const b = bucket(ctx.chat.id);
  b.seq = 0;
  b.pendingSave = null;
  ctx.reply("🔁 Reset xong, lần sau bắt đầu từ 1");
});

bot.command("stats", (ctx) => {
  if (!isAllowed(ctx)) return;
  const b = bucket(ctx.chat.id);
  ctx.reply(`📊 seq=${b.seq} | total=${b.totalSaved}`);
});

bot.command("save", async (ctx) => {
  if (!isAllowed(ctx)) return;

  const name = String(ctx.message?.text || "")
    .replace(/^\/save(@\w+)?\s*/i, "")
    .trim();

  if (!name) return ctx.reply("Dùng: /save <name>");

  const b = bucket(ctx.chat.id);
  const msg = await ctx.reply(`⏳ Reply tin nhắn này trong 15s\nName: ${name}`);
  b.pendingSave = { name, until: Date.now() + 15000, replyMsgId: msg.message_id };
});

// ================== ONLY ACCEPT REPLY TO BOT'S PROMPT ==================
bot.on("text", async (ctx) => {
  if (!isAllowed(ctx)) return;

  const b = bucket(ctx.chat.id);
  if (!b.pendingSave || Date.now() > b.pendingSave.until) return;

  const replyTo = ctx.message?.reply_to_message?.message_id;
  if (replyTo !== b.pendingSave.replyMsgId) return;

  const wallets = extractWallets(ctx.message.text);
  if (!wallets.length) return;

  const name = b.pendingSave.name;

  const out = [];
  for (const w of wallets) {
    b.seq++;
    b.totalSaved++;
    out.push(`${w} ${name} ${b.seq}`);
  }

  // clear pending
  b.pendingSave = null;

  // Telegram text limit ~4096 chars
  const text = out.join("\n");
  const MAX_TG = 3900; // chừa headroom

  if (text.length <= MAX_TG) {
    return ctx.reply(text);
  }

  // too long -> send as .txt
  const filename = `saved_${name}_${Date.now()}.txt`;
  const header =
    `✅ Saved ${out.length} wallets\n` +
    `Name: ${name}\n` +
    `---\n`;

  const fileBuf = Buffer.from(header + text + "\n", "utf8");

  await ctx.reply(`📄 Output dài quá (${text.length} chars) → gửi file .txt nha 😄`);
  return ctx.replyWithDocument({ source: fileBuf, filename });
});

// ================== BOOT ==================
bot.launch();
console.log("✅ Wallet Namer BOT started");
console.log("🔒 Allowed chat IDs:", ALLOWED.join(", "));

// graceful stop
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
