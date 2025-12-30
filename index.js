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

const DEFAULT_TIME_HOURS = 5;

const SIG_FETCH_LIMIT = 120;
const CONCURRENCY = 6;
const REQUEST_TIMEOUT_MS = 20_000;

const STATE_FILE = path.join(__dirname, "state.json");
const DEFAULT_SOURCE = "";

// txt attachment limits
const MAX_TXT_BYTES = 1_000_000; // 1MB

// ================== STATE (PER-CHANNEL) ==================
// removed mins
let state = { sources: {}, times: {}, presets: {} };

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
      if (!state || typeof state !== "object") state = { sources: {}, times: {}, presets: {} };

      if (!state.sources || typeof state.sources !== "object") state.sources = {};
      if (!state.times || typeof state.times !== "object") state.times = {};
      if (!state.presets || typeof state.presets !== "object") state.presets = {};

      // backward-compat: nếu file cũ có mins thì bỏ qua
      if (state.mins) delete state.mins;
    }
  } catch {
    state = { sources: {}, times: {}, presets: {} };
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

function getSourceForChannel(guildId, channelId) {
  return state.sources[scopeKey(guildId, channelId)] || DEFAULT_SOURCE;
}
function setSourceForChannel(guildId, channelId, source) {
  state.sources[scopeKey(guildId, channelId)] = source;
  saveState();
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

// ================== PRESET (DEFAULT + USER) ==================
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

function getPreset(name) {
  const all = getAllPresets();
  return all[name] || null;
}

function setPreset(name, wallet) {
  if (!state.presets || typeof state.presets !== "object") state.presets = {};
  state.presets[name] = wallet;
  saveState();
}

function delPreset(name) {
  // chỉ xoá user preset; default preset không xoá được
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
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
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
    {
      timeout: REQUEST_TIMEOUT_MS,
      headers: { "Content-Type": "application/json" },
      validateStatus: () => true,
    }
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
function lamportsToSol(l) {
  return l / 1_000_000_000;
}
function extractSystemTransfers(tx) {
  const out = [];
  if (!tx) return out;

  for (const ix of tx?.transaction?.message?.instructions || []) {
    if (ix?.program === "system" && ix?.parsed?.type === "transfer") {
      const info = ix.parsed.info;
      out.push({ from: info.source, to: info.destination, lamports: Number(info.lamports || 0) });
    }
  }
  for (const group of tx?.meta?.innerInstructions || []) {
    for (const ix of group?.instructions || []) {
      if (ix?.program === "system" && ix?.parsed?.type === "transfer") {
        const info = ix.parsed.info;
        out.push({ from: info.source, to: info.destination, lamports: Number(info.lamports || 0) });
      }
    }
  }

  return out;
}

// Lấy pre/post balance của wallet trong transaction (để check "initial balance = 0")
function getWalletPrePostLamports(tx, wallet) {
  try {
    const keys = tx?.transaction?.message?.accountKeys || [];
    // accountKeys có thể là string hoặc object { pubkey, signer, writable }
    const idx = keys.findIndex((k) => {
      if (typeof k === "string") return k === wallet;
      if (k && typeof k === "object") return k.pubkey === wallet;
      return false;
    });
    if (idx < 0) return null;
    const pre = tx?.meta?.preBalances?.[idx];
    const post = tx?.meta?.postBalances?.[idx];
    if (typeof pre !== "number" || typeof post !== "number") return null;
    return { pre, post };
  } catch {
    return null;
  }
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
  const txt = atts.find(isTxt);
  if (txt) return txt;

  const plain = atts.find((a) => (a.contentType || "").includes("text/plain"));
  return plain || null;
}

async function downloadAttachmentText(att) {
  const size = Number(att.size || 0);
  if (size > MAX_TXT_BYTES) {
    throw new Error(
      `File quá lớn (${Math.round(size / 1024)}KB). Max ~${Math.round(MAX_TXT_BYTES / 1024)}KB.`
    );
  }

  const url = att.url;
  const res = await axios.get(url, { responseType: "text", timeout: REQUEST_TIMEOUT_MS });
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

// ================== SCAN LOGIC ==================
// Match khi có transfer source -> wallet, và preBalance(wallet) == 0 trong tx đó
async function scanWalletWithSource(wallet, sourceWallet, timeHours) {
  const sigs = await getSignatures(wallet, SIG_FETCH_LIMIT);
  if (!Array.isArray(sigs) || sigs.length === 0) return null;

  const nowSec = Math.floor(Date.now() / 1000);
  const maxAgeSec = Math.floor(timeHours * 3600);

  // duyệt từ mới -> cũ (sigs đã trả về thường newest first)
  for (const s of sigs) {
    const sig = s.signature;
    if (!sig) continue;

    // lọc theo time window dựa vào blockTime của signature (nhanh)
    if (s.blockTime) {
      if (nowSec - s.blockTime > maxAgeSec) continue;
    }

    let tx;
    try {
      tx = await getTx(sig);
    } catch {
      continue;
    }
    if (!tx?.blockTime) continue;
    if (nowSec - tx.blockTime > maxAgeSec) continue;

    const transfers = extractSystemTransfers(tx);
    if (!transfers.length) continue;

    // check transfer source -> wallet trong tx này
    for (const tr of transfers) {
      if (tr.from !== sourceWallet) continue;
      if (tr.to !== wallet) continue;

      const pp = getWalletPrePostLamports(tx, wallet);
      if (!pp) continue;

      // initial balance = 0 ngay trước khi nhận
      if (pp.pre !== 0) continue;

      const fundedSol = lamportsToSol(tr.lamports);
      const balance = await getSolBalance(wallet);

      return {
        wallet,
        balance,
        source: sourceWallet,
        fundedSol,
        sig,
        fundingTime: formatTime(tx.blockTime),
        scannedAt: scanNowStr(),
        rule: "Funding vào ví có preBalance = 0",
        timeRule: `${timeHours} giờ`,
      };
    }
  }

  return null;
}

// ================== PRETTY OUTPUT ==================
function makeSummaryEmbed({ source, timeHours, scannedCount, hitCount, channelId }) {
  return new EmbedBuilder()
    .setTitle("🔎 Scan Result (Channel Config)")
    .setColor(hitCount > 0 ? 0x2ecc71 : 0x95a5a6)
    .setDescription(
      `**Channel:** <#${channelId}>\n` +
        `**Source:** ${source ? `[${shortPk(source)}](${solscanTransfersUrl(source)})` : "*chưa set*"}\n` +
        `**Rule:** **funding vào ví có preBalance = 0**\n` +
        `**Time window:** **${timeHours} giờ**\n` +
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
        `**Rule:** **${hit.rule}**\n` +
        `**Funding time:** **${hit.fundingTime}**\n` +
        `**Scanned at:** **${hit.scannedAt}**\n` +
        `**Time window:** **${hit.timeRule}**\n\n` +
        `**Source:** [${shortPk(hit.source)}](${solscanTransfersUrl(hit.source)})\n` +
        `**Amount from source:** **${hit.fundedSol.toFixed(3)} SOL**\n` +
        `**TX:** [Open on Solscan](${txLink})`
    )
    .setFooter({ text: "Solana Initial-0 Funding Scanner" })
    .setTimestamp(new Date());
}

function makeWalletButtons(hit) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel("Open Transfers").setStyle(ButtonStyle.Link).setURL(solscanTransfersUrl(hit.wallet)),
    new ButtonBuilder().setLabel("Open TX").setStyle(ButtonStyle.Link).setURL(solscanTxUrl(hit.sig))
  );
}

async function runScanAndRespond(target, wallets, source, timeHours, channelId) {
  const results = await mapLimit(wallets, CONCURRENCY, async (w) => {
    try {
      return await scanWalletWithSource(w, source, timeHours);
    } catch {
      return null;
    }
  });

  const hits = results.filter(Boolean);
  hits.sort((a, b) => b.fundedSol - a.fundedSol || b.balance - a.balance);

  const summary = makeSummaryEmbed({
    source,
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
const waiting = new Map(); // key = guild:user:channel
function waitKey(guildId, userId, channelId) {
  return `${guildId}:${userId}:${channelId}`;
}

// ================== INTERACTIONS ==================
client.on("interactionCreate", async (interaction) => {
  try {
    // ================== AUTOCOMPLETE (/source wallet) ==================
    if (interaction.isAutocomplete()) {
      if (interaction.commandName !== "source") return;

      const focused = interaction.options.getFocused(true); // { name, value }
      if (!focused || focused.name !== "wallet") return;

      const q = String(focused.value || "").toLowerCase();
      const presets = getAllPresets();
      const keys = Object.keys(presets).sort();

      const results = keys
        .filter((k) => k.startsWith(q))
        .slice(0, 25)
        .map((k) => ({
          name: `${k} (${presets[k].slice(0, 4)}…${presets[k].slice(-4)})`,
          value: k,
        }));

      return interaction.respond(results);
    }

    // ================== COMMANDS ==================
    if (!interaction.isChatInputCommand()) return;

    const guildId = interaction.guildId;
    const channelId = interaction.channelId;
    if (!guildId || !channelId) return;

    // /show
    if (interaction.commandName === "show") {
      await interaction.deferReply();

      const source = getSourceForChannel(guildId, channelId);
      const timeHours = getTimeForChannel(guildId, channelId);

      const e = new EmbedBuilder()
        .setTitle("⚙️ Current Config (This Channel)")
        .setColor(0x3498db)
        .setDescription(
          `**Channel:** <#${channelId}>\n` +
            `**Source:** ${source ? `[${source}](${solscanTransfersUrl(source)})` : "*chưa set*"}\n` +
            `**Rule:** **funding vào ví có preBalance = 0**\n` +
            `**Time window:** **${timeHours} giờ**\n\n` +
            `Dùng:\n` +
            `- \`/source wallet:<pubkey>\` (như cũ)\n` +
            `- \`/source wallet:<presetName>\` (mới)\n` +
            `- \`/preset add name:<name> wallet:<pubkey>\`\n` +
            `- \`/preset del name:<name>\`\n` +
            `- \`/preset list\`\n` +
            `- \`/time hours:5\`\n` +
            `- \`/scan wallet:<pubkey>\`\n` +
            `- \`/scanlist\` rồi paste/upload .txt`
        )
        .setTimestamp(new Date());

      return interaction.editReply({ embeds: [e] });
    }

    // /preset
    if (interaction.commandName === "preset") {
      await interaction.deferReply();

      const sub = interaction.options.getSubcommand();

      if (sub === "add") {
        const name = normalizePresetName(interaction.options.getString("name"));
        const wallet = String(interaction.options.getString("wallet") || "")
          .trim()
          .replace(/^"+|"+$/g, "");

        if (!name || !isValidPresetName(name)) {
          return interaction.editReply("❌ Tên preset không hợp lệ (2-32 ký tự: a-z 0-9 _ - .).");
        }
        if (!looksLikeSolPubkey(wallet)) {
          return interaction.editReply("❌ Wallet không hợp lệ (pubkey Solana).");
        }

        setPreset(name, wallet);

        const e = new EmbedBuilder()
          .setTitle("✅ Preset Added")
          .setColor(0x2ecc71)
          .setDescription(`**Name:** **${name}**\n**Wallet:** \`${wallet}\`\n\nDùng: \`/source wallet:${name}\``)
          .setTimestamp(new Date());

        return interaction.editReply({ embeds: [e] });
      }

      if (sub === "del") {
        const name = normalizePresetName(interaction.options.getString("name"));
        const ok = delPreset(name);
        if (!ok) {
          return interaction.editReply(
            `⚠️ Không tìm thấy preset **${name}** trong user presets (default preset không xoá được).`
          );
        }
        return interaction.editReply(`✅ Đã xoá preset **${name}**.`);
      }

      if (sub === "list") {
        const all = getAllPresets();
        const keys = Object.keys(all).sort();
        if (keys.length === 0) return interaction.editReply("⚠️ Chưa có preset nào.");

        const lines = keys.slice(0, 80).map((k) => `- **${k}** → \`${all[k]}\``);
        const more = keys.length > 80 ? `\n… và còn **${keys.length - 80}** preset nữa.` : "";

        const e = new EmbedBuilder()
          .setTitle("📌 Preset List")
          .setColor(0x3498db)
          .setDescription(lines.join("\n") + more)
          .setTimestamp(new Date());

        return interaction.editReply({ embeds: [e] });
      }

      return interaction.editReply("❌ Subcommand không hợp lệ.");
    }

    // /source
    if (interaction.commandName === "source") {
      await interaction.deferReply();

      const raw = interaction.options.getString("wallet");
      const input = String(raw || "").trim().replace(/^"+|"+$/g, "");

      const name = normalizePresetName(input);
      const presetWallet = getPreset(name);

      let source = presetWallet || input;

      if (!presetWallet && !looksLikeSolPubkey(source)) {
        return interaction.editReply(
          "❌ Source không hợp lệ.\n" +
            "Bạn có thể:\n" +
            `- Nhập pubkey: \`/source wallet:5tzF...\`\n` +
            `- Hoặc preset name: \`/source wallet:kucoin\` (gõ ku sẽ có suggestion)\n` +
            `- Quản lý preset: \`/preset add/del/list\``
        );
      }

      setSourceForChannel(guildId, channelId, source);

      const hint = presetWallet ? ` (preset: **${name}**)` : "";

      const e = new EmbedBuilder()
        .setTitle("✅ Source Updated (This Channel)")
        .setColor(0x3498db)
        .setDescription(
          `**Channel:** <#${channelId}>\n` +
            `Source:${hint}\n` +
            `**${source}**\n\nLink: ${solscanTransfersUrl(source)}`
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

      const source = getSourceForChannel(guildId, channelId);
      if (!source) {
        return interaction.editReply(`⚠️ Channel này chưa set source. Dùng: \`/source wallet:YourSourceWallet\``);
      }

      const timeHours = getTimeForChannel(guildId, channelId);

      const w = interaction.options.getString("wallet").trim().replace(/^"+|"+$/g, "");
      if (!looksLikeSolPubkey(w)) return interaction.editReply("❌ Wallet không hợp lệ.");

      return runScanAndRespond(interaction, [w], source, timeHours, channelId);
    }

    // /scanlist
    if (interaction.commandName === "scanlist") {
      await interaction.deferReply();

      const source = getSourceForChannel(guildId, channelId);
      if (!source) {
        return interaction.editReply(`⚠️ Channel này chưa set source. Dùng: \`/source wallet:YourSourceWallet\``);
      }

      const timeHours = getTimeForChannel(guildId, channelId);

      const key = waitKey(guildId, interaction.user.id, channelId);
      waiting.set(key, { expiresAt: Date.now() + 60_000, source, timeHours, channelId });

      const e = new EmbedBuilder()
        .setTitle("📝 Paste list hoặc upload .txt")
        .setColor(0xf1c40f)
        .setDescription(
          `**Channel:** <#${channelId}>\n` +
            `Trong **60 giây**, bạn có thể:\n` +
            `1) Paste list ví nhiều dòng, hoặc\n` +
            `2) Upload file **message.txt / .txt** (Discord auto tạo cũng được)\n\n` +
            `**Rule:** funding vào ví có **preBalance = 0**\n` +
            `**Source:** ${shortPk(source)}\n` +
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

    // consume
    waiting.delete(key);

    // Prefer attachment .txt if exists
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
    if (wallets.length === 0) {
      return msg.reply("❌ Không thấy ví nào (paste sai format hoặc file rỗng).");
    }

    const srcHint = att ? `📎 Đã đọc từ file: **${att.name}**` : "📝 Đã đọc từ message";
    await msg.reply(`${srcHint}\n⏳ Đang scan **${wallets.length}** ví...`);

    return runScanAndRespond(msg, wallets, w.source, w.timeHours, w.channelId);
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
    console.log(`⏱ Default Time: ${DEFAULT_TIME_HOURS} hours`);
    console.log(`🧩 Config scope: PER CHANNEL`);
    console.log(`📎 scanlist: supports .txt attachment`);
    console.log(`✨ autocomplete: /source wallet:<presetName>`);
    console.log(`🎯 rule: funding where wallet preBalance == 0`);
  });

  await client.login(process.env.DISCORD_BOT_TOKEN);
})();
