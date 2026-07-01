const dotenv = require("dotenv");
const path   = require("path");
const { randomUUID } = require("crypto");

dotenv.config({ path: path.join(__dirname, ".env") });

// ============================================================
// KONFIGURASI (diambil dari .env)
// ============================================================
const CONFIG = {
  INIT_DATA:                process.env.INIT_DATA                || "",
  CLAIM_INTERVAL_MS:        parseInt(process.env.CLAIM_INTERVAL_MS)        || 5 * 60 * 1000,
  ENERGY_BOOST_INTERVAL_MS: parseInt(process.env.ENERGY_BOOST_INTERVAL_MS) || 60 * 1000,
  AUTO_LOOP:                process.env.AUTO_LOOP !== "false",
  VERBOSE:                  process.env.VERBOSE  === "true",
};

const BASE_URL = "https://crmnetwork.xyz";

// Endpoint _serverFn hashes
const ENDPOINTS = {
  USER_INFO:     "2e857a8661ed051f72427143277d80bab9f7d7a3291576d0e9fc51f1a8bfdd99",
  BALANCE:       "62fb8cd3427e2b52cffe2025ec235b259a81792855f4e7d0716f7a8933e9ee37",
  MINING_INFO:   "fc967ad9a5b58a3fd84158416b350eae78b234193fd87cf470404f1abb25f8dd",
  TASKS:         "446960a3fbdbc9a29426b8959570689c2b86c6834efb5fbba8ad57cac670c474",
  REFERRAL:      "315599a52f04634a5fca4d465bc9186d48c8242f29b3c7bd621bfd46536f35e7",
  CLAIM:         "300377a39126958995cb42ba5717a5e58e7cacfe3d7893249b420ebb732a1899",
  ENERGY_BOOST:  "3d59b269221e6b3d20bda06446edbc61c15c0a38818fdbe5a0bb71e01fb9ba3f",
};

// ============================================================
// HTTP HELPERS
// ============================================================
function getHeaders(withBody = false) {
  const h = {
    "accept":          "application/x-tss-framed, application/x-ndjson, application/json",
    "accept-language": "en-US,en;q=0.9",
    "origin":          "https://crmnetwork.xyz",
    "referer":         "https://crmnetwork.xyz/",
    "user-agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
    "x-tsr-serverfn":  "true",
  };
  if (withBody) h["content-type"] = "application/json";
  return h;
}

function makeBody(initData, extraKeys = [], extraVals = []) {
  return JSON.stringify({
    t: {
      t: 10, i: 0,
      p: {
        k: ["data"],
        v: [{
          t: 10, i: 1,
          p: {
            k: ["_initData", ...extraKeys],
            v: [{ t: 1, s: initData }, ...extraVals],
          },
          o: 0,
        }],
      },
      o: 0,
    },
    f: 63, m: [],
  });
}

async function callEndpoint(hash, initData, extraKeys = [], extraVals = []) {
  const url = `${BASE_URL}/_serverFn/${hash}`;
  try {
    const res  = await fetch(url, {
      method:  "POST",
      headers: getHeaders(true),
      body:    makeBody(initData, extraKeys, extraVals),
    });
    const text = await res.text();
    if (CONFIG.VERBOSE) {
      console.log(`  [${hash.slice(0, 8)}...] HTTP ${res.status}`);
      console.log("  Response:", text.slice(0, 500));
    }
    try {
      const parsed = text.trim().split("\n").filter(Boolean).map(l => JSON.parse(l));
      return { ok: res.ok, status: res.status, data: parsed };
    } catch {
      return { ok: res.ok, status: res.status, raw: text };
    }
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ============================================================
// ACTIONS
// ============================================================
async function getUserInfo(initData) {
  process.stdout.write("  📊 User info... ");
  const r = await callEndpoint(ENDPOINTS.USER_INFO, initData);
  console.log(r.ok ? "✅" : `❌ (${r.status || r.error})`);
  return r;
}

async function getMiningInfo(initData) {
  process.stdout.write("  ⛏️  Mining info... ");
  const r = await callEndpoint(ENDPOINTS.MINING_INFO, initData);
  console.log(r.ok ? "✅" : `❌ (${r.status || r.error})`);
  return r;
}

async function getBalance(initData) {
  process.stdout.write("  💰 Balance... ");
  const r = await callEndpoint(ENDPOINTS.BALANCE, initData);
  console.log(r.ok ? "✅" : `❌ (${r.status || r.error})`);
  return r;
}

async function claimReward(initData) {
  const key = randomUUID();
  process.stdout.write(`  🎯 Claim (key: ${key.slice(0, 8)}...)... `);
  const r = await callEndpoint(
    ENDPOINTS.CLAIM,
    initData,
    ["idempotency_key"],
    [{ t: 1, s: key }]
  );
  if (r.ok) {
    console.log("✅ BERHASIL!");
    if (CONFIG.VERBOSE) console.log("  Data:", JSON.stringify(r.data, null, 2));
    else {
      const flat = JSON.stringify(r.data || r.raw || "");
      if (/reward|token|amount|balance/i.test(flat)) {
        console.log("  📦", flat.slice(0, 300));
      }
    }
  } else {
    console.log(`❌ GAGAL (${r.status || r.error})`);
    if (r.raw) console.log("  Detail:", r.raw.slice(0, 300));
  }
  return r;
}

async function energyBoost(initData) {
  process.stdout.write("  ⚡ Energy Boost... ");
  const r = await callEndpoint(ENDPOINTS.ENERGY_BOOST, initData);
  if (r.ok) {
    console.log("✅ BERHASIL!");
    if (CONFIG.VERBOSE) console.log("  Data:", JSON.stringify(r.data, null, 2));
    else {
      const flat = JSON.stringify(r.data || r.raw || "");
      if (/energy|boost|power|mana/i.test(flat)) {
        console.log("  ⚡", flat.slice(0, 300));
      }
    }
  } else {
    console.log(`❌ GAGAL (${r.status || r.error})`);
    if (r.raw) console.log("  Detail:", r.raw.slice(0, 300));
  }
  return r;
}

// ============================================================
// UTILS
// ============================================================
function timestamp() {
  return new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });
}

function formatDuration(ms) {
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

// Countdown timer di terminal
function startCountdown(label, totalMs, onDone) {
  let remaining = Math.floor(totalMs / 1000);
  const id = setInterval(() => {
    remaining--;
    if (remaining <= 0) {
      clearInterval(id);
      onDone();
    }
  }, 1000);
  return id;
}

// ============================================================
// SIKLUS
// ============================================================
async function runClaimCycle(initData) {
  console.log(`\n┌─ [${timestamp()}] 🔄 CLAIM CYCLE`);
  await getUserInfo(initData);
  await getMiningInfo(initData);
  await claimReward(initData);
  await getBalance(initData);
  console.log(`└─ Selesai`);
}

async function runBoostCycle(initData) {
  process.stdout.write(`\n[${timestamp()}] `);
  await energyBoost(initData);
}

// ============================================================
// MAIN
// ============================================================
async function main() {
  console.log("╔══════════════════════════════════════════════╗");
  console.log("║    CRM Network By 19Seniman  ║");
  console.log("╚══════════════════════════════════════════════╝");

  if (!CONFIG.INIT_DATA || CONFIG.INIT_DATA.includes("GANTI_DENGAN_PUNYA_KAMU")) {
    console.error("\n❌ ERROR: INIT_DATA belum diisi!");
    console.error("   1. Salin .env.example menjadi .env");
    console.error("   2. Isi nilai INIT_DATA dengan initData dari akun Telegram kamu");
    console.error("   3. Jalankan ulang script ini\n");
    process.exit(1);
  }

  console.log("\n📋 Konfigurasi:");
  console.log(`   INIT_DATA      : ${CONFIG.INIT_DATA.slice(0, 40)}...`);
  console.log(`   AUTO_LOOP      : ${CONFIG.AUTO_LOOP}`);
  console.log(`   Claim interval : setiap ${formatDuration(CONFIG.CLAIM_INTERVAL_MS)}`);
  console.log(`   Energy Boost   : setiap ${formatDuration(CONFIG.ENERGY_BOOST_INTERVAL_MS)}`);
  console.log(`   VERBOSE        : ${CONFIG.VERBOSE}`);
  console.log("\n" + "─".repeat(48));

  const initData = CONFIG.INIT_DATA;

  // Jalankan claim pertama langsung
  await runClaimCycle(initData);

  // Jalankan boost pertama langsung
  await runBoostCycle(initData);

  if (!CONFIG.AUTO_LOOP) return;

  console.log(`\n⏰ Scheduler aktif — Ctrl+C untuk berhenti`);
  console.log(`   ⚡ Energy Boost : tiap ${formatDuration(CONFIG.ENERGY_BOOST_INTERVAL_MS)}`);
  console.log(`   🎯 Claim        : tiap ${formatDuration(CONFIG.CLAIM_INTERVAL_MS)}`);

  const timers = [];

  // Timer energy boost (tiap 1 menit)
  timers.push(setInterval(async () => {
    await runBoostCycle(initData);
  }, CONFIG.ENERGY_BOOST_INTERVAL_MS));

  // Timer claim (tiap 5 menit / sesuai config)
  timers.push(setInterval(async () => {
    await runClaimCycle(initData);
  }, CONFIG.CLAIM_INTERVAL_MS));

  // Graceful shutdown
  process.on("SIGINT", () => {
    timers.forEach(t => clearInterval(t));
    console.log("\n\n👋 Script dihentikan.");
    process.exit(0);
  });
}

main().catch(console.error);
