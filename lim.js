const dotenv = require("dotenv");
const path   = require("path");
const { randomUUID } = require("crypto");

dotenv.config({ path: path.join(__dirname, ".env") });

// ============================================================
// KONFIGURASI (diambil dari .env)
// ============================================================
const CONFIG = {
  INIT_DATA:                process.env.INIT_DATA                || "",
  CLAIM_INTERVAL_MS:        parseInt(process.env.CLAIM_INTERVAL_MS)        || 5  * 60 * 1000,
  ENERGY_BOOST_INTERVAL_MS: parseInt(process.env.ENERGY_BOOST_INTERVAL_MS) || 1  * 60 * 1000,
  MINING_BOOST_INTERVAL_MS: parseInt(process.env.MINING_BOOST_INTERVAL_MS) || 4  * 60 * 60 * 1000,
  TASK_INTERVAL_MS:         parseInt(process.env.TASK_INTERVAL_MS)         || 10 * 60 * 1000,
  AUTO_LOOP:                process.env.AUTO_LOOP !== "false",
  VERBOSE:                  process.env.VERBOSE  === "true",
};

const BASE_URL = "https://crmnetwork.xyz";

const ENDPOINTS = {
  USER_INFO:     "2e857a8661ed051f72427143277d80bab9f7d7a3291576d0e9fc51f1a8bfdd99",
  BALANCE:       "62fb8cd3427e2b52cffe2025ec235b259a81792855f4e7d0716f7a8933e9ee37",
  MINING_INFO:   "446960a3fbdbc9a29426b8959570689c2b86c6834efb5fbba8ad57cac670c474",
  TASKS:         "446960a3fbdbc9a29426b8959570689c2b86c6834efb5fbba8ad57cac670c474",
  REFERRAL:      "315599a52f04634a5fca4d465bc9186d48c8242f29b3c7bd621bfd46536f35e7",
  CLAIM:         "300377a39126958995cb42ba5717a5e58e7cacfe3d7893249b420ebb732a1899",
  ENERGY_BOOST:  "2e857a8661ed051f72427143277d80bab9f7d7a3291576d0e9fc51f1a8bfdd99",
  TASK_COMPLETE: "c427fd5729a7aac8f19d87d1d6c1206495637371611444c2caa3e417c4394b9e",
};

const MINING_BOOST_KEYWORDS = [
  "mining power", "power boost", "mining boost",
  "boost mining", "energy mining", "mine boost",
];

// State balance session
const SESSION = {
  balanceBefore: null,
  balanceAfter:  null,
  totalEarned:   0,
  claimCount:    0,
  startTime:     Date.now(),
};

// ============================================================
// HTTP HELPERS
// ============================================================
function getHeaders() {
  return {
    "accept":          "application/x-tss-framed, application/x-ndjson, application/json",
    "accept-language": "en-US,en;q=0.9",
    "content-type":    "application/json",
    "origin":          "https://crmnetwork.xyz",
    "referer":         "https://crmnetwork.xyz/",
    "user-agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
    "x-tsr-serverfn":  "true",
  };
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
      headers: getHeaders(),
      body:    makeBody(initData, extraKeys, extraVals),
    });
    const text = await res.text();
    if (CONFIG.VERBOSE) {
      console.log(`    [${hash.slice(0, 8)}...] HTTP ${res.status}`);
      console.log("    Raw:", text.slice(0, 600));
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
// TSS RESPONSE DECODER
// Format server: {"t":10,"p":{"k":["result","error","context"],"v":[...]}}
// k = nama key, v = nilai (index sama)
// ============================================================

// Decode satu node TSS menjadi nilai JS biasa
function decodeTSS(node) {
  if (node === null || node === undefined) return null;
  const t = node.t;

  // t:1 = string, t:2 = number/bool, t:25 = Error object
  if (t === 1)  return node.s ?? null;
  if (t === 2)  return node.s ?? null;
  if (t === 3)  return node.s ?? null; // boolean
  if (t === 25) {
    // Error node — ekstrak pesan
    const msg = node.s?.message;
    return msg ? decodeTSS(msg) : null;
  }
  if (t === 10) {
    // Object node — rekursif decode k/v pairs
    if (!node.p || !node.p.k) return {};
    const obj = {};
    node.p.k.forEach((key, i) => {
      obj[key] = decodeTSS(node.p.v?.[i]);
    });
    return obj;
  }
  if (t === 4 || t === 5) {
    // Array node
    return (node.v || []).map(decodeTSS);
  }
  // Fallback: kembalikan s atau node itu sendiri
  return node.s ?? node;
}

// Parse seluruh response menjadi object JS
function parseResponse(result) {
  try {
    const lines = result.data || [];
    for (const line of lines) {
      if (line && line.t === 10 && line.p?.k) {
        return decodeTSS(line);
      }
    }
    return null;
  } catch {
    return null;
  }
}

// Cek apakah response mengandung auth error
function isAuthError(parsed) {
  if (!parsed) return false;
  const errMsg = String(parsed.error || "").toLowerCase();
  return errMsg.includes("invalid_signature") ||
         errMsg.includes("tg_auth") ||
         errMsg.includes("invalid initdata");
}

// Cari nilai numerik secara rekursif dari object
function findNumber(obj, keys) {
  if (!obj || typeof obj !== "object") return null;
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null) {
      const val = parseFloat(obj[key]);
      if (!isNaN(val)) return val;
    }
  }
  // Rekursif ke child objects
  for (const val of Object.values(obj)) {
    if (typeof val === "object") {
      const found = findNumber(val, keys);
      if (found !== null) return found;
    }
  }
  return null;
}

function extractBalance(result) {
  try {
    const parsed = parseResponse(result);
    if (!parsed) return null;
    const data = parsed.result || parsed;
    return findNumber(data, [
      "balance", "total_balance", "coin", "coins",
      "crm", "token", "tokens", "amount", "total",
    ]);
  } catch { return null; }
}

function extractClaimedAmount(result) {
  try {
    const parsed = parseResponse(result);
    if (!parsed) return null;
    const data = parsed.result || parsed;
    return findNumber(data, [
      "claimed", "reward", "earned", "mining_reward",
      "mined", "amount", "crm_earned", "tokens_earned",
    ]);
  } catch { return null; }
}

// Tampilkan ringkasan balance
function printBalanceSummary(before, after, claimed = null) {
  const line = (label, val) => `  │ ${label}: ${String(val ?? "N/A").padEnd(14)} CRM │`;
  console.log("  ┌──────────────────────────────────────┐");
  if (before  !== null) console.log(line("💼 Balance Sebelum ", before));
  if (claimed !== null && claimed > 0) console.log(line("💎 Hasil Claim     ", "+" + claimed));
  if (after   !== null) console.log(line("💰 Balance Sekarang", after));
  if (before !== null && after !== null) {
    const diff = parseFloat((after - before).toFixed(6));
    if (diff > 0) console.log(line("📈 Selisih         ", "+" + diff));
  }
  console.log("  └──────────────────────────────────────┘");
}

// Tampilkan statistik sesi
function printSessionStats() {
  const elapsed  = Date.now() - SESSION.startTime;
  const hours    = Math.floor(elapsed / 3600000);
  const minutes  = Math.floor((elapsed % 3600000) / 60000);
  console.log("\n  ╔═══════════════════════════════════╗");
  console.log("  ║        STATISTIK SESI             ║");
  console.log("  ╠═══════════════════════════════════╣");
  console.log(`  ║ ⏱  Durasi      : ${String(hours + "j " + minutes + "m").padEnd(17)} ║`);
  console.log(`  ║ 🎯 Total Claim : ${String(SESSION.claimCount + " kali").padEnd(17)} ║`);
  console.log(`  ║ 💎 Total Dapat : ${String(SESSION.totalEarned.toFixed(4) + " CRM").padEnd(17)} ║`);
  if (SESSION.balanceAfter !== null)
    console.log(`  ║ 💰 Balance     : ${String(SESSION.balanceAfter.toFixed(4) + " CRM").padEnd(17)} ║`);
  console.log("  ╚═══════════════════════════════════╝");
}

// ============================================================
// ACTIONS
// ============================================================
// Cek auth error dari parsed response dan tampilkan peringatan
function checkAuth(result, label = "") {
  const parsed = parseResponse(result);
  if (isAuthError(parsed)) {
    console.log("\n  ┌──────────────────────────────────────────────┐");
    console.log("  │ ⚠️  INIT DATA EXPIRED / TIDAK VALID           │");
    console.log("  │ Perbarui INIT_DATA di file .env kamu:        │");
    console.log("  │ 1. Buka app CRM di Telegram                  │");
    console.log("  │ 2. DevTools → Network → cari request terbaru │");
    console.log("  │ 3. Salin nilai _initData → paste ke .env     │");
    console.log("  └──────────────────────────────────────────────┘");
    return false;
  }
  return true;
}

async function getBalance(initData) {
  const r = await callEndpoint(ENDPOINTS.BALANCE, initData);
  if (r.ok) {
    const parsed = parseResponse(r);
    if (isAuthError(parsed)) return { ok: false, balance: null, authError: true };
    const bal = extractBalance(r);
    return { ok: true, balance: bal, raw: r };
  }
  return { ok: false, balance: null };
}

async function getUserInfo(initData) {
  process.stdout.write("  📊 User info... ");
  const r = await callEndpoint(ENDPOINTS.USER_INFO, initData);
  const parsed = parseResponse(r);
  if (isAuthError(parsed)) {
    console.log("❌ AUTH EXPIRED");
    checkAuth(r);
    return r;
  }
  // Tampilkan nama user jika ada
  const name = parsed?.result?.first_name || parsed?.result?.username || null;
  console.log(`✅${name ? ` (${name})` : ""}`);
  return r;
}

async function getMiningInfo(initData) {
  process.stdout.write("  ⛏️  Mining info... ");
  const r = await callEndpoint(ENDPOINTS.MINING_INFO, initData);
  const parsed = parseResponse(r);
  if (isAuthError(parsed)) { console.log("❌ AUTH EXPIRED"); return r; }
  // Tampilkan mining rate jika ada
  const rate = findNumber(parsed?.result || {}, ["rate", "mining_rate", "per_hour", "speed"]);
  console.log(`✅${rate !== null ? ` (${rate} CRM/jam)` : ""}`);
  return r;
}

function balanceLabel(val) {
  return val !== null ? `${val} CRM` : "N/A";
}

async function claimReward(initData) {
  const key = randomUUID();
  console.log(`  🎯 Claim mining (key: ${key.slice(0, 8)}...)`);

  // Balance SEBELUM claim
  process.stdout.write("  💼 Cek balance awal... ");
  const before = await getBalance(initData);
  if (before.authError) { console.log("❌ AUTH EXPIRED"); checkAuth(before.raw || {}); return; }
  console.log(`✅ ${balanceLabel(before.balance)}`);

  // Kirim claim
  process.stdout.write("  🚀 Mengirim claim... ");
  const r = await callEndpoint(ENDPOINTS.CLAIM, initData, ["idempotency_key"], [{ t: 1, s: key }]);
  const parsed = parseResponse(r);

  if (isAuthError(parsed)) {
    console.log("❌ AUTH EXPIRED");
    checkAuth(r);
    return r;
  }

  if (r.ok) {
    console.log("✅ BERHASIL!");
    const claimed = extractClaimedAmount(r);

    // Balance SETELAH claim
    await sleep(1200);
    process.stdout.write("  💰 Cek balance akhir... ");
    const after = await getBalance(initData);
    console.log(`✅ ${balanceLabel(after.balance)}`);

    const diff = (before.balance !== null && after.balance !== null)
      ? parseFloat((after.balance - before.balance).toFixed(6))
      : claimed;

    SESSION.balanceBefore = before.balance;
    SESSION.balanceAfter  = after.balance;
    SESSION.claimCount++;
    if (diff && diff > 0) SESSION.totalEarned = parseFloat((SESSION.totalEarned + diff).toFixed(6));

    printBalanceSummary(before.balance, after.balance, diff !== null && diff > 0 ? diff : claimed);
    if (CONFIG.VERBOSE) console.log("  Parsed:", JSON.stringify(parsed, null, 2));
  } else {
    console.log(`  ❌ GAGAL (${r.status || r.error})`);
  }
  return r;
}

async function energyBoost(initData) {
  process.stdout.write(`[${timestamp()}] ⚡ Energy Boost... `);
  const r = await callEndpoint(ENDPOINTS.ENERGY_BOOST, initData);
  const parsed = parseResponse(r);
  if (isAuthError(parsed)) { console.log("❌ AUTH EXPIRED"); checkAuth(r); return r; }
  console.log(r.ok ? "✅" : `❌ (${r.status || r.error})`);
  return r;
}

async function claimMiningBoost(initData) {
  console.log(`[${timestamp()}] 🚀 Mining Power Boost Claim`);

  process.stdout.write("  💼 Cek balance awal... ");
  const before = await getBalance(initData);
  if (before.authError) { console.log("❌ AUTH EXPIRED"); checkAuth({}); return; }
  console.log(`✅ ${balanceLabel(before.balance)}`);

  process.stdout.write("  🚀 Mengirim boost claim... ");
  const r = await callEndpoint(ENDPOINTS.TASK_COMPLETE, initData);
  const parsed = parseResponse(r);

  if (isAuthError(parsed)) { console.log("❌ AUTH EXPIRED"); checkAuth(r); return r; }

  if (r.ok) {
    console.log("✅ BERHASIL!");
    await sleep(1200);

    process.stdout.write("  💰 Cek balance akhir... ");
    const after = await getBalance(initData);
    console.log(`✅ ${balanceLabel(after.balance)}`);

    const diff = (before.balance !== null && after.balance !== null)
      ? parseFloat((after.balance - before.balance).toFixed(6)) : null;

    SESSION.balanceAfter = after.balance;
    if (diff && diff > 0) SESSION.totalEarned = parseFloat((SESSION.totalEarned + diff).toFixed(6));

    printBalanceSummary(before.balance, after.balance, diff);
  } else {
    console.log(`  ❌ GAGAL (${r.status || r.error})`);
  }
  return r;
}

async function fetchTasks(initData) {
  const r = await callEndpoint(ENDPOINTS.TASKS, initData);
  if (!r.ok) return [];
  try {
    const flat = JSON.stringify(r.data || []);
    const matches = [...flat.matchAll(/"id"\s*:\s*"?(\w+)"?[^}]*?"(?:title|name|type)"\s*:\s*"([^"]+)"/g)];
    if (matches.length > 0) return matches.map(m => ({ id: m[1], title: m[2] }));
    return [];
  } catch { return []; }
}

function isMiningBoostTask(taskTitle = "") {
  return MINING_BOOST_KEYWORDS.some(kw => taskTitle.toLowerCase().includes(kw));
}

async function completeTask(initData, task) {
  process.stdout.write(`    🔸 "${task.title}" (id: ${task.id})... `);
  const r = await callEndpoint(
    ENDPOINTS.TASK_COMPLETE, initData,
    ["task_id"],
    [{ t: 1, s: String(task.id) }]
  );
  const parsed = parseResponse(r);
  if (isAuthError(parsed)) { console.log("❌ AUTH EXPIRED"); return r; }
  const reward = extractClaimedAmount(r);
  if (r.ok) {
    console.log(`✅${reward !== null && reward > 0 ? ` +${reward} CRM` : ""}`);
    if (reward && reward > 0) SESSION.totalEarned = parseFloat((SESSION.totalEarned + reward).toFixed(6));
  } else {
    console.log(`❌ (${r.status || r.error})`);
  }
  return r;
}

async function runTaskCycle(initData) {
  console.log(`\n[${timestamp()}] 📋 TASK CYCLE`);
  process.stdout.write("  📥 Mengambil daftar task... ");
  const tasks = await fetchTasks(initData);

  if (tasks.length === 0) {
    console.log("  ⚠️  Tidak ada task / semua sudah selesai");
    return;
  }
  console.log(`✅ ${tasks.length} task ditemukan`);

  let done = 0, skip = 0;
  for (const task of tasks) {
    if (isMiningBoostTask(task.title)) {
      console.log(`    ⏭️  Skip "${task.title}" — ditangani Mining Boost timer`);
      skip++;
      continue;
    }
    await completeTask(initData, task);
    done++;
    await sleep(1500);
  }
  console.log(`  ✔️  ${done} task selesai, ${skip} dilewati`);
}

// ============================================================
// CLAIM CYCLE
// ============================================================
async function runClaimCycle(initData) {
  console.log(`\n┌─ [${timestamp()}] 🔄 CLAIM CYCLE`);
  await getUserInfo(initData);
  await getMiningInfo(initData);
  await claimReward(initData);

  // Tampilkan stats sesi setiap klaim
  printSessionStats();
  console.log(`└─ Selesai`);
}

// ============================================================
// UTILS
// ============================================================
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function timestamp() {
  return new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });
}

function formatDuration(ms) {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  if (h > 0) return `${h}j ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

// ============================================================
// MAIN
// ============================================================
async function main() {
  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║  CRM Network Auto Bot                            ║");
  console.log("║  Claim + Energy Boost + Task + Mining Boost      ║");
  console.log("╚══════════════════════════════════════════════════╝");

  if (!CONFIG.INIT_DATA || CONFIG.INIT_DATA.includes("GANTI_DENGAN_PUNYA_KAMU")) {
    console.error("\n❌ ERROR: INIT_DATA belum diisi di file .env!\n");
    process.exit(1);
  }

  console.log("\n📋 Konfigurasi:");
  console.log(`   INIT_DATA         : ${CONFIG.INIT_DATA.slice(0, 40)}...`);
  console.log(`   🎯 Claim          : setiap ${formatDuration(CONFIG.CLAIM_INTERVAL_MS)}`);
  console.log(`   ⚡ Energy Boost   : setiap ${formatDuration(CONFIG.ENERGY_BOOST_INTERVAL_MS)}`);
  console.log(`   🚀 Mining Boost   : setiap ${formatDuration(CONFIG.MINING_BOOST_INTERVAL_MS)}`);
  console.log(`   📋 Task Check     : setiap ${formatDuration(CONFIG.TASK_INTERVAL_MS)}`);
  console.log(`   AUTO_LOOP         : ${CONFIG.AUTO_LOOP}`);
  console.log(`   VERBOSE           : ${CONFIG.VERBOSE}`);
  console.log("\n" + "─".repeat(52));

  const initData = CONFIG.INIT_DATA;

  // Jalankan semua langsung saat start
  await runClaimCycle(initData);
  await energyBoost(initData);
  await claimMiningBoost(initData);
  await runTaskCycle(initData);

  if (!CONFIG.AUTO_LOOP) {
    printSessionStats();
    return;
  }

  console.log(`\n⏰ Semua scheduler aktif — Ctrl+C untuk berhenti`);
  console.log(`   ⚡ Energy Boost   : tiap ${formatDuration(CONFIG.ENERGY_BOOST_INTERVAL_MS)}`);
  console.log(`   🎯 Claim Mining   : tiap ${formatDuration(CONFIG.CLAIM_INTERVAL_MS)}`);
  console.log(`   🚀 Mining Boost   : tiap ${formatDuration(CONFIG.MINING_BOOST_INTERVAL_MS)}`);
  console.log(`   📋 Task Check     : tiap ${formatDuration(CONFIG.TASK_INTERVAL_MS)}`);

  const timers = [];

  // ⚡ Energy boost — tiap 1 menit
  timers.push(setInterval(async () => {
    await energyBoost(initData);
  }, CONFIG.ENERGY_BOOST_INTERVAL_MS));

  // 🎯 Claim mining — tiap 5 menit
  timers.push(setInterval(async () => {
    await runClaimCycle(initData);
  }, CONFIG.CLAIM_INTERVAL_MS));

  // 🚀 Mining power boost — tiap 4 jam
  timers.push(setInterval(async () => {
    await claimMiningBoost(initData);
  }, CONFIG.MINING_BOOST_INTERVAL_MS));

  // 📋 Task check — tiap 10 menit
  timers.push(setInterval(async () => {
    await runTaskCycle(initData);
  }, CONFIG.TASK_INTERVAL_MS));

  // Graceful shutdown + tampilkan stats akhir
  process.on("SIGINT", () => {
    timers.forEach(t => clearInterval(t));
    console.log("\n");
    printSessionStats();
    console.log("\n👋 Script dihentikan.");
    process.exit(0);
  });
}

main().catch(console.error);
