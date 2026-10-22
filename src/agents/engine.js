/**
 * SketchWire agent engine.
 * MUSE   → imagines a wireframe layout from a prompt, applies it to the board
 * SMITH  → builds a real HTML/CSS/JS prototype from the board's wireframe
 * PRISM  → verifies (real node --check syntax validation, structure + fidelity
 *          checks) and sends SMITH back for repairs when something fails
 */
"use strict";

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { planPrompt, buildPrompt, reviewPrompt } = require("../prompts");

const MAX_ATTEMPTS = 3;
const CANVAS = { w: 1000, h: 640 };
const TYPES = ["heading", "text", "button", "box", "image", "divider", "input"];

class SketchEngine {
  constructor({ db, broadcast, ollamaUrl }) {
    this.db = db;
    this.broadcast = broadcast;       // (boardId, payload) => void
    this.ollamaUrl = ollamaUrl;
    this.generatedDir = path.join(process.cwd(), "generated");
    fs.mkdirSync(this.generatedDir, { recursive: true });
    this._boards = {};               // missionId → boardId (for event routing)
  }

  // ---------------------------------------------------------------- helpers

  emit(missionId, agent, type, message, data) {
    this.db.addEvent(missionId, agent, type, message, data || null);
    const boardId = this._boards[missionId];
    if (boardId) {
      this.broadcast(boardId, {
        kind: "mission",
        missionId,
        event: { agent, type, message, data: data || null, ts: new Date().toISOString() }
      });
    }
  }

  setStatus(missionId, status) {
    this.db.updateMission(missionId, { status });
    const boardId = this._boards[missionId];
    if (boardId) this.broadcast(boardId, { kind: "mission-status", missionId, status });
  }

  finish(missionId, ok, previewUrl) {
    const boardId = this._boards[missionId];
    if (boardId) this.broadcast(boardId, { kind: "mission-done", missionId, ok: !!ok, previewUrl: previewUrl || null });
    delete this._boards[missionId];
  }

  async chat(model, prompt) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 300000); // 5 min for slow local models
    try {
      const res = await fetch(`${this.ollamaUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: prompt }],
          stream: false,
          options: { temperature: 0.25 }
        }),
        signal: controller.signal
      });
      if (!res.ok) throw new Error(`Ollama responded ${res.status}`);
      const body = await res.json();
      return (body.message && body.message.content) || "";
    } finally {
      clearTimeout(timer);
    }
  }

  parseJson(raw) {
    try {
      const cleaned = String(raw).replace(/```json/gi, "```").replace(/```/g, "");
      const start = cleaned.indexOf("{");
      const end = cleaned.lastIndexOf("}");
      if (start === -1 || end <= start) return null;
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch {
      return null;
    }
  }

  parseBlocks(raw) {
    const files = { "index.html": "", "style.css": "", "app.js": "" };
    const exact = [
      ["index.html", /```html:index\.html\s*([\s\S]*?)```/i],
      ["style.css", /```css:style\.css\s*([\s\S]*?)```/i],
      ["app.js", /```javascript:app\.js\s*([\s\S]*?)```/i]
    ];
    for (const [name, re] of exact) {
      const m = raw.match(re);
      if (m) files[name] = m[1].trim();
    }
    if (files["index.html"]) return files;
    // fallback: three generic fenced blocks
    const blocks = [...raw.matchAll(/```(?:\w+)?\s*\n([\s\S]*?)```/g)].map((m) => m[1].trim());
    if (blocks.length >= 3) {
      files["index.html"] = blocks[0];
      files["style.css"] = blocks[1];
      files["app.js"] = blocks[2];
    }
    return files;
  }

  normalizeElements(raw) {
    const list = Array.isArray(raw) ? raw : [];
    return list.slice(0, 20).map((e) => {
      const type = TYPES.includes(e && e.type) ? e.type : "box";
      let x = Number(e && e.x) || 0;
      let y = Number(e && e.y) || 0;
      let w = Number(e && e.w) || 200;
      let h = Number(e && e.h) || 40;
      x = Math.max(0, Math.min(Math.round(x), CANVAS.w - 10));
      y = Math.max(0, Math.min(Math.round(y), CANVAS.h - 8));
      w = Math.max(12, Math.min(Math.round(w), CANVAS.w));
      h = Math.max(8, Math.min(Math.round(h), CANVAS.h));
      const text = String((e && e.text) || "").slice(0, 200);
      return { type, x, y, w, h, text };
    }).filter((e) => e.w >= 12 && e.h >= 8);
  }

  checkSyntax(js) {
    return new Promise((resolve) => {
      const file = path.join(os.tmpdir(), `sw-check-${Date.now()}-${Math.random().toString(36).slice(2)}.js`);
      fs.writeFileSync(file, js);
      const p = spawn("node", ["--check", file]);
      let err = "";
      p.stderr.on("data", (d) => { err += d.toString(); });
      p.on("error", () => { fs.unlink(file, () => {}); resolve("node not available"); });
      p.on("close", (code) => {
        fs.unlink(file, () => {});
        resolve(code === 0 ? null : (err.split("\n")[0] || "syntax error"));
      });
    });
  }

  async verify(missionId, files, elements) {
    const errors = [];
    const html = files["index.html"] || "";
    const js = files["app.js"] || "";
    const css = files["style.css"] || "";

    const check = async (name, ok, okMsg, failMsg, errPush) => {
      this.emit(missionId, "prism", "check", ok ? okMsg : failMsg, { name, ok });
      if (!ok && errPush) errors.push(errPush);
    };

    const hasTitle = /<title>[^<]{1,120}<\/title>/i.test(html);
    await check("title", hasTitle, "HTML has a <title>.", "Missing <title> element.", "index.html is missing a <title> tag");

    const hasCss = css.trim().length > 30;
    await check("stylesheet", hasCss, "Stylesheet is present.", "Stylesheet missing or too thin.", "style.css is empty or missing");

    const links = /href=["']style\.css["']/.test(html);
    await check("css-link", links, "HTML links the stylesheet.", "HTML does not link style.css.", 'index.html must include <link rel="stylesheet" href="style.css">');

    const script = /src=["']app\.js["']/.test(html);
    await check("js-link", script, "HTML includes the script.", "HTML does not include app.js.", 'index.html must include <script src="app.js"></script>');

    const interactive = /addEventListener/.test(js);
    await check("interactive", interactive, "App is interactive (event handlers found).", "No event handlers found.", "app.js must use addEventListener to be interactive");

    const syntaxErr = await this.checkSyntax(js);
    await check("syntax", !syntaxErr, "JavaScript passes node --check.", `Syntax check failed: ${syntaxErr}`, `app.js has a syntax error: ${syntaxErr}`);

    // wireframe fidelity: interactive element texts should appear in the HTML
    const flat = html.toLowerCase();
    const key = elements.filter((e) => ["heading", "button", "input"].includes(e.type) && e.text).map((e) => e.text.toLowerCase());
    if (key.length) {
      const hits = key.filter((t) => flat.includes(t)).length;
      const ratio = hits / key.length;
      await check("fidelity", ratio >= 0.6, `Wireframe fidelity: ${hits}/${key.length} texts implemented.`, `Wireframe fidelity low: ${hits}/${key.length} texts missing.`, `Prototype is missing wireframe copy (${key.length - hits} texts not found in index.html)`);
    }
    return errors;
  }

  // ---------------------------------------------------------------- MUSE

  async imagine(mission) {
    const missionId = mission.id;
    this._boards[missionId] = mission.board_id;
    const t0 = Date.now();
    try {
      this.setStatus(missionId, "planning");
      this.emit(missionId, "muse", "status", "Sketching a wireframe for your idea…");
      const raw = await this.chat(mission.model, planPrompt(mission.prompt));
      const plan = this.parseJson(raw);
      if (!plan || !Array.isArray(plan.elements) || !plan.elements.length) {
        throw new Error("MUSE returned no usable wireframe (JSON parse failed)");
      }
      const elements = this.normalizeElements(plan.elements);
      if (!elements.length) throw new Error("MUSE wireframe was empty after validation");

      if (plan.thinking) this.emit(missionId, "muse", "thought", plan.thinking);
      this.emit(missionId, "muse", "plan",
        `Layout drafted: ${elements.length} elements — "${plan.name || "wireframe"}".`,
        { name: plan.name, summary: plan.summary, palette: plan.palette, elements });

      // apply the wireframe to the board and persist it
      const created = elements.map((el) => this.db.addElement(mission.board_id, el));
      this.emit(missionId, "muse", "wireframe-applied",
        `Wireframe applied to the board — ${created.length} elements placed.`,
        { elements: created, name: plan.name, summary: plan.summary, palette: plan.palette });

      this.db.updateMission(missionId, {
        status: "complete",
        plan: JSON.stringify({ name: plan.name, summary: plan.summary, palette: plan.palette, elements }),
        duration_ms: Date.now() - t0
      });
      this.finish(missionId, true);
    } catch (err) {
      this.db.updateMission(missionId, { status: "failed", error: err.message, duration_ms: Date.now() - t0 });
      this.emit(missionId, "system", "error", "Imagine failed: " + err.message);
      this.finish(missionId, false);
    }
  }

  // ---------------------------------------------------------------- SMITH + PRISM

  async prototype(mission) {
    const missionId = mission.id;
    this._boards[missionId] = mission.board_id;
    const t0 = Date.now();
    const elements = this.db.getElements(mission.board_id);
    if (!elements.length) {
      this.db.updateMission(missionId, { status: "failed", error: "board is empty", duration_ms: 0 });
      this.emit(missionId, "system", "error", "The board is empty — draw or imagine a wireframe first.");
      this.finish(missionId, false);
      return;
    }
    try {
      let files = null;
      let errors = [];
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        this.db.updateMission(missionId, { attempts: attempt });
        this.setStatus(missionId, "building");
        this.emit(missionId, "smith",
          attempt === 1 ? "status" : "revision",
          attempt === 1
            ? `Building a working prototype from ${elements.length} wireframe elements…`
            : `Revision ${attempt}: fixing ${errors.length} issue(s)…`,
          { errors });
        const raw = await this.chat(mission.model, buildPrompt(mission.prompt, elements, attempt, errors));
        files = this.parseBlocks(raw);
        if (!files["index.html"]) throw new Error("SMITH returned no HTML");
        errors = await this.verify(missionId, files, elements);
        if (!errors.length) break;
      }
      if (errors.length) {
        throw new Error(`Prototype failed verification after ${MAX_ATTEMPTS} attempts: ${errors.join("; ")}`);
      }

      // PRISM final review (best-effort — programmatic checks already passed)
      this.setStatus(missionId, "verifying");
      this.emit(missionId, "prism", "status", "Running the final review…");
      let review = { ok: true, notes: "" };
      try {
        const summary = Object.entries(files).map(([n, c]) => `${n}: ${c.length} chars`).join("\n");
        review = this.parseJson(await this.chat(mission.model, reviewPrompt(mission.prompt, summary))) || review;
      } catch { /* review is advisory */ }
      this.emit(missionId, "prism", "review", review.notes || "Prototype reviewed — structure is clean.", review);
      if (review.ok === false) throw new Error("PRISM rejected the prototype: " + (review.notes || "no notes"));

      // deploy the prototype
      const dir = path.join(this.generatedDir, missionId);
      fs.mkdirSync(dir, { recursive: true });
      for (const [name, content] of Object.entries(files)) {
        fs.writeFileSync(path.join(dir, name), content);
      }
      const previewUrl = `/p/${missionId}/index.html`;
      this.db.storeFiles(missionId, files);
      this.db.updateMission(missionId, { status: "complete", duration_ms: Date.now() - t0 });
      this.emit(missionId, "prism", "deploy", "Prototype deployed to live preview.", { previewUrl });
      this.finish(missionId, true, previewUrl);
    } catch (err) {
      this.db.updateMission(missionId, { status: "failed", error: err.message, duration_ms: Date.now() - t0 });
      this.emit(missionId, "system", "error", "Prototype failed: " + err.message);
      this.finish(missionId, false);
    }
  }
}

module.exports = { SketchEngine };
