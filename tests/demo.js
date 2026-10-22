/**
 * SketchWire — LIVE DEMO.
 * Runs the real product end-to-end against the running SketchWire server
 * with your real Ollama model: creates a fresh board, MUSE imagines the
 * wireframe, SMITH builds the real app, PRISM verifies it. Narrates every
 * step in the console. Patient timeouts — built for slow machines.
 *
 * Usage (two terminals):
 *   npm start                              ← terminal 1: studio must be running
 *   npm run demo                           ← terminal 2: full live demo
 *   npm run demo -- "a gym landing page"   ← custom idea
 */
"use strict";

const SERVER = process.env.AF_URL || "http://localhost:4400";
const DEFAULT_IDEA = "a coffee shop landing page with a hero, menu and newsletter signup";
const BUDGET_MS = 10 * 60 * 1000;

const clock = () => new Date().toLocaleTimeString([], { hour12: false });
const line = (msg) => process.stdout.write(`[${clock()}] ${msg}\n`);

async function getJson(url, opts) {
  const res = await fetch(url, opts);
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}
const post = (url, data) => getJson(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });

const LABEL = { muse: "MUSE   ", smith: "SMITH  ", prism: "PRISM  ", system: "SYSTEM " };

async function pollMission(base, missionId, label) {
  const t0 = Date.now();
  let lastEvent = 0;
  let lastStatus = null;
  while (Date.now() - t0 < BUDGET_MS) {
    const { body } = await getJson(`${base}/api/missions/${missionId}`);
    const m = body.mission;
    if (!m) throw new Error("mission vanished");
    if (m.status !== lastStatus) {
      lastStatus = m.status;
      line(`[${clock()}] ${label} STATUS → ${m.status.toUpperCase()}`);
    }
    for (let i = lastEvent; i < body.events.length; i += 1) {
      const ev = body.events[i];
      const tag = ev.type === "check" && ev.data && typeof ev.data.ok === "boolean"
        ? (ev.data.ok ? "✓ PASS" : "✗ FAIL")
        : "";
      line(`  ${LABEL[ev.agent] || ev.agent} ${tag} ${ev.message}`);
    }
    lastEvent = body.events.length;
    if (["complete", "failed"].includes(m.status)) return body;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("mission did not finish within budget");
}

async function main() {
  const idea = process.argv.slice(2).join(" ").trim() || DEFAULT_IDEA;

  line("=".repeat(60));
  line("SKETCHWIRE — LIVE DEMO  (real model, real pipeline, no mocks)");
  line("=".repeat(60));

  line("[1/6] Checking SketchWire server…");
  let health;
  try { health = await getJson(`${SERVER}/api/health`); } catch { health = null; }
  if (!health || health.status !== 200 || !health.body.ok) {
    line("[1/6] ✗ Server not reachable at " + SERVER);
    line("      → Open a SECOND PowerShell window and run:  npm start");
    process.exit(1);
  }
  line("[1/6] ✓ Studio online");

  line("[2/6] Checking Ollama…");
  const { body: ollama } = await getJson(`${SERVER}/api/ollama/status`);
  if (!ollama.online || !ollama.models.length) {
    line("[2/6] ✗ Ollama offline or no models. Run: ollama pull qwen2.5-coder:3b");
    process.exit(1);
  }
  const model = ollama.models.find((m) => m.includes("coder")) || ollama.models[0];
  line(`[2/6] ✓ Ollama online — using ${model}`);

  line("[3/6] Creating a fresh demo board…");
  const board = await post(`${SERVER}/api/boards`, { name: "Demo " + new Date().toLocaleDateString() });
  if (board.status !== 201) { line("[3/6] ✗ Could not create board"); process.exit(1); }
  const boardId = board.body.board.id;
  line(`[3/6] ✓ Board "${board.body.board.name}" created — open the studio and select it to watch live`);

  line(`[4/6] MUSE — imagining a wireframe for: "${idea}"`);
  const im = await post(`${SERVER}/api/missions`, { boardId, prompt: idea, model, kind: "imagine" });
  if (im.status !== 201) { line("[4/6] ✗ " + (im.body.error || "rejected")); process.exit(1); }
  const imResult = await pollMission(SERVER, im.body.missionId, "IMAGINE");
  if (imResult.mission.status !== "complete") { line("[4/6] ✗ imagine failed: " + imResult.mission.error); process.exit(1); }
  const plan = JSON.parse(imResult.mission.plan || "{}");
  line(`[4/6] ✓ Wireframe applied — ${plan.name} (${(plan.palette || []).join(", ")})`);

  line("[5/6] SMITH — building the real working app from the wireframe…");
  const pt = await post(`${SERVER}/api/missions`, { boardId, prompt: idea, model, kind: "prototype" });
  if (pt.status !== 201) { line("[5/6] ✗ " + (pt.body.error || "rejected")); process.exit(1); }
  const ptResult = await pollMission(SERVER, pt.body.missionId, "BUILD");
  if (ptResult.mission.status !== "complete") { line("[5/6] ✗ prototype failed: " + ptResult.mission.error); process.exit(1); }

  const checks = ptResult.events.filter((e) => e.type === "check");
  const passed = checks.filter((e) => e.data && e.data.ok !== false).length;
  const secs = Math.round((ptResult.mission.duration_ms || 0) / 1000);

  line("");
  line("=".repeat(60));
  line(`[6/6] ✓ PROTOTYPE COMPLETE in ${secs}s — attempts: ${ptResult.mission.attempts}`);
  line(`[6/6] ✓ PRISM checks: ${passed}/${checks.length} passed`);
  const files = (await getJson(`${SERVER}/api/missions/${pt.body.missionId}/files`)).body.files;
  line(`[6/6] ✓ Forged files: ${Object.entries(files).map(([n, c]) => `${n} (${(c.length / 1024).toFixed(1)} KB)`).join(", ")}`);
  line(`[6/6] ✓ Preview: ${SERVER}/p/${pt.body.missionId}/index.html`);
  line("");
  line("✅ SketchWire is fully operational on this machine. Time to record. ✏️");
  process.exit(0);
}

main().catch((err) => {
  line("demo crashed: " + err.message);
  process.exit(1);
});
