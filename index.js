require("dotenv").config();
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  Partials,
  Events,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");

// ================== CONFIG ==================
const RPC_URL = process.env.RPC_URL;

const DEFAULT_TIME_HOURS = 48; // default
const SIG_FETCH_LIMIT = 200;   // tăng để chắc có tx trong window
const CONCURRENCY = 6;
const REQUEST_TIMEOUT_MS = 20_000;

const STATE_FILE = path.join(__dirname, "state.json");

// txt attachment limits
const MAX_TXT_BYTES = 1_000_000; // 1MB

// ================== STATE (PER-CHANNEL) ==================
let state = { times: {}, presets: {} };

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
      if (!state || typeof state !== "object") state = { times: {}, presets: {} };

      if (!state.times || typeof state.times !== "object") state.times = {};
      if (!state.presets || typeof state.presets !== "object") state.presets = {};
    }
  } catch {
    state = { times: {}, presets: {} };
  }
}
function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
  } catch (e) {
    console.log("⚠️ Cannot save state.json:", e.message);
  }
}
function scopeKey(guildId, channelId) {
  return `${guildId}:${channelId}`;
}

function getTimeForChannel(guildId, channelId) {
  const v = state.times[scopeKey(guildId, channelId)];
  return typeof v === "number" && Number.isFinite(v) ? v : DEFAULT_TIME_HOURS;
}
function setTimeForChannel(guildId, channelId, hours) {
  state.times[scopeKey(guildId, channelId)] = hours;
  saveState();
}

function looksLikeSolPubkey(s) {
  if (!s) return false;
  const t = s.trim();
  if (t.length < 32 || t.length > 50) return false;
  return /^[1-9A-HJ-NP-Za-km-z]+$/.test(t);
}

// ================== PRESET (OPTIONAL, giữ cho vui) ==================
const DEFAULT_SOURCE_PRESETS = {
  kucoin: "BmFdpraQhkiDQE6SnfG5omcA1VwzqfXrwtNYBwWTymy6",
  binance: "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9",
};
function normalizePresetName(s) {
  return String(s || "").trim().replace(/^"+|"+$/g, "").toLowerCase();
}
function isValidPresetName(name) {
  return /^[a-z0-9_.-]{2,32}$/.test(name);
}
function getAllPresets() {
  return { ...DEFAULT_SOURCE_PRESETS, ...(state.presets || {}) };
}
function setPreset(name, wallet) {
  if (!state.presets || typeof state.presets !== "object") state.presets = {};
  state.presets[name] = wallet;
  saveState();
}
function delPreset(name) {
  if (!state.presets || typeof state.presets !== "object") state.presets = {};
  if (state.presets[name]) {
    delete state.presets[name];
    saveState();
    return true;
  }
  return false;
}

// ================== DISCORD CLIENT ==================
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel],
});

// ================== UI HELPERS ==================
function scanNowStr() {
  return new Date().toLocaleString("vi-VN", { timeZone: "Asia/Bangkok" });
}
function formatTime(blockTime) {
  if (!blockTime) return "N/A";
  return new Date(blockTime * 1000).toLocaleString("vi-VN", { timeZone: "Asia/Bangkok" });
}
function solscanTransfersUrl(wallet) {
  return `https://solscan.io/account/${wallet}?page_size=100#transfers`;
}
function solscanTxUrl(sig) {
  return `https://solscan.io/tx/${sig}`;
}
function shortPk(pk) {
  if (!pk || pk.length < 12) return pk || "";
  return `${pk.slice(0, 4)}…${pk.slice(-4)}`;
}

// ================== RPC HELPERS ==================
async function rpc(method, params) {
  const res = await axios.post(
    RPC_URL,
    { jsonrpc: "2.0", id: 1, method, params },
    { timeout: REQUEST_TIMEOUT_MS, headers: { "Content-Type": "application/json" } }
  );
  if (!res.data) throw new Error(`RPC empty response for ${method}`);
  if (res.data.error) throw new Error(res.data.error.message || "RPC error");
  return res.data.result;
}
async function getSignatures(address, limit = 50) {
  return rpc("getSignaturesForAddress", [address, { limit }]);
}
async function getTx(signature) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await rpc("getTransaction", [
        signature,
        { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 },
      ]);
    } catch (e) {
      if (attempt === 2) throw e;
      await new Promise((r) => setTimeout(r, 350));
    }
  }
  return null;
}
async function getSolBalance(wallet) {
  const res = await rpc("getBalance", [wallet, { commitment: "confirmed" }]);
  return Number(res?.value || 0) / 1e9;
}

function getAccountKeys(tx) {
  const keys = tx?.transaction?.message?.accountKeys || [];
  return keys.map((k) => (typeof k === "string" ? k : k?.pubkey || k?.toString?.() || ""));
}

// ✅ core: detect wallet balance INCREASE in tx
function detectIncreaseLamports(tx, wallet) {
  if (!tx?.meta) return null;

  const keys = getAccountKeys(tx);
  const idx = keys.indexOf(wallet);
  if (idx === -1) return null;

  const pre = tx.meta.preBalances?.[idx];
  const post = tx.meta.postBalances?.[idx];

  if (!Number.isFinite(pre) || !Number.isFinite(post)) return null;

  const delta = post - pre;
  if (delta > 0) return { lamports: delta };

  return null;
}

// ================== INPUT PARSE ==================
function parseWallets(raw) {
  return raw
    .split(/\r?\n|\/\/\/|,|;/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.replace(/^"+|"+$/g, ""))
    .filter(Boolean);
}

// ================== ATTACHMENT TXT SUPPORT ==================
function pickTxtAttachment(msg) {
  const atts = [...msg.attachments.values()];
  if (atts.length === 0) return null;

  const byName = (a) => (a.name || "").toLowerCase();
  const isTxt = (a) => byName(a).endsWith(".txt") || byName(a) === "message.txt";
  return atts.find(isTxt) || atts.find((a) => (a.contentType || "").includes("text/plain")) || null;
}
async function downloadAttachmentText(att) {
  const size = Number(att.size || 0);
  if (size > MAX_TXT_BYTES) {
    throw new Error(`File quá lớn (${Math.round(size / 1024)}KB). Max ~${Math.round(MAX_TXT_BYTES / 1024)}KB.`);
  }
  const res = await axios.get(att.url, { responseType: "text", timeout: REQUEST_TIMEOUT_MS });
  if (typeof res.data !== "string") throw new Error("Không đọc được nội dung file text.");
  return res.data;
}

// ================== CONCURRENCY ==================
async function mapLimit(arr, limit, fn) {
  const ret = new Array(arr.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, arr.length) }, () =>
    (async () => {
      while (true) {
        const idx = i++;
        if (idx >= arr.length) break;
        ret[idx] = await fn(arr[idx], idx);
      }
    })()
  );
  await Promise.all(workers);
  return ret;
}

// ================== SCAN LOGIC (NEW SIMPLE) ==================
async function scanWallet(wallet, timeHours) {
  const sigs = await getSignatures(wallet, SIG_FETCH_LIMIT);
  if (!Array.isArray(sigs) || sigs.length === 0) return null;

  const nowSec = Math.floor(Date.now() / 1000);
  const maxAgeSec = Math.floor(timeHours * 3600);

  // only sigs in window
  const inWindow = sigs.filter((s) => s?.blockTime && nowSec - s.blockTime <= maxAgeSec);
  if (inWindow.length === 0) return null;

  // scan newest -> older
  for (const s of inWindow) {
    const sig = s.signature;
    const tx = await getTx(sig);
    const inc = detectIncreaseLamports(tx, wallet);
    if (!inc) continue;

    const balance = await getSolBalance(wallet);

    return {
      wallet,
      balance,
      increasedSol: inc.lamports / 1e9,
      sig,
      fundingTime: formatTime(tx?.blockTime),
      scannedAt: scanNowStr(),
      timeRule: `${timeHours} giờ`,
    };
  }

  return null;
}

// ================== PRETTY OUTPUT ==================
function makeSummaryEmbed({ timeHours, scannedCount, hitCount, channelId }) {
  return new EmbedBuilder()
    .setTitle("🔎 Scan Result (Balance Increase Detect)")
    .setColor(hitCount > 0 ? 0x2ecc71 : 0x95a5a6)
    .setDescription(
      `**Channel:** <#${channelId}>\n` +
        `**Rule:** match nếu **SOL balance của ví tăng** trong **${timeHours} giờ**\n` +
        `**Scanned:** **${scannedCount}** • **Matched:** **${hitCount}**\n` +
        `**Scan time:** **${scanNowStr()}**`
    )
    .setTimestamp(new Date());
}

function makeWalletEmbed(hit) {
  const transfersLink = solscanTransfersUrl(hit.wallet);
  const txLink = solscanTxUrl(hit.sig);

  return new EmbedBuilder()
    .setTitle(`✅ MATCH: ${shortPk(hit.wallet)}`)
    .setURL(transfersLink)
    .setColor(0x2ecc71)
    .setDescription(
      `**Wallet:** [${hit.wallet}](${transfersLink})\n` +
        `**Balance:** **${Number(hit.balance || 0).toFixed(3)} SOL**\n\n` +
        `**Time rule:** **${hit.timeRule}**\n` +
        `**Found at:** **${hit.fundingTime}**\n` +
        `**Detected increase:** **+${hit.increasedSol.toFixed(6)} SOL**\n` +
        `**TX:** [Open on Solscan](${txLink})\n` +
        `**Scanned at:** **${hit.scannedAt}**`
    )
    .setFooter({ text: "Solana Balance Increase Scanner" })
    .setTimestamp(new Date());
}

function makeWalletButtons(hit) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel("Open Transfers").setStyle(ButtonStyle.Link).setURL(solscanTransfersUrl(hit.wallet)),
    new ButtonBuilder().setLabel("Open TX").setStyle(ButtonStyle.Link).setURL(solscanTxUrl(hit.sig))
  );
}

async function runScanAndRespond(target, wallets, timeHours, channelId) {
  const results = await mapLimit(wallets, CONCURRENCY, async (w) => {
    try {
      return await scanWallet(w, timeHours);
    } catch {
      return null;
    }
  });

  const hits = results.filter(Boolean);
  hits.sort((a, b) => b.increasedSol - a.increasedSol || b.balance - a.balance);

  const summary = makeSummaryEmbed({
    timeHours,
    scannedCount: wallets.length,
    hitCount: hits.length,
    channelId,
  });

  if ("editReply" in target) {
    await target.editReply({ content: hits.length > 0 ? "@everyone" : "", embeds: [summary] });
  } else {
    await target.reply({ content: hits.length > 0 ? "@everyone" : "", embeds: [summary] });
  }

  if (hits.length === 0) return;

  const top = hits.slice(0, 5);
  for (const h of top) {
    const embed = makeWalletEmbed(h);
    const row = makeWalletButtons(h);
    if ("followUp" in target) await target.followUp({ embeds: [embed], components: [row] });
    else await target.channel.send({ embeds: [embed], components: [row] });
  }

  if (hits.length > 5) {
    const moreText = `ℹ️ Có thêm **${hits.length - 5}** match khác (đang chỉ hiển thị 5 match đầu).`;
    if ("followUp" in target) await target.followUp({ content: moreText });
    else await target.channel.send({ content: moreText });
  }
}

// ================== /scanlist WAITING ==================
const waiting = new Map();
function waitKey(guildId, userId, channelId) {
  return `${guildId}:${userId}:${channelId}`;
}

// ================== INTERACTIONS ==================
client.on("interactionCreate", async (interaction) => {
  try {
    // autocomplete (preset - optional)
    if (interaction.isAutocomplete()) {
      if (interaction.commandName !== "preset") return;
      return interaction.respond([]);
    }

    if (!interaction.isChatInputCommand()) return;

    const guildId = interaction.guildId;
    const channelId = interaction.channelId;
    if (!guildId || !channelId) return;

    // /show
    if (interaction.commandName === "show") {
      await interaction.deferReply();
      const timeHours = getTimeForChannel(guildId, channelId);

      const e = new EmbedBuilder()
        .setTitle("⚙️ Current Config (This Channel)")
        .setColor(0x3498db)
        .setDescription(
          `**Channel:** <#${channelId}>\n` +
            `**Time window:** **${timeHours} giờ**\n\n` +
            `Rule: match nếu **SOL balance của ví tăng** trong time window.\n\n` +
            `Dùng:\n` +
            `- \`/time hours:168\`\n` +
            `- \`/scan wallet:<pubkey>\`\n` +
            `- \`/scanlist\``
        )
        .setTimestamp(new Date());

      return interaction.editReply({ embeds: [e] });
    }

    // /time
    if (interaction.commandName === "time") {
      await interaction.deferReply();
      const h = Number(interaction.options.getNumber("hours"));
      if (!Number.isFinite(h) || h < 1 || h > 168) {
        return interaction.editReply("❌ Hours không hợp lệ (1 → 168).");
      }
      setTimeForChannel(guildId, channelId, h);

      const e = new EmbedBuilder()
        .setTitle("✅ Time Window Updated (This Channel)")
        .setColor(0xf39c12)
        .setDescription(`**Channel:** <#${channelId}>\nTime window: **${h} giờ**`)
        .setTimestamp(new Date());

      return interaction.editReply({ embeds: [e] });
    }

    // /scan
    if (interaction.commandName === "scan") {
      await interaction.deferReply();
      const timeHours = getTimeForChannel(guildId, channelId);

      const w = interaction.options.getString("wallet")?.trim()?.replace(/^"+|"+$/g, "");
      if (!looksLikeSolPubkey(w)) return interaction.editReply("❌ Wallet không hợp lệ.");

      return runScanAndRespond(interaction, [w], timeHours, channelId);
    }

    // /scanlist
    if (interaction.commandName === "scanlist") {
      await interaction.deferReply();
      const timeHours = getTimeForChannel(guildId, channelId);

      const key = waitKey(guildId, interaction.user.id, channelId);
      waiting.set(key, { expiresAt: Date.now() + 60_000, timeHours, channelId });

      const e = new EmbedBuilder()
        .setTitle("📝 Paste list hoặc upload .txt")
        .setColor(0xf1c40f)
        .setDescription(
          `**Channel:** <#${channelId}>\n` +
            `Trong **60 giây**, bạn có thể:\n` +
            `1) Paste list ví nhiều dòng, hoặc\n` +
            `2) Upload file **message.txt / .txt**\n\n` +
            `**Time window:** ${timeHours} giờ\n\n` +
            `Ví dụ paste:\n\`"wallet1"\n"wallet2"\n"wallet3"\``
        )
        .setTimestamp(new Date());

      return interaction.editReply({ embeds: [e] });
    }
  } catch (e) {
    try {
      if (interaction.deferred || interaction.replied) await interaction.editReply(`❌ Lỗi: ${e.message}`);
    } catch {}
  }
});

// ================== MESSAGE HANDLER FOR /scanlist ==================
client.on("messageCreate", async (msg) => {
  try {
    if (msg.author.bot) return;
    if (!msg.guildId) return;

    const key = waitKey(msg.guildId, msg.author.id, msg.channelId);
    const w = waiting.get(key);
    if (!w) return;

    if (Date.now() > w.expiresAt) {
      waiting.delete(key);
      return;
    }

    waiting.delete(key);

    let rawText = msg.content || "";
    const att = pickTxtAttachment(msg);

    if (att) {
      try {
        rawText = await downloadAttachmentText(att);
      } catch (e) {
        return msg.reply(`❌ Không đọc được file .txt: ${e.message}`);
      }
    }

    const wallets = [...new Set(parseWallets(rawText))].slice(0, 250);
    if (wallets.length === 0) return msg.reply("❌ Không thấy ví nào (paste sai format hoặc file rỗng).");

    const srcHint = att ? `📎 Đã đọc từ file: **${att.name}**` : "📝 Đã đọc từ message";
    await msg.reply(`${srcHint}\n⏳ Đang scan **${wallets.length}** ví...`);

    return runScanAndRespond(msg, wallets, w.timeHours, w.channelId);
  } catch {}
});

// ================== START ==================
(async () => {
  if (!RPC_URL) {
    console.error("❌ Missing RPC_URL in .env");
    process.exit(1);
  }
  if (!process.env.DISCORD_BOT_TOKEN) {
    console.error("❌ Missing DISCORD_BOT_TOKEN in .env");
    process.exit(1);
  }

  loadState();

  client.once(Events.ClientReady, (c) => {
    console.log(`✅ Bot logged in as ${c.user.tag}`);
    console.log(`🧩 Config scope: PER CHANNEL`);
    console.log(`📎 scanlist: supports .txt attachment`);
    console.log(`✅ logic: match if wallet balance increases within time window`);
    console.log(`✅ /time max: 168h`);
  });

  await client.login(process.env.DISCORD_BOT_TOKEN);
})();
