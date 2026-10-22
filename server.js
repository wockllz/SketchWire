/**
 * SketchWire — Express + WebSocket server.
 * Serves the studio UI, the board/element/mission APIs, realtime board
 * sync over WS, and live prototype previews at /p/<missionId>/<file>.
 */
"use strict";

const express = require("express");
const http = require("http");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

const db = require("./src/db");
const { SketchEngine } = require("./src/agents/engine");

const PORT = Number(process.env.PORT) || 4400;
const OLLAMA_URL = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
const GENERATED_DIR = path.join(__dirname, "generated");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.set("view engine", "ejs");

// ---------------------------------------------------------------- WS rooms

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const rooms = new Map(); // boardId → Set(ws)

function joinRoom(ws, boardId) {
  for (const set of rooms.values()) set.delete(ws);
  if (!rooms.has(boardId)) rooms.set(boardId, new Set());
  rooms.get(boardId).add(ws);
  ws.boardId = boardId;
}

function broadcastBoard(boardId, payload) {
  const set = rooms.get(boardId);
  if (!set) return;
  const msg = JSON.stringify(payload);
  for (const ws of set) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

wss.on("connection", (ws) => {
  ws.on("message", (buf) => {
    let msg;
    try { msg = JSON.parse(buf.toString()); } catch { return; }
    if (msg.kind === "join" && msg.boardId) joinRoom(ws, msg.boardId);
  });
  ws.on("close", () => {
    for (const set of rooms.values()) set.delete(ws);
  });
});

const engine = new SketchEngine({ db, broadcast: broadcastBoard, ollamaUrl: OLLAMA_URL });

// ---------------------------------------------------------------- helpers

async function ollamaStatus() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: controller.signal });
    if (!res.ok) return { online: false, models: [] };
    const body = await res.json();
    const models = (body.models || []).map((m) => m.name || m.model).filter(Boolean);
    return { online: true, models };
  } catch {
    return { online: false, models: [] };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------- APIs

app.get("/api/health", (req, res) => {
  res.json({ ok: true, name: "SketchWire", ws: true });
});

app.get("/api/ollama/status", async (req, res) => {
  res.json(await ollamaStatus());
});

app.get("/api/boards", (req, res) => {
  res.json({ boards: db.listBoards() });
});

app.post("/api/boards", (req, res) => {
  const name = String((req.body && req.body.name) || "Untitled Board").slice(0, 80);
  res.status(201).json({ ok: true, board: db.createBoard(name) });
});

app.get("/api/boards/:id", (req, res) => {
  const board = db.getBoard(req.params.id);
  if (!board) return res.status(404).json({ ok: false, error: "board not found" });
  res.json({ board, elements: db.getElements(req.params.id) });
});

app.post("/api/boards/:id/elements", (req, res) => {
  const board = db.getBoard(req.params.id);
  if (!board) return res.status(404).json({ ok: false, error: "board not found" });
  const el = db.addElement(req.params.id, req.body || {});
  broadcastBoard(req.params.id, { kind: "element-added", element: el });
  res.status(201).json({ ok: true, element: el });
});

app.patch("/api/elements/:id", (req, res) => {
  const el = db.updateElement(req.params.id, req.body || {});
  if (!el) return res.status(404).json({ ok: false, error: "element not found" });
  broadcastBoard(el.board_id, { kind: "element-updated", element: el });
  res.json({ ok: true, element: el });
});

app.delete("/api/elements/:id", (req, res) => {
  const boardId = db.deleteElement(req.params.id);
  if (!boardId) return res.status(404).json({ ok: false, error: "element not found" });
  broadcastBoard(boardId, { kind: "element-deleted", id: req.params.id });
  res.json({ ok: true });
});

app.delete("/api/boards/:id/elements", (req, res) => {
  db.clearBoard(req.params.id);
  broadcastBoard(req.params.id, { kind: "board-cleared" });
  res.json({ ok: true });
});

app.get("/api/missions", (req, res) => {
  const boardId = req.query.boardId;
  if (!boardId) return res.json({ missions: [] });
  res.json({ missions: db.listMissions(boardId) });
});

app.get("/api/missions/:id", (req, res) => {
  const m = db.getMission(req.params.id);
  if (!m) return res.status(404).json({ ok: false, error: "mission not found" });
  res.json({ mission: m, events: db.getEvents(m.id) });
});

app.get("/api/missions/:id/files", (req, res) => {
  res.json({ files: db.getFiles(req.params.id) });
});

app.post("/api/missions", (req, res) => {
  const { boardId, prompt, model, kind } = req.body || {};
  if (!boardId || !prompt || !model) {
    return res.status(400).json({ ok: false, error: "boardId, prompt and model are required" });
  }
  const board = db.getBoard(boardId);
  if (!board) return res.status(404).json({ ok: false, error: "board not found" });
  if (kind === "prototype" && !db.getElements(boardId).length) {
    return res.status(400).json({ ok: false, error: "board is empty — draw or imagine a wireframe first" });
  }
  const mission = db.createMission({ board_id: boardId, kind: kind === "prototype" ? "prototype" : "imagine", prompt, model });
  if (mission.kind === "prototype") {
    engine.prototype(mission).catch(() => {});
  } else {
    engine.imagine(mission).catch(() => {});
  }
  res.status(201).json({ ok: true, missionId: mission.id });
});

// ---------------------------------------------------------------- preview

app.get("/p/:missionId/:file", (req, res) => {
  const { missionId, file } = req.params;
  if (!/^[a-zA-Z0-9_.-]+$/.test(file) || file.includes("..")) {
    return res.status(400).send("bad file");
  }
  const full = path.join(GENERATED_DIR, missionId, file);
  if (!fs.existsSync(full)) return res.status(404).send("not found");
  const types = { ".html": "text/html", ".css": "text/css", ".js": "application/javascript" };
  res.set("Content-Type", types[path.extname(file)] || "text/plain");
  res.send(fs.readFileSync(full));
});

// ---------------------------------------------------------------- UI

app.get("/", (req, res) => {
  res.render("index");
});

server.listen(PORT, () => {
  console.log(`✦ SketchWire studio on http://localhost:${PORT}`);
  console.log(`  Ollama: ${OLLAMA_URL}`);
});
