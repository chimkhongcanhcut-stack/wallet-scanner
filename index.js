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

const CONCURRENCY = 2; // scan nhẹ để đỡ rate
const REQUEST_TIMEOUT_MS = 20_000;

const STATE_FILE = path.join(__dirname, "state.json");
const DEFAULT_SOURCE = "";

// One-shot signatures fetch (no paginate)
const SIG_PAGE_LIMIT = 1000; // max getSignaturesForAddress

// txt attachment limits
const MAX_TXT_BYTES = 1_000_000; // 1MB

// ================== STATE (PER-CHANNEL) ==================
let state = { sources: {}, mins: {}, times: {}, presets: {}, oldestSigs: {} };

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
      if (!state || typeof state !== "object")
        state = { sources: {}, mins: {}, times: {}, presets: {}, oldestSigs: {} };

      if (!state.sources || typeof state.sources !== "object") state.sources = {};
      if (!state.mins || typeof state.mins !== "object") state.mins = {};
      if (!state.times || typeof state.times !== "object") state.times = {};
      if (!state.presets || typeof state.presets !== "object") state.presets = {};
      if (!state.oldestSigs || typeof state.oldestSigs !== "object") state.oldestSigs = {};
    }
  } catch {
    state = { sources: {}, mins: {}, times: {}, presets: {}, oldestSigs: {} };
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

// ================== OLDEST SIG CACHE ==================
// state.oldestSigs[wallet] = { sig, blockTime } OR { marker: "TOO_MANY_TX"|"TOO_OLD"|"NO_HISTORY", blockTime?, sig? }
function getCachedOldest(wallet) {
  const v = state.oldestSigs?.[wallet];
  if (!v || typeof v !== "object") return null;
  if (v.marker && typeof v.marker === "string") return v;
  if (v.sig && typeof v.sig === "string") return v;
  return null;
}
function setCachedOldest(wallet, obj) {
  if (!state.oldestSigs || typeof state.oldestSigs !== "object") state.oldestSigs = {};
  state.oldestSigs[wallet] = obj;
  saveState();
}
function clearOldestCacheAll() {
  state.oldestSigs = {};
  saveState();
}
function clearOldestCacheWallets(wallets) {
  if (!state.oldestSigs || typeof state.oldestSigs !== "object") state.oldestSigs = {};
  let removed = 0;
  for (const w of wallets) {
    if (state.oldestSigs[w]) {
      delete state.oldestSigs[w];
      removed++;
    }
  }
  saveState();
  return removed;
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
function nowSec() {
  return Math.floor(Date.now() / 1000);
}
function isOlderThanWindow(blockTime, timeHours) {
  if (!blockTime || !Number.isFinite(blockTime)) return false; // unknown => can't skip
  const maxAge = Math.floor(Number(timeHours) * 3600);
  return nowSec() - blockTime > maxAge;
}

// ================== RATE LIMIT ERROR ==================
class RateLimitError extends Error {
  constructor(message) {
    super(message);
    this.name = "RateLimitError";
    this.isRateLimit = true;
  }
}
function isRateLimitMessage(msg) {
  const m = String(msg || "").toLowerCase();
  return m.includes("rate limit") || m.includes("too many requests") || m.includes("429");
}

// ================== RPC HELPERS ==================
let RPC_ID = 1;

async function rpc(method, params) {
  const res = await axios.post(
    RPC_URL,
    { jsonrpc: "2.0", id: RPC_ID++, method, params },
    {
      timeout: REQUEST_TIMEOUT_MS,
      headers: { "Content-Type": "application/json" },
      validateStatus: () => true,
    }
  );

  // HTTP rate limit
  if (res.status === 429) throw new RateLimitError(`Rate limited (HTTP 429) on ${method}`);

  // Some providers return 200 but error.message contains rate limit
  if (res.data?.error?.message && isRateLimitMessage(res.data.error.message)) {
    throw new RateLimitError(`Rate limited on ${method}: ${res.data.error.message}`);
  }

  if (!res.data) throw new Error(`RPC empty response for ${method}`);
  if (res.data.error) throw new Error(res.data.error.message || "RPC error");
  return res.data.result;
}

async function getSignatures(address, limit = 50, before = null) {
  const cfg = { limit };
  if (before) cfg.before = before;
  return rpc("getSignaturesForAddress", [address, cfg]);
}

async function getTx(signature) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await rpc("getTransaction", [
        signature,
        { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 },
      ]);
    } catch (e) {
      if (e?.isRateLimit) throw e;
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

// ================== OPTIMIZED: FIND OLDEST (ONE CALL) + CACHE + TIME WINDOW SKIP ==================
async function findOldestCached(address, timeHours) {
  const cached = getCachedOldest(address);
  if (cached) {
    // if cached sig has blockTime and now too old -> convert to TOO_OLD
    if (cached.sig && cached.blockTime && isOlderThanWindow(cached.blockTime, timeHours)) {
      const obj = { marker: "TOO_OLD", blockTime: cached.blockTime, sig: cached.sig };
      setCachedOldest(address, obj);
      return obj;
    }
    return cached;
  }

  const first = await getSignatures(address, SIG_PAGE_LIMIT, null);
  if (!Array.isArray(first) || first.length === 0) {
    const obj = { marker: "NO_HISTORY" };
    setCachedOldest(address, obj);
    return obj;
  }

  if (first.length === SIG_PAGE_LIMIT) {
    const obj = { marker: "TOO_MANY_TX" };
    setCachedOldest(address, obj);
    return obj;
  }

  const last = first[first.length - 1];
  const sig = last?.signature || null;
  const bt = Number.isFinite(last?.blockTime) ? last.blockTime : null;

  if (bt && isOlderThanWindow(bt, timeHours)) {
    const obj = { marker: "TOO_OLD", blockTime: bt, sig };
    setCachedOldest(address, obj);
    return obj;
  }

  const obj = { sig, blockTime: bt };
  setCachedOldest(address, obj);
  return obj;
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
async function mapLimit(arr, limit, fn, shouldStop) {
  const ret = new Array(arr.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, arr.length) }, () =>
    (async () => {
      while (true) {
        if (shouldStop && shouldStop()) break;
        const idx = i++;
        if (idx >= arr.length) break;
        if (shouldStop && shouldStop()) break;
        ret[idx] = await fn(arr[idx], idx);
      }
    })()
  );
  await Promise.allSettled(workers);
  return ret;
}

// ================== SCAN LOGIC ==================
async function scanWalletWithSource(wallet, sourceWallet, minSol, timeHours) {
  const info = await findOldestCached(wallet, timeHours);

  if (info.marker === "NO_HISTORY") {
    console.log(`[WHITE] ${wallet} -> NO HISTORY`);
    return null;
  }
  if (info.marker === "TOO_MANY_TX") {
    console.log(`[WHITE] ${wallet} -> SKIP (too many tx, first page=1000)`);
    return null;
  }
  if (info.marker === "TOO_OLD") {
    console.log(
      `[WHITE] ${wallet} -> SKIP (oldest too old) bt=${info.blockTime || "N/A"} window=${timeHours}h sig=${info.sig || "-"}`
    );
    return null;
  }

  const oldestSig = info.sig;
  if (!oldestSig) {
    console.log(`[WHITE] ${wallet} -> NO OLDEST SIG`);
    return null;
  }

  const tx = await getTx(oldestSig);
  const blockTime = tx?.blockTime || info.blockTime || null;

  // time window check again (covers signature blockTime null)
  if (blockTime && isOlderThanWindow(blockTime, timeHours)) {
    console.log(`[WHITE] ${wallet} -> SKIP (oldest too old after tx) bt=${blockTime} window=${timeHours}h`);
    setCachedOldest(wallet, { marker: "TOO_OLD", blockTime, sig: oldestSig });
    return null;
  }

  const transfers = extractSystemTransfers(tx);

  for (const tr of transfers) {
    if (tr.from !== sourceWallet) continue;
    if (tr.to !== wallet) continue;

    const sol = lamportsToSol(tr.lamports);
    if (sol < minSol) continue;

    const balance = await getSolBalance(wallet);

    console.log(
      `[WHITE] ✅ MATCH wallet=${wallet} oldestSig=${oldestSig} time=${blockTime} amount=${sol.toFixed(4)} SOL`
    );

    setCachedOldest(wallet, { sig: oldestSig, blockTime });

    return {
      wallet,
      balance,
      source: sourceWallet,
      fundedSol: sol,
      sig: oldestSig,
      fundingTime: formatTime(blockTime),
      scannedAt: scanNowStr(),
      txCondition: "TX CŨ NHẤT là funding từ Source",
      timeRule: `${timeHours} giờ`,
    };
  }

  console.log(`[WHITE] ❌ NOT wallet=${wallet} oldestSig=${oldestSig} time=${blockTime}`);
  setCachedOldest(wallet, { sig: oldestSig, blockTime });
  return null;
}

// ================== PRETTY OUTPUT ==================
function makeSummaryEmbed({ source, minSol, timeHours, scannedCount, hitCount, channelId, stoppedReason }) {
  const color = stoppedReason ? 0xe67e22 : hitCount > 0 ? 0x2ecc71 : 0x95a5a6;
  const title = stoppedReason
    ? "⛔ Scan Stopped (Rate Limit)"
    : "🔎 Scan Result (Oldest TX + Time Window + Cache)";

  const extra = stoppedReason
    ? `\n\n⚠️ **Stopped:** ${stoppedReason}\n👉 Hãy giảm list / đợi vài phút / đổi RPC xịn hơn.`
    : "";

  return new EmbedBuilder()
    .setTitle(title)
    .setColor(color)
    .setDescription(
      `**Channel:** <#${channelId}>\n` +
        `**Source:** ${source ? `[${shortPk(source)}](${solscanTransfersUrl(source)})` : "*chưa set*"}\n` +
        `**Min amount:** **${minSol} SOL**\n` +
        `**Time window:** **${timeHours} giờ**\n` +
        `**Rule:** TX cũ nhất phải là funding từ Source\n` +
        `**Scanned:** **${scannedCount}** • **Matched:** **${hitCount}**\n` +
        `**Scan time:** **${scanNowStr()}**` +
        extra
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
        `**Rule:** **${hit.txCondition}**\n` +
        `**Oldest TX time:** **${hit.fundingTime}**\n` +
        `**Time window:** **${hit.timeRule}**\n` +
        `**Scanned at:** **${hit.scannedAt}**\n\n` +
        `**Source:** [${shortPk(hit.source)}](${solscanTransfersUrl(hit.source)})\n` +
        `**Amount from source:** **${hit.fundedSol.toFixed(3)} SOL**\n` +
        `**TX:** [Open on Solscan](${txLink})`
    )
    .setFooter({ text: "Solana White Funding Scanner (Oldest + Time Window + Cache)" })
    .setTimestamp(new Date());
}

function makeWalletButtons(hit) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel("Open Transfers").setStyle(ButtonStyle.Link).setURL(solscanTransfersUrl(hit.wallet)),
    new ButtonBuilder().setLabel("Open TX").setStyle(ButtonStyle.Link).setURL(solscanTxUrl(hit.sig))
  );
}

async function sendStoppedMessage(target, reason) {
  const msg = `⚠️ **Rate limit hit** → bot đã **dừng scan**.\n**Reason:** ${reason}`;
  try {
    if ("followUp" in target) return await target.followUp({ content: msg });
    if ("channel" in target && target.channel) return await target.channel.send({ content: msg });
    if ("reply" in target) return await target.reply({ content: msg });
  } catch {}
}

async function runScanAndRespond(target, wallets, source, minSol, timeHours, channelId) {
  let stoppedReason = "";
  let scannedSoFar = 0;

  const shouldStop = () => Boolean(stoppedReason);

  const results = await mapLimit(
    wallets,
    CONCURRENCY,
    async (w) => {
      if (shouldStop()) return null;
      scannedSoFar++;

      try {
        return await scanWalletWithSource(w, source, minSol, timeHours);
      } catch (e) {
        if (e?.isRateLimit || e?.name === "RateLimitError") {
          stoppedReason = e.message || "Rate limit";
          console.log(`[WHITE] ⛔ STOP: ${stoppedReason}`);
          return null;
        }
        console.log(`[WHITE] ⚠️ ERROR wallet=${w}: ${e.message}`);
        return null;
      }
    },
    shouldStop
  );

  const hits = (results || []).filter(Boolean);
  hits.sort((a, b) => b.fundedSol - a.fundedSol || b.balance - a.balance);

  const summary = makeSummaryEmbed({
    source,
    minSol,
    timeHours,
    scannedCount: stoppedReason ? scannedSoFar : wallets.length,
    hitCount: hits.length,
    channelId,
    stoppedReason: stoppedReason || "",
  });

  // send summary
  if ("editReply" in target) {
    await target.editReply({ content: hits.length > 0 ? "@everyone" : "", embeds: [summary] });
  } else {
    await target.reply({ content: hits.length > 0 ? "@everyone" : "", embeds: [summary] });
  }

  // if stopped => notify explicitly
  if (stoppedReason) {
    await sendStoppedMessage(target, stoppedReason);
    return;
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
    // AUTOCOMPLETE (/source wallet)
    if (interaction.isAutocomplete()) {
      if (interaction.commandName !== "source") return;

      const focused = interaction.options.getFocused(true);
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
            `**Time window:** **${timeHours} giờ**\n` +
            `**Rule:** TX cũ nhất phải là funding từ Source\n\n` +
            `Dùng:\n` +
            `- \`/source wallet:<pubkey>\` hoặc \`/source wallet:<presetName>\`\n` +
            `- \`/preset add/del/list\`\n` +
            `- \`/min sol:50\`\n` +
            `- \`/time hours:5\`\n` +
            `- \`/scan wallet:<wallet>\`\n` +
            `- \`/scanlist\`\n` +
            `- \`/cacheclear\``
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
            `- Pubkey: \`/source wallet:5tzF...\`\n` +
            `- Preset: \`/source wallet:kucoin\`\n` +
            `- Quản lý: \`/preset add/del/list\``
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

    // /cacheclear
    if (interaction.commandName === "cacheclear") {
      await interaction.deferReply({ ephemeral: true });

      const mode = interaction.options.getString("mode") || "channel";

      if (mode === "all") {
        clearOldestCacheAll();
        return interaction.editReply("✅ Đã xoá **toàn bộ** cache `oldestSigs`.");
      }

      // channel mode: xoá cache của những wallet đang nằm trong channel config? (không có list persistent)
      // => Cho người dùng nhập list wallet (optional) hoặc xoá all (đã có)
      // Ở đây mình làm: nếu mode=channel thì xoá cache những wallet user gửi qua option "wallets" (nếu có),
      // còn không thì báo cách dùng.
      const raw = interaction.options.getString("wallets") || "";
      const wallets = raw ? [...new Set(parseWallets(raw))] : [];

      if (wallets.length === 0) {
        return interaction.editReply(
          "⚠️ Mode `channel` cần nhập option `wallets` (paste nhiều dòng) để xoá cache cho đúng ví.\n" +
            "Hoặc chọn `mode:all` để xoá hết."
        );
      }

      const removed = clearOldestCacheWallets(wallets);
      return interaction.editReply(`✅ Đã xoá cache cho **${removed}/${wallets.length}** ví.`);
    }

    // /scan
    if (interaction.commandName === "scan") {
      await interaction.deferReply();

      const source = getSourceForChannel(guildId, channelId);
      if (!source) return interaction.editReply(`⚠️ Chưa set source. Dùng: \`/source wallet:YourSourceWallet\``);

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
      if (!source) return interaction.editReply(`⚠️ Chưa set source. Dùng: \`/source wallet:YourSourceWallet\``);

      const minSol = getMinForChannel(guildId, channelId);
      const timeHours = getTimeForChannel(guildId, channelId);

      const key = waitKey(guildId, interaction.user.id, channelId);
      waiting.set(key, { expiresAt: Date.now() + 60_000, source, minSol, timeHours, channelId });

      const e = new EmbedBuilder()
        .setTitle("📝 Paste list hoặc upload .txt")
        .setColor(0xf1c40f)
        .setDescription(
          `**Channel:** <#${channelId}>\n` +
            `Trong **60 giây**, bạn có thể paste list ví hoặc upload file .txt\n\n` +
            `**Source:** ${shortPk(source)}\n` +
            `**Min:** ${minSol} SOL\n` +
            `**Time window:** ${timeHours} giờ\n` +
            `**Rule:** TX cũ nhất phải là funding từ Source\n\n` +
            `Ví dụ:\n\`wallet1\nwallet2\nwallet3\``
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
    await msg.reply(`${srcHint}\n⏳ Đang scan **${wallets.length}** ví... (log ra console luôn)`);

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
    console.log(`✨ autocomplete: /source wallet:<presetName>`);
    console.log(`🧠 Logic: OLDEST TX funding from SOURCE + time window`);
    console.log(`⛔ Stop scan on rate limit + send Discord message`);
    console.log(`💾 Cache: state.oldestSigs enabled`);
  });

  await client.login(process.env.DISCORD_BOT_TOKEN);
})();
