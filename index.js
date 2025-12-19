require("dotenv").config();
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { Worker } = require("worker_threads");
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  Partials,
  Events,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} = require("discord.js");

// ================== HARD LOG ==================
process.on("unhandledRejection", (err) => console.error("❌ unhandledRejection:", err));
process.on("uncaughtException", (err) => console.error("❌ uncaughtException:", err));

const EPHEMERAL_FLAG = MessageFlags?.Ephemeral ?? (1 << 6);

// ================== CONFIG ==================
const RPC_URL = process.env.RPC_URL;

const DEFAULT_MIN_SOL = 50;
const DEFAULT_TIME_HOURS = 5;

const SIG_FETCH_LIMIT = 120;
const CONCURRENCY = 6;
const REQUEST_TIMEOUT_MS = 20_000;

const STATE_FILE = path.join(__dirname, "state.json");
const DEFAULT_SOURCE = "";
const MAX_TXT_BYTES = 1_000_000;

// ================== STATE (PER-CHANNEL) ==================
let state = { sources: {}, mins: {}, times: {} };

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
      if (!state || typeof state !== "object") state = { sources: {}, mins: {}, times: {} };
      if (!state.sources || typeof state.sources !== "object") state.sources = {};
      if (!state.mins || typeof state.mins !== "object") state.mins = {};
      if (!state.times || typeof state.times !== "object") state.times = {};
    }
  } catch {
    state = { sources: {}, mins: {}, times: {} };
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

// ================== SAFE INTERACTION HELPERS ==================
// ❗ KEY FIX: ACK-first, KHÔNG await để tránh bị trễ do event loop / network spike
function ackNow(interaction) {
  if (!interaction || interaction.deferred || interaction.replied) return;
  interaction.deferReply({ ephemeral: false }).catch((e) => {
    // chỉ log, không fallback nữa vì fallback cũng sẽ 10062 nếu đã trễ
    console.error("❌ deferReply failed:", { code: e?.code, message: e?.message, name: e?.name });
  });
}

async function safeEdit(interaction, payload) {
  try {
    if (interaction && (interaction.deferred || interaction.replied)) {
      return await interaction.editReply(payload);
    }
  } catch (e) {
    console.error("❌ editReply failed:", { code: e?.code, message: e?.message, name: e?.name });
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
    throw new Error(`File quá lớn (${Math.round(size / 1024)}KB). Max ~${Math.round(MAX_TXT_BYTES / 1024)}KB.`);
  }
  const res = await axios.get(att.url, { responseType: "text", timeout: REQUEST_TIMEOUT_MS });
  if (typeof res.data !== "string") throw new Error("Không đọc được nội dung file text.");
  return res.data;
}

// ================== EMBEDS ==================
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

// ================== WORKER SCAN (tách khỏi main thread) ==================
function runScanInWorker({ wallets, source, minSol, timeHours }) {
  return new Promise((resolve, reject) => {
    const workerCode = `
      const axios = require("axios");
      const { parentPort, workerData } = require("worker_threads");

      const RPC_URL = workerData.RPC_URL;
      const SIG_FETCH_LIMIT = workerData.SIG_FETCH_LIMIT;
      const CONCURRENCY = workerData.CONCURRENCY;
      const REQUEST_TIMEOUT_MS = workerData.REQUEST_TIMEOUT_MS;

      function scanNowStr() {
        return new Date().toLocaleString("vi-VN", { timeZone: "Asia/Bangkok" });
      }
      function formatTime(blockTime) {
        if (!blockTime) return "N/A";
        return new Date(blockTime * 1000).toLocaleString("vi-VN", { timeZone: "Asia/Bangkok" });
      }
      function lamportsToSol(l) { return l / 1_000_000_000; }

      async function rpc(method, params) {
        const res = await axios.post(
          RPC_URL,
          { jsonrpc: "2.0", id: 1, method, params },
          { timeout: REQUEST_TIMEOUT_MS, headers: { "Content-Type": "application/json" }, validateStatus: () => true }
        );
        if (!res.data) throw new Error(\`RPC empty response for \${method}\`);
        if (res.data.error) throw new Error(res.data.error.message || "RPC error");
        return res.data.result;
      }
      async function getSignatures(address, limit = 50) {
        return rpc("getSignaturesForAddress", [address, { limit }]);
      }
      async function getTx(signature) {
        for (let attempt = 1; attempt <= 2; attempt++) {
          try {
            return await rpc("getTransaction", [ signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 } ]);
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

      async function scanWalletWithSource(wallet, sourceWallet, minSol, timeHours) {
        const sigs = await getSignatures(wallet, SIG_FETCH_LIMIT);
        if (!Array.isArray(sigs) || sigs.length === 0) return null;

        const oldestTwo = sigs.slice(-2);

        const txs = await Promise.all(
          oldestTwo.map(async (s) => {
            const sig = s.signature;
            const tx = await getTx(sig);
            const transfers = extractSystemTransfers(tx);
            return { sig, blockTime: tx?.blockTime || null, isTransferTx: transfers.length > 0, transfers };
          })
        );

        const nowSec = Math.floor(Date.now() / 1000);
        const maxAgeSec = Math.floor(timeHours * 3600);
        for (const t of txs) {
          if (!t.blockTime) return null;
          if (nowSec - t.blockTime > maxAgeSec) return null;
        }

        const isCond1 = sigs.length === 1 && txs[0]?.isTransferTx === true;
        const isCond2 = sigs.length >= 2 && txs.length >= 2 && txs[0].isTransferTx && txs[1].isTransferTx;
        if (!isCond1 && !isCond2) return null;

        for (const t of txs) {
          for (const tr of t.transfers) {
            if (tr.from !== sourceWallet) continue;
            if (tr.to !== wallet) continue;

            const sol = lamportsToSol(tr.lamports);
            if (sol < minSol) continue;

            const balance = await getSolBalance(wallet);

            return {
              wallet, balance, source: sourceWallet, fundedSol: sol, sig: t.sig,
              fundingTime: formatTime(t.blockTime),
              scannedAt: scanNowStr(),
              txCondition: isCond1 ? "Điều kiện 1 (1 tx đầu là transfer)" : "Điều kiện 2 (2 tx đầu đều transfer)",
              timeRule: \`\${timeHours} giờ\`,
            };
          }
        }

        return null;
      }

      (async () => {
        const { wallets, source, minSol, timeHours } = workerData.job;
        const results = await mapLimit(wallets, CONCURRENCY, async (w) => {
          try { return await scanWalletWithSource(w, source, minSol, timeHours); }
          catch { return null; }
        });
        const hits = results.filter(Boolean);
        hits.sort((a, b) => (b.fundedSol - a.fundedSol) || (b.balance - a.balance));
        parentPort.postMessage({ ok: true, hits });
      })().catch((e) => parentPort.postMessage({ ok: false, error: e?.message || String(e) }));
    `;

    const worker = new Worker(workerCode, {
      eval: true,
      workerData: {
        RPC_URL,
        SIG_FETCH_LIMIT,
        CONCURRENCY,
        REQUEST_TIMEOUT_MS,
        job: { wallets, source, minSol, timeHours },
      },
    });

    worker.on("message", (msg) => (msg?.ok ? resolve(msg.hits || []) : reject(new Error(msg?.error || "Worker error"))));
    worker.on("error", reject);
    worker.on("exit", (code) => {
      if (code !== 0) reject(new Error("Worker exited with code " + code));
    });
  });
}

// ================== SIMPLE QUEUE (đỡ nghẽn main) ==================
const jobQueue = [];
let jobRunning = 0;
const MAX_JOBS = 1;

async function enqueueJob(fn) {
  return new Promise((resolve, reject) => {
    jobQueue.push({ fn, resolve, reject });
    pumpQueue();
  });
}
function pumpQueue() {
  if (jobRunning >= MAX_JOBS) return;
  const item = jobQueue.shift();
  if (!item) return;

  jobRunning++;
  item.fn()
    .then((x) => item.resolve(x))
    .catch((e) => item.reject(e))
    .finally(() => {
      jobRunning--;
      pumpQueue();
    });
}

// ================== RESPOND ==================
async function runScanAndRespond(target, wallets, source, minSol, timeHours, channelId) {
  const hits = await enqueueJob(() => runScanInWorker({ wallets, source, minSol, timeHours }));

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
const waiting = new Map();
function waitKey(guildId, userId, channelId) {
  return `${guildId}:${userId}:${channelId}`;
}

// ================== INTERACTIONS ==================
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  // ACK IMMEDIATELY (không await)
  ackNow(interaction);

  // xử lý sau tick để nhường event loop
  setImmediate(async () => {
    try {
      const guildId = interaction.guildId;
      const channelId = interaction.channelId;
      if (!guildId || !channelId) {
        return safeEdit(interaction, {
          content: "❌ Lệnh này chỉ dùng trong SERVER (không dùng DM).",
          flags: EPHEMERAL_FLAG,
        });
      }

      if (interaction.commandName === "show") {
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
              `**Time window:** **${timeHours} giờ**`
          )
          .setTimestamp(new Date());

        return safeEdit(interaction, { embeds: [e] });
      }

      if (interaction.commandName === "source") {
        const raw = interaction.options.getString("wallet") || "";
        const source = raw.trim().replace(/^"+|"+$/g, "");
        if (!looksLikeSolPubkey(source)) {
          return safeEdit(interaction, { content: "❌ Source wallet không hợp lệ (pubkey Solana)." });
        }
        setSourceForChannel(guildId, channelId, source);

        return safeEdit(interaction, {
          embeds: [
            new EmbedBuilder()
              .setTitle("✅ Source Updated (This Channel)")
              .setColor(0x3498db)
              .setDescription(`**${source}**\n${solscanTransfersUrl(source)}`)
              .setTimestamp(new Date()),
          ],
        });
      }

      if (interaction.commandName === "min") {
        const v = Number(interaction.options.getNumber("sol"));
        if (!Number.isFinite(v) || v < 0) return safeEdit(interaction, { content: "❌ Min SOL không hợp lệ." });
        setMinForChannel(guildId, channelId, v);
        return safeEdit(interaction, { content: `✅ Min SOL set: **${v}**` });
      }

      if (interaction.commandName === "time") {
        const h = Number(interaction.options.getNumber("hours"));
        if (!Number.isFinite(h) || h < 1 || h > 48) return safeEdit(interaction, { content: "❌ Hours không hợp lệ (1 → 48)." });
        setTimeForChannel(guildId, channelId, h);
        return safeEdit(interaction, { content: `✅ Time window set: **${h} giờ**` });
      }

      if (interaction.commandName === "scan") {
        const source = getSourceForChannel(guildId, channelId);
        if (!source) return safeEdit(interaction, { content: `⚠️ Chưa set source. Dùng: \`/source "YourSourceWallet"\`` });

        const minSol = getMinForChannel(guildId, channelId);
        const timeHours = getTimeForChannel(guildId, channelId);

        const wRaw = interaction.options.getString("wallet") || "";
        const w = wRaw.trim().replace(/^"+|"+$/g, "");
        if (!looksLikeSolPubkey(w)) return safeEdit(interaction, { content: "❌ Wallet không hợp lệ." });

        await safeEdit(interaction, { content: "⏳ Đang scan 1 ví..." });
        return runScanAndRespond(interaction, [w], source, minSol, timeHours, channelId);
      }

      if (interaction.commandName === "scanlist") {
        const source = getSourceForChannel(guildId, channelId);
        if (!source) return safeEdit(interaction, { content: `⚠️ Chưa set source. Dùng: \`/source "YourSourceWallet"\`` });

        const minSol = getMinForChannel(guildId, channelId);
        const timeHours = getTimeForChannel(guildId, channelId);

        const key = waitKey(guildId, interaction.user.id, channelId);
        waiting.set(key, { expiresAt: Date.now() + 60_000, source, minSol, timeHours, channelId });

        const e = new EmbedBuilder()
          .setTitle("📝 Paste list hoặc upload .txt")
          .setColor(0xf1c40f)
          .setDescription(
            `Trong **60 giây**, bạn có thể paste list hoặc upload **.txt**.\n\n` +
              `**Source:** ${shortPk(source)}\n**Min:** ${minSol} SOL\n**Time:** ${timeHours} giờ`
          )
          .setTimestamp(new Date());

        return safeEdit(interaction, { embeds: [e], content: "" });
      }

      return safeEdit(interaction, { content: "⚠️ Command chưa được handle." });
    } catch (e) {
      return safeEdit(interaction, { content: `❌ Lỗi: ${e.message}` });
    }
  });
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
    if (wallets.length === 0) return msg.reply("❌ Không thấy ví nào.");

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
    console.log(`🧵 Worker scan: ON + Queue MAX_JOBS=${MAX_JOBS}`);
  });

  await client.login(process.env.DISCORD_BOT_TOKEN);
})();
