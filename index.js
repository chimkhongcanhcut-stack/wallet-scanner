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

const DEFAULT_MIN_SOL = 50;
const DEFAULT_TIME_HOURS = 5;

const SIG_FETCH_LIMIT = 120;
const CONCURRENCY = 6;
const REQUEST_TIMEOUT_MS = 20_000;

const STATE_FILE = path.join(__dirname, "state.json");
const DEFAULT_SOURCE = "";

// txt attachment limits
const MAX_TXT_BYTES = 1_000_000; // 1MB đủ dùng; file quá lớn thì từ chối

// ================== STATE (PER-CHANNEL) ==================
let state = { sources: {}, mins: {}, times: {}, presets: {} };

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
      if (!state || typeof state !== "object")
        state = { sources: {}, mins: {}, times: {}, presets: {} };

      if (!state.sources || typeof state.sources !== "object") state.sources = {};
      if (!state.mins || typeof state.mins !== "object") state.mins = {};
      if (!state.times || typeof state.times !== "object") state.times = {};
      if (!state.presets || typeof state.presets !== "object") state.presets = {};
    }
  } catch {
    state = { sources: {}, mins: {}, times: {}, presets: {} };
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

function getMinForChannel(guildId, channelId) {
  const v = state.mins[scopeKey(guildId, channelId)];
  return typeof v === "number" && Number.isFinite(v) ? v : DEFAULT_MIN_SOL;
}
function setMinForChannel(guildId, channelId, minSol) {
  state.mins[scopeKey(guildId, channelId)] = minSol;
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

// ================== SOURCE PRESETS (DEFAULT + USER) ==================
const DEFAULT_SOURCE_PRESETS = {
  kucoin: "BmFdpraQhkiDQE6SnfG5omcA1VwzqfXrwtNYBwWTymy6",
  binance: "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9",
};

function normalizeSourceInput(s) {
  return String(s || "")
    .trim()
    .replace(/^"+|"+$/g, "")
    .toLowerCase();
}

function isValidPresetName(name) {
  // cho phép a-z 0-9 _ - . (ngắn gọn, dễ gõ)
  return /^[a-z0-9_.-]{2,32}$/.test(name);
}

function getAllPresets() {
  // user preset override default preset nếu trùng key
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
  // ưu tiên file message.txt / *.txt
  const atts = [...msg.attachments.values()];
  if (atts.length === 0) return null;

  const byName = (a) => (a.name || "").toLowerCase();
  const isTxt = (a) => byName(a).endsWith(".txt") || byName(a) === "message.txt";
  const txt = atts.find(isTxt);
  if (txt) return txt;

  // fallback: nếu Discord gửi file không .txt nhưng content-type text/plain
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
async function scanWalletWithSource(wallet, sourceWallet, minSol, timeHours) {
  const sigs = await getSignatures(wallet, SIG_FETCH_LIMIT);
  if (!Array.isArray(sigs) || sigs.length === 0) return null;

  const oldestTwo = sigs.slice(-2);

  const txs = await Promise.all(
    oldestTwo.map(async (s) => {
      const sig = s.signature;
      const tx = await getTx(sig);
      const transfers = extractSystemTransfers(tx);
      return {
        sig,
        blockTime: tx?.blockTime || null,
        isTransferTx: transfers.length > 0,
        transfers,
      };
    })
  );

  // Time window: cả 2 tx cũ nhất phải trong X giờ
  const nowSec = Math.floor(Date.now() / 1000);
  const maxAgeSec = Math.floor(timeHours * 3600);
  for (const t of txs) {
    if (!t.blockTime) return null;
    if (nowSec - t.blockTime > maxAgeSec) return null;
  }

  // White-ish
  const isCond1 = sigs.length === 1 && txs[0]?.isTransferTx === true;
  const isCond2 = sigs.length >= 2 && txs.length >= 2 && txs[0].isTransferTx && txs[1].isTransferTx;
  if (!isCond1 && !isCond2) return null;

  // Funding from source -> wallet >= minSol (trong 2 tx cũ nhất)
  for (const t of txs) {
    for (const tr of t.transfers) {
      if (tr.from !== sourceWallet) continue;
      if (tr.to !== wallet) continue;

      const sol = lamportsToSol(tr.lamports);
      if (sol < minSol) continue;

      const balance = await getSolBalance(wallet);

      return {
        wallet,
        balance,
        source: sourceWallet,
        fundedSol: sol,
        sig: t.sig,
        fundingTime: formatTime(t.blockTime),
        scannedAt: scanNowStr(),
        txCondition: isCond1
          ? "Điều kiện 1 (1 tx đầu là transfer)"
          : "Điều kiện 2 (2 tx đầu đều transfer)",
        timeRule: `${timeHours} giờ`,
      };
    }
  }

  return null;
}

// ================== PRETTY OUTPUT ==================
function makeSummaryEmbed({ source, minSol, timeHours, scannedCount, hitCount, channelId }) {
  return new EmbedBuilder()
    .setTitle("🔎 Scan Result (Channel Config)")
    .setColor(hitCount > 0 ? 0x2ecc71 : 0x95a5a6)
    .setDescription(
      `**Channel:** <#${channelId}>\n` +
        `**Source:** ${source ? `[${shortPk(source)}](${solscanTransfersUrl(source)})` : "*chưa set*"}\n` +
        `**Min amount:** **${minSol} SOL**\n` +
        `**Time window:** **${timeHours} giờ** (2 tx cũ nhất)\n` +
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
        `**Tx:** **${hit.txCondition}**\n` +
        `**Funding time:** **${hit.fundingTime}**\n` +
        `**Scanned at:** **${hit.scannedAt}**\n` +
        `**Time rule:** **${hit.timeRule}**\n\n` +
        `**Source:** [${shortPk(hit.source)}](${solscanTransfersUrl(hit.source)})\n` +
        `**Amount from source:** **${hit.fundedSol.toFixed(3)} SOL**\n` +
        `**TX:** [Open on Solscan](${txLink})`
    )
    .setFooter({ text: "Solana White-ish Funding Scanner" })
    .setTimestamp(new Date());
}

function makeWalletButtons(hit) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel("Open Transfers").setStyle(ButtonStyle.Link).setURL(solscanTransfersUrl(hit.wallet)),
    new ButtonBuilder().setLabel("Open TX").setStyle(ButtonStyle.Link).setURL(solscanTxUrl(hit.sig))
  );
}

async function runScanAndRespond(target, wallets, source, minSol, timeHours, channelId) {
  const results = await mapLimit(wallets, CONCURRENCY, async (w) => {
    try {
      return await scanWalletWithSource(w, source, minSol, timeHours);
    } catch {
      return null;
    }
  });

  const hits = results.filter(Boolean);
  hits.sort((a, b) => b.fundedSol - a.fundedSol || b.balance - a.balance);

  const summary = makeSummaryEmbed({
    source,
    minSol,
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
    if (!interaction.isChatInputCommand()) return;

    const guildId = interaction.guildId;
    const channelId = interaction.channelId;
    if (!guildId || !channelId) return;

    // /show
    if (interaction.commandName === "show") {
      await interaction.deferReply();

      const source = getSourceForChannel(guildId, channelId);
      const minSol = getMinForChannel(guildId, channelId);
      const timeHours = getTimeForChannel(guildId, channelId);

      const e = new EmbedBuilder()
        .setTitle("⚙️ Current Config (This Channel)")
        .setColor(0x3498db)
        .setDescription(
          `**Channel:** <#${channelId}>\n` +
            `**Source:** ${source ? `[${source}](${solscanTransfersUrl(source)})` : "*chưa set*"}\n` +
            `**Min SOL:** **${minSol}**\n` +
            `**Time window:** **${timeHours} giờ**\n\n` +
            `Dùng:\n` +
            `- \`/source "wallet"\` (set pubkey)\n` +
            `- \`/source kucoin\`\n` +
            `- \`/source binance\`\n` +
            `- \`/source add <name> <pubkey>\`\n` +
            `- \`/source list\`\n` +
            `- \`/source del <name>\`\n` +
            `- \`/min sol:50\`\n` +
            `- \`/time hours:5\``
        )
        .setTimestamp(new Date());

      return interaction.editReply({ embeds: [e] });
    }

    // /source (preset + add/list/del + pubkey)
    if (interaction.commandName === "source") {
      await interaction.deferReply();

      const raw = interaction.options.getString("wallet") || "";
      const text = String(raw).trim().replace(/^"+|"+$/g, "");
      const tokens = text.split(/\s+/).filter(Boolean);
      const cmd = normalizeSourceInput(tokens[0] || "");

      // /source list
      if (cmd === "list") {
        const all = getAllPresets();
        const keys = Object.keys(all).sort();
        if (keys.length === 0) return interaction.editReply("⚠️ Chưa có preset nào.");

        const lines = keys.slice(0, 80).map((k) => `- **${k}** → \`${all[k]}\``);
        const more = keys.length > 80 ? `\n… và còn **${keys.length - 80}** preset nữa.` : "";

        const e = new EmbedBuilder()
          .setTitle("📌 Source Presets")
          .setColor(0x3498db)
          .setDescription(lines.join("\n") + more + `\n\nDùng: \`/source <name>\``)
          .setTimestamp(new Date());

        return interaction.editReply({ embeds: [e] });
      }

      // /source add <name> <pubkey>
      if (cmd === "add") {
        const name = normalizeSourceInput(tokens[1] || "");
        const pk = String(tokens[2] || "").trim().replace(/^"+|"+$/g, "");

        if (!name || !isValidPresetName(name)) {
          return interaction.editReply(
            "❌ Tên preset không hợp lệ.\n" +
              "Format: `/source add <name> <pubkey>`\n" +
              "Tên cho phép: a-z 0-9 và _ - . (2-32 ký tự)"
          );
        }
        if (!looksLikeSolPubkey(pk)) {
          return interaction.editReply("❌ Pubkey không hợp lệ.\nFormat: `/source add <name> <pubkey>`");
        }

        setPreset(name, pk);

        const e = new EmbedBuilder()
          .setTitle("✅ Preset Added")
          .setColor(0x2ecc71)
          .setDescription(`**Name:** **${name}**\n**Wallet:** \`${pk}\`\n\nDùng ngay: \`/source ${name}\``)
          .setTimestamp(new Date());

        return interaction.editReply({ embeds: [e] });
      }

      // /source del <name>
      if (cmd === "del" || cmd === "delete" || cmd === "rm" || cmd === "remove") {
        const name = normalizeSourceInput(tokens[1] || "");
        if (!name) return interaction.editReply("❌ Format: `/source del <name>`");

        const ok = delPreset(name);
        if (!ok) {
          return interaction.editReply(
            `⚠️ Không tìm thấy preset **${name}** trong user presets.\nTip: dùng \`/source list\` để xem danh sách.`
          );
        }
        return interaction.editReply(`✅ Đã xoá preset **${name}**.`);
      }

      // /source <presetName> OR /source <pubkey>
      const normalized = normalizeSourceInput(text);
      const presetWallet = getPreset(normalized);

      let source = presetWallet;
      if (!source) {
        const maybePk = text;
        if (!looksLikeSolPubkey(maybePk)) {
          return interaction.editReply(
            "❌ Source không hợp lệ.\n" +
              "Bạn có thể dùng:\n" +
              "- `/source <pubkey>`\n" +
              "- `/source <presetName>`\n" +
              "- `/source add <name> <pubkey>`\n" +
              "- `/source list`"
          );
        }
        source = maybePk;
      }

      setSourceForChannel(guildId, channelId, source);

      const presetHit = presetWallet ? ` (preset: **${normalized}**)` : "";

      const e = new EmbedBuilder()
        .setTitle("✅ Source Updated (This Channel)")
        .setColor(0x3498db)
        .setDescription(
          `**Channel:** <#${channelId}>\nSource:${presetHit}\n**${source}**\n\nLink: ${solscanTransfersUrl(source)}`
        )
        .setTimestamp(new Date());

      return interaction.editReply({ embeds: [e] });
    }

    // /min
    if (interaction.commandName === "min") {
      await interaction.deferReply();

      const v = Number(interaction.options.getNumber("sol"));
      if (!Number.isFinite(v) || v < 0) return interaction.editReply("❌ Min SOL không hợp lệ.");

      setMinForChannel(guildId, channelId, v);

      const e = new EmbedBuilder()
        .setTitle("✅ Min Updated (This Channel)")
        .setColor(0x9b59b6)
        .setDescription(`**Channel:** <#${channelId}>\nMin SOL: **${v} SOL**`)
        .setTimestamp(new Date());

      return interaction.editReply({ embeds: [e] });
    }

    // /time
    if (interaction.commandName === "time") {
      await interaction.deferReply();

      const h = Number(interaction.options.getNumber("hours"));
      if (!Number.isFinite(h) || h < 1 || h > 48) {
        return interaction.editReply("❌ Hours không hợp lệ (1 → 48).");
      }

      setTimeForChannel(guildId, channelId, h);

      const e = new EmbedBuilder()
        .setTitle("✅ Time Window Updated (This Channel)")
        .setColor(0xf39c12)
        .setDescription(`**Channel:** <#${channelId}>\nTime window: **${h} giờ** (2 tx cũ nhất)`)
        .setTimestamp(new Date());

      return interaction.editReply({ embeds: [e] });
    }

    // /scan
    if (interaction.commandName === "scan") {
      await interaction.deferReply();

      const source = getSourceForChannel(guildId, channelId);
      if (!source) {
        return interaction.editReply(`⚠️ Channel này chưa set source. Dùng: \`/source "YourSourceWallet"\``);
      }

      const minSol = getMinForChannel(guildId, channelId);
      const timeHours = getTimeForChannel(guildId, channelId);

      const w = interaction.options.getString("wallet").trim().replace(/^"+|"+$/g, "");
      if (!looksLikeSolPubkey(w)) return interaction.editReply("❌ Wallet không hợp lệ.");

      return runScanAndRespond(interaction, [w], source, minSol, timeHours, channelId);
    }

    // /scanlist
    if (interaction.commandName === "scanlist") {
      await interaction.deferReply();

      const source = getSourceForChannel(guildId, channelId);
      if (!source) {
        return interaction.editReply(`⚠️ Channel này chưa set source. Dùng: \`/source "YourSourceWallet"\``);
      }

      const minSol = getMinForChannel(guildId, channelId);
      const timeHours = getTimeForChannel(guildId, channelId);

      const key = waitKey(guildId, interaction.user.id, channelId);
      waiting.set(key, { expiresAt: Date.now() + 60_000, source, minSol, timeHours, channelId });

      const e = new EmbedBuilder()
        .setTitle("📝 Paste list hoặc upload .txt")
        .setColor(0xf1c40f)
        .setDescription(
          `**Channel:** <#${channelId}>\n` +
            `Trong **60 giây**, bạn có thể:\n` +
            `1) Paste list ví nhiều dòng, hoặc\n` +
            `2) Upload file **message.txt / .txt** (Discord auto tạo cũng được)\n\n` +
            `**Source:** ${shortPk(source)}\n` +
            `**Min:** ${minSol} SOL\n` +
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

    return runScanAndRespond(msg, wallets, w.source, w.minSol, w.timeHours, w.channelId);
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
    console.log(`💰 Default Min: ${DEFAULT_MIN_SOL} SOL`);
    console.log(`⏱ Default Time: ${DEFAULT_TIME_HOURS} hours`);
    console.log(`🧩 Config scope: PER CHANNEL`);
    console.log(`📎 scanlist: supports .txt attachment`);
    console.log(`📌 presets: /source list | /source add <name> <pubkey> | /source del <name>`);
  });

  await client.login(process.env.DISCORD_BOT_TOKEN);
})();
