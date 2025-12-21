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
const MAX_TXT_BYTES = 1_000_000; // 1MB

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
    GatewayIntentBits.Guil
