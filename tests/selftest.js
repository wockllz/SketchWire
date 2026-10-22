/**
 * SketchWire — end-to-end self test.
 * Boots the real server + a mock Ollama, then drives the FULL product:
 * board APIs, realtime WebSocket sync, MUSE imagine mission (wireframe
 * applied to the board), SMITH prototype mission (real files, PRISM
 * syntax verification, live preview), and the SMITH repair loop with a
 * deliberately broken first attempt.
 *
 * Run:  npm run selftest            (happy path)
 *       MOCK_FAIL_ONCE=1 npm run selftest   (repair loop test)
 */
"use strict";

const { spawn } = require("child_process");
const net = require("net");
const path = require("path");
const WebSocket = require("ws");

const ROOT = path.join(__dirname, "..");
let APP_PORT = 0;
let MOCK_PORT = 0;

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

let pass = 0;
function ok(name, cond, extra) {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}${extra ? " — " + extra : ""}`);
  } else {
    console.log(`  ✗ ${name}${extra ? " — " + extra : ""}`);
    process.exitCode = 1;
    throw new Error("assertion failed: " + name);
  }
}

async function getJson(url, opts) {
  const res = await fetch(url, opts);
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}
const post = (url, data) => getJson(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
const patch = (url, data) => getJson(url, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
const del = (url) => getJson(url, { method: "DELETE" });

function waitFor(url, timeoutMs, label) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const { status, body } = await getJson(url);
        if (status === 200) return resolve(body);
      } catch { /* retry */ }
      if (Date.now() - t0 > timeoutMs) return reject(new Error(`timeout waiting for ${label}`));
      setTimeout(tick, 400);
    };
    tick();
  });
}

function waitForMission(base, missionId, timeoutMs) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const { body } = await getJson(`${base}/api/missions/${missionId}`);
        if (body.mission && ["complete", "failed"].includes(body.mission.status)) return resolve(body);
      } catch { /* retry */ }
      if (Date.now() - t0 > timeoutMs) return reject(new Error(`timeout waiting for mission ${missionId}`));
      setTimeout(tick, 500);
    };
    tick();
  });
}

function wsWait(ws, predicate, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("ws message timeout")), timeoutMs);
    ws.on("message", (buf) => {
      let msg;
      try { msg = JSON.parse(buf.toString()); } catch { return; }
      if (predicate(msg)) { clearTimeout(timer); resolve(msg); }
    });
  });
}

const children = [];
function spawnChild(cmd, args, env) {
  const p = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  children.push(p);
  return p;
}

async function main() {
  MOCK_PORT = await freePort();
  APP_PORT = await freePort();
  const failOnce = process.env.MOCK_FAIL_ONCE === "1";
  const base = `http://127.0.0.1:${APP_PORT}`;
  const model = "mock-coder:7b";

  console.log("\n== SketchWire self test ==");

  // fresh data dir
  require("child_process").execSync("rm -rf data generated", { cwd: ROOT });

  console.log("[boot] starting mock-ollama + SketchWire server");
  const mock = spawnChild("node", ["tests/mock-ollama.js"], { MOCK_PORT: String(MOCK_PORT), MOCK_FAIL_ONCE: failOnce ? "1" : "0" });
  const server = spawnChild("node", ["server.js"], { PORT: String(APP_PORT), OLLAMA_URL: `http://127.0.0.1:${MOCK_PORT}` });
  mock.stderr.on("data", (d) => process.stderr.write(d));
  server.stdout.on("data", (d) => process.stdout.write(d));
  server.stderr.on("data", (d) => process.stderr.write(d));

  await waitFor(`${base}/api/health`, 45000, "server"); // slow machines need room
  ok("server boots + health check", true);

  const ollama = await waitFor(`${base}/api/ollama/status`, 15000, "ollama");
  ok("ollama status API", ollama.online === true && ollama.models.includes(model), `model ${model}`);

  // ---- boards + elements -------------------------------------------------
  const created = await post(`${base}/api/boards`, { name: "Test Board" });
  ok("create board", created.status === 201 && created.body.board.id, created.body.board.name);
  const boardId = created.body.board.id;

  let board = await getJson(`${base}/api/boards/${boardId}`);
  ok("board empty initially", board.body.elements.length === 0);

  const el1 = await post(`${base}/api/boards/${boardId}/elements`, { type: "heading", x: 40, y: 40, w: 400, h: 60, text: "Hello Studio" });
  ok("add element via API", el1.status === 201 && el1.body.element.id);
  const el1Id = el1.body.element.id;

  const el2 = await post(`${base}/api/boards/${boardId}/elements`, { type: "button", x: 40, y: 120, w: 160, h: 46, text: "Click Me" });
  ok("add second element", el2.status === 201);

  const upd = await patch(`${base}/api/elements/${el1Id}`, { text: "Hello Edited" });
  ok("update element", upd.body.ok === true && upd.body.element.text === "Hello Edited");

  board = await getJson(`${base}/api/boards/${boardId}`);
  ok("board has 2 elements after CRUD", board.body.elements.length === 2, board.body.elements.map((e) => e.type).join(","));

  // ---- realtime sync over WS -------------------------------------------
  console.log("[ws] testing realtime board sync");
  const ws = new WebSocket(`ws://127.0.0.1:${APP_PORT}`);
  await new Promise((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
    setTimeout(() => reject(new Error("ws connect timeout")), 8000);
  });
  ws.send(JSON.stringify({ kind: "join", boardId }));

  // attach listeners BEFORE firing the actions (broadcasts race otherwise)
  const addedPromise = wsWait(ws, (m) => m.kind === "element-added" && m.element && m.element.type === "box" && m.element.text === "section", 5000);
  const el3 = await post(`${base}/api/boards/${boardId}/elements`, { type: "box", x: 200, y: 200, w: 300, h: 150, text: "section" });
  const wsAdded = await addedPromise;
  ok("WS broadcasts element-added", !!wsAdded.element.id);

  const updatedPromise = wsWait(ws, (m) => m.kind === "element-updated" && m.element && m.element.x === 250, 5000);
  await patch(`${base}/api/elements/${el3.body.element.id}`, { x: 250 });
  const wsUpdated = await updatedPromise;
  ok("WS broadcasts element-updated", !!wsUpdated);

  const deletedPromise = wsWait(ws, (m) => m.kind === "element-deleted", 5000);
  await del(`${base}/api/elements/${el3.body.element.id}`);
  const wsDeleted = await deletedPromise;
  ok("WS broadcasts element-deleted", wsDeleted.id === el3.body.element.id);

  // ---- MUSE imagine mission ---------------------------------------------
  console.log("[imagine] MUSE wireframe generation mission");
  const before = (await getJson(`${base}/api/boards/${boardId}`)).body.elements.length;
  const im = await post(`${base}/api/missions`, { boardId, prompt: "a coffee shop landing page", model, kind: "imagine" });
  ok("imagine mission accepted", im.status === 201 && im.body.missionId);

  const wsMission = wsWait(ws, (m) => m.kind === "wireframe-applied" || (m.kind === "mission" && m.event && m.event.type === "wireframe-applied"), 30000).catch(() => null);
  const imResult = await waitForMission(base, im.body.missionId, 300000); // slow machines welcome
  const after = (await getJson(`${base}/api/boards/${boardId}`)).body.elements.length;

  ok("imagine mission completes", imResult.mission.status === "complete", `${imResult.mission.status}`);
  ok("wireframe applied to board", after > before, `${before} → ${after} elements`);
  ok("MUSE events recorded", imResult.events.some((e) => e.agent === "muse" && e.type === "wireframe-applied"));
  const plan = JSON.parse(imResult.mission.plan || "{}");
  ok("plan stored with name + palette", !!plan.name && Array.isArray(plan.palette), plan.name);

  // ---- SMITH prototype mission -------------------------------------------
  console.log("[prototype] SMITH build + PRISM verify mission");
  const pt = await post(`${base}/api/missions`, { boardId, prompt: "a coffee shop landing page", model, kind: "prototype" });
  ok("prototype mission accepted", pt.status === 201 && pt.body.missionId);
  const ptDonePromise = wsWait(ws, (m) => m.kind === "mission-done" && m.missionId === pt.body.missionId, 300000).catch(() => null);

  const ptResult = await waitForMission(base, pt.body.missionId, 300000);
  ok("prototype mission completes", ptResult.mission.status === "complete", `attempts=${ptResult.mission.attempts}`);
  ok("repair loop behaved", failOnce ? ptResult.mission.attempts === 2 : ptResult.mission.attempts === 1, `attempts=${ptResult.mission.attempts}`);
  const allChecks = ptResult.events.filter((e) => e.type === "check");
  ok("PRISM check events recorded", allChecks.length >= 6);
  // the FINAL round of checks (after the last smith status/revision event) must all pass
  let lastSmith = -1;
  ptResult.events.forEach((e, i) => { if (e.agent === "smith" && (e.type === "status" || e.type === "revision")) lastSmith = i; });
  const finalChecks = ptResult.events.filter((e, i) => e.type === "check" && i > lastSmith);
  const earlyFails = allChecks.length - finalChecks.length;
  ok("final PRISM round fully green", finalChecks.length >= 6 && finalChecks.every((e) => !e.data || e.data.ok !== false),
     `${finalChecks.length} final checks green${failOnce ? ` (first attempt had ${earlyFails} failure, repaired)` : ""}`);

  const files = (await getJson(`${base}/api/missions/${pt.body.missionId}/files`)).body.files;
  ok("3 files stored", files["index.html"] && files["style.css"] && files["app.js"]);

  const html = await fetch(`${base}/p/${pt.body.missionId}/index.html`);
  const htmlText = await html.text();
  ok("preview serves index.html", html.status === 200 && htmlText.includes("<title>"), "HTTP 200");

  const js = await fetch(`${base}/p/${pt.body.missionId}/app.js`);
  const jsText = await js.text();
  ok("preview serves app.js", js.status === 200 && jsText.includes("addEventListener"));

  const css = await fetch(`${base}/p/${pt.body.missionId}/style.css`);
  ok("preview serves style.css", css.status === 200);

  // verify fidelity: wireframe copy really made it into the prototype
  ok("wireframe fidelity in prototype", htmlText.includes("Bold Coffee, Zero Pretense") && htmlText.includes("Order Now"));

  // ---- guard rails -------------------------------------------------------
  const emptyBoard = await post(`${base}/api/boards`, { name: "Empty Board" });
  const emptyP = await post(`${base}/api/missions`, { boardId: emptyBoard.body.board.id, prompt: "x", model, kind: "prototype" });
  ok("prototype on empty board rejected", emptyP.status === 400);

  const badBoard = await post(`${base}/api/missions`, { boardId: "does-not-exist", prompt: "x", model, kind: "imagine" });
  ok("mission on unknown board rejected", badBoard.status === 404);

  const missing = await post(`${base}/api/missions`, { boardId, prompt: "", model, kind: "imagine" });
  ok("mission without prompt rejected", missing.status === 400);

  const missions = await getJson(`${base}/api/missions?boardId=${boardId}`);
  ok("mission log lists missions", missions.body.missions.length === 2, `${missions.body.missions.length} missions`);

  const wsDone = await ptDonePromise;
  ok("WS broadcasts mission-done", !!(wsDone && wsDone.ok === true && wsDone.previewUrl));

  // ---- teardown ----------------------------------------------------------
  ws.close();
  ok("all assertions passed", true);
  console.log(`\n== selftest PASSED — SketchWire is fully operational ✏️ (${pass} checks) ==\n`);

  for (const p of children) p.kill();
  setTimeout(() => process.exit(process.exitCode || 0), 300);
}

main().catch((err) => {
  console.error("\n== selftest FAILED ==");
  console.error(err && err.stack ? err.stack : err);
  for (const p of children) {
    try { p.kill(); } catch { /* ignore */ }
  }
  setTimeout(() => process.exit(1), 300);
});
