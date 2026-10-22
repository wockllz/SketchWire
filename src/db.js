/**
 * SketchWire — SQLite storage layer (boards, elements, missions, events).
 */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Database = require("better-sqlite3");

const DATA_DIR = path.join(process.cwd(), "data");
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, "sketchwire.db"));
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS boards (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_date TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS elements (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL,
  type TEXT NOT NULL,
  x REAL DEFAULT 0, y REAL DEFAULT 0, w REAL DEFAULT 200, h REAL DEFAULT 40,
  text TEXT DEFAULT '',
  color TEXT DEFAULT '',
  sort INTEGER DEFAULT 0,
  created_date TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_elements_board ON elements(board_id);
CREATE TABLE IF NOT EXISTS missions (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL,
  kind TEXT DEFAULT 'imagine',
  prompt TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT DEFAULT 'queued',
  plan TEXT,
  files TEXT,
  attempts INTEGER DEFAULT 0,
  error TEXT,
  duration_ms INTEGER,
  created_date TEXT DEFAULT (datetime('now')),
  updated_date TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_missions_board ON missions(board_id);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mission_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  data TEXT,
  ts TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_mission ON events(mission_id);
`);

const uid = () => crypto.randomUUID();

function rowToElement(r) {
  return {
    id: r.id, board_id: r.board_id, type: r.type,
    x: r.x, y: r.y, w: r.w, h: r.h,
    text: r.text, color: r.color, sort: r.sort
  };
}

module.exports = {
  uid,

  createBoard(name) {
    const id = uid();
    db.prepare("INSERT INTO boards (id, name) VALUES (?, ?)").run(id, name || "Untitled Board");
    return { id, name: name || "Untitled Board" };
  },

  listBoards() {
    return db.prepare(`
      SELECT b.id, b.name, b.created_date, COUNT(e.id) AS element_count
      FROM boards b LEFT JOIN elements e ON e.board_id = b.id
      GROUP BY b.id ORDER BY b.created_date DESC
    `).all();
  },

  getBoard(id) {
    return db.prepare("SELECT * FROM boards WHERE id = ?").get(id) || null;
  },

  getElements(boardId) {
    return db.prepare("SELECT * FROM elements WHERE board_id = ? ORDER BY sort, created_date, rowid")
      .all(boardId).map(rowToElement);
  },

  addElement(boardId, el) {
    const id = uid();
    const sort = (db.prepare("SELECT COALESCE(MAX(sort), 0) AS s FROM elements WHERE board_id = ?").get(boardId) || {}).s || 0;
    db.prepare(`INSERT INTO elements (id, board_id, type, x, y, w, h, text, color, sort)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, boardId, el.type || "box", el.x || 0, el.y || 0, el.w || 200, el.h || 40,
           el.text || "", el.color || "", sort + 1);
    const full = { ...el, id, board_id: boardId, sort: sort + 1 };
    return full;
  },

  updateElement(id, patch) {
    const cur = db.prepare("SELECT * FROM elements WHERE id = ?").get(id);
    if (!cur) return null;
    const next = { ...rowToElement(cur), ...patch, id, board_id: cur.board_id };
    db.prepare(`UPDATE elements SET type=?, x=?, y=?, w=?, h=?, text=?, color=? WHERE id=?`)
      .run(next.type, next.x, next.y, next.w, next.h, next.text, next.color, id);
    return next;
  },

  deleteElement(id) {
    const cur = db.prepare("SELECT board_id FROM elements WHERE id = ?").get(id);
    if (!cur) return null;
    db.prepare("DELETE FROM elements WHERE id = ?").run(id);
    return cur.board_id;
  },

  clearBoard(boardId) {
    db.prepare("DELETE FROM elements WHERE board_id = ?").run(boardId);
  },

  createMission({ board_id, kind, prompt, model }) {
    const id = uid();
    db.prepare(`INSERT INTO missions (id, board_id, kind, prompt, model, status)
               VALUES (?, ?, ?, ?, ?, 'queued')`).run(id, board_id, kind || "imagine", prompt, model);
    return this.getMission(id);
  },

  updateMission(id, patch) {
    const cur = db.prepare("SELECT * FROM missions WHERE id = ?").get(id);
    if (!cur) return;
    const next = { ...cur, ...patch };
    db.prepare(`UPDATE missions SET status=?, plan=?, files=?, attempts=?, error=?, duration_ms=?, updated_date=datetime('now') WHERE id=?`)
      .run(next.status, next.plan, next.files, next.attempts, next.error, next.duration_ms, id);
  },

  getMission(id) {
    return db.prepare("SELECT * FROM missions WHERE id = ?").get(id) || null;
  },

  listMissions(boardId) {
    return db.prepare("SELECT * FROM missions WHERE board_id = ? ORDER BY created_date DESC, rowid DESC")
      .all(boardId);
  },

  addEvent(missionId, agent, type, message, data) {
    db.prepare("INSERT INTO events (mission_id, agent, type, message, data) VALUES (?, ?, ?, ?, ?)")
      .run(missionId, agent, type, message, data === undefined || data === null ? null : JSON.stringify(data));
  },

  getEvents(missionId) {
    return db.prepare("SELECT * FROM events WHERE mission_id = ? ORDER BY id").all(missionId).map((r) => ({
      id: r.id, mission_id: r.mission_id, agent: r.agent, type: r.type,
      message: r.message, data: r.data ? JSON.parse(r.data) : null, ts: r.ts
    }));
  },

  storeFiles(missionId, files) {
    db.prepare("UPDATE missions SET files=? WHERE id=?").run(JSON.stringify(files), missionId);
  },

  getFiles(missionId) {
    const m = db.prepare("SELECT files FROM missions WHERE id = ?").get(missionId);
    if (!m || !m.files) return {};
    try { return JSON.parse(m.files); } catch { return {}; }
  }
};
