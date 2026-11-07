/**
 * SketchWire — studio frontend.
 * 2D wireframe editor with realtime WS sync, MUSE imagine missions,
 * SMITH prototype missions, and the 3D blueprint mode toggle.
 */
"use strict";

(function () {
  const $ = (id) => document.getElementById(id);

  const AGENTS = [
    { id: "muse", name: "MUSE", role: "DESIGN DIRECTOR", desc: "Imagines wireframe layouts from one sentence" },
    { id: "smith", name: "SMITH", role: "BUILDER", desc: "Turns the wireframe into a real app" },
    { id: "prism", name: "PRISM", role: "VERIFIER", desc: "Syntax checks + repairs loop, deploys" }
  ];

  const STAGE_MAP = { queued: null, planning: "planning", building: "building", verifying: "verifying", complete: "complete", failed: null };

  const state = {
    boards: [],
    boardId: null,
    boardName: "",
    elements: new Map(),
    tool: "select",
    selectedId: null,
    drag: null,
    rubber: null,
    mode: "2d",
    ws: null,
    pollTimer: null,
    lastPrompt: "",
    animating: new Set()
  };

  // ------------------------------------------------------------------ helpers

  async function api(path, opts) {
    const res = await fetch(path, opts);
    const body = await res.json().catch(() => ({}));
    return { status: res.status, body };
  }

  const post = (path, data) => api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
  const patch = (path, data) => api(path, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
  const del = (path) => api(path, { method: "DELETE" });

  function hexA(hex, a) {
    if (!hex || hex[0] !== "#") return `rgba(63,212,255,${a})`;
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${a})`;
  }

  // ------------------------------------------------------------------ agents / status

  function renderAgents(activeAgent) {
    $("agents").innerHTML = AGENTS.map((a) => {
      const active = a.id === activeAgent;
      return (
        `<div class="agent-row${active ? " active" : ""}" data-agent="${a.id}">` +
          '<span class="agent-dot"></span>' +
          `<div class="agent-info"><strong>${a.name}</strong><small>${a.role} — ${a.desc}</small></div>` +
          `<span class="agent-state">${active ? "WORKING" : "IDLE"}</span>` +
        "</div>"
      );
    }).join("");
    if (window.AgentViz) window.AgentViz.setActive(activeAgent || null);
  }

  function setPill(status) {
    const pill = $("mission-pill");
    pill.textContent = status ? status.toUpperCase() : "STANDBY";
    pill.className = "mission-pill" +
      (["queued", "planning", "building", "revision", "verifying"].includes(status) ? " live" : "") +
      (status === "complete" ? " complete" : "") +
      (status === "failed" ? " failed" : "");
  }

  function setStage(status) {
    const target = STAGE_MAP[status] || null;
    const order = ["planning", "building", "verifying", "complete"];
    const tIdx = target ? order.indexOf(target) : -1;
    $("stage-stepper").querySelectorAll(".stage").forEach((el) => {
      const idx = order.indexOf(el.dataset.stage);
      el.classList.remove("active", "done");
      if (target === null) return;
      if (idx < tIdx) el.classList.add("done");
      else if (idx === tIdx) el.classList.add(target === "complete" ? "done" : "active");
    });
  }

  // ------------------------------------------------------------------ feed

  function addFeedRow(ev) {
    const feed = $("feed");
    const hint = feed.querySelector(".feed-hint");
    if (hint) hint.remove();
    const row = document.createElement("div");
    let cls = "feed-row";
    if (ev.type === "thought") cls += " thought";
    if (ev.type === "check" && ev.data && typeof ev.data.ok === "boolean") {
      cls += ev.data.ok ? " check-pass" : " check-fail";
    }
    row.className = cls;
    const time = document.createElement("span");
    time.className = "feed-time";
    time.textContent = new Date(ev.ts || Date.now()).toLocaleTimeString([], { hour12: false });
    const agent = document.createElement("span");
    agent.className = "feed-agent " + ev.agent;
    agent.textContent = ev.agent.toUpperCase();
    const msg = document.createElement("span");
    msg.className = "feed-msg";
    msg.textContent = (ev.type === "thought" ? "⟡ " : "") + ev.message;
    row.append(time, agent, msg);
    feed.append(row);
    feed.scrollTop = feed.scrollHeight;
    if (feed.children.length > 120) feed.removeChild(feed.firstChild);
  }

  function setAgentFromStatus(status) {
    if (status === "planning") renderAgents("muse");
    else if (status === "building") renderAgents("smith");
    else if (status === "verifying") renderAgents("prism");
    else renderAgents(null);
  }

  // ------------------------------------------------------------------ boards

  async function loadBoards() {
    const { body } = await api("/api/boards");
    state.boards = body.boards || [];
    const sel = $("board-select");
    sel.innerHTML = "";
    state.boards.forEach((b) => {
      const opt = document.createElement("option");
      opt.value = b.id;
      opt.textContent = `${b.name} (${b.element_count})`;
      sel.append(opt);
    });
    if (!state.boards.length) {
      const { body: created } = await post("/api/boards", { name: "First Board" });
      state.boards = [{ id: created.board.id, name: created.board.name, element_count: 0 }];
      const opt = document.createElement("option");
      opt.value = created.board.id;
      opt.textContent = created.board.name + " (0)";
      sel.append(opt);
    }
    if (!state.boardId) selectBoard(state.boards[0].id);
    else sel.value = state.boardId;
  }

  async function selectBoard(id) {
    if (state.mode === "3d") toggleMode("2d");
    state.boardId = id;
    wsJoin();
    const { body } = await api("/api/boards/" + id);
    state.boardName = body.board.name;
    state.elements = new Map((body.elements || []).map((e) => [e.id, e]));
    state.selectedId = null;
    $("board-label").textContent = "BOARD — " + state.boardName.toUpperCase();
    renderProps();
    render();
    const sel = $("board-select");
    if (sel.value !== id) sel.value = id;
  }

  async function newBoard() {
    const name = (prompt("Board name?") || "").trim();
    if (!name) return;
    const { body } = await post("/api/boards", { name });
    state.boardId = null;
    await loadBoards();
    selectBoard(body.board.id);
  }

  // ------------------------------------------------------------------ WS

  function connectWS() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}`);
    state.ws = ws;
    ws.onopen = () => { wsJoin(); $("ws-status").textContent = "LIVE"; $("ws-status").className = "status-value online"; };
    ws.onclose = () => {
      $("ws-status").textContent = "OFFLINE";
      $("ws-status").className = "status-value offline";
      setTimeout(connectWS, 2000);
    };
    ws.onmessage = (frame) => {
      let msg;
      try { msg = JSON.parse(frame.data); } catch { return; }
      handleWS(msg);
    };
  }

  function wsJoin() {
    if (state.ws && state.ws.readyState === 1 && state.boardId) {
      state.ws.send(JSON.stringify({ kind: "join", boardId: state.boardId }));
    }
  }

  function handleWS(msg) {
    if (msg.kind === "element-added") {
      if (!state.elements.has(msg.element.id)) {
        state.elements.set(msg.element.id, msg.element);
        animateIn(msg.element.id);
        render();
      }
    } else if (msg.kind === "element-updated") {
      if (!(state.drag && state.drag.id === msg.element.id)) {
        state.elements.set(msg.element.id, msg.element);
        render();
      }
    } else if (msg.kind === "element-deleted") {
      state.elements.delete(msg.id);
      if (state.selectedId === msg.id) { state.selectedId = null; renderProps(); }
      render();
    } else if (msg.kind === "board-cleared") {
      state.elements.clear();
      state.selectedId = null;
      renderProps();
      render();
    } else if (msg.kind === "mission") {
      addFeedRow(msg.event);
      if (msg.event.type === "wireframe-applied" && msg.event.data && msg.event.data.elements) {
        for (const el of msg.event.data.elements) {
          if (!state.elements.has(el.id)) { state.elements.set(el.id, el); animateIn(el.id); }
        }
        render();
      }
    } else if (msg.kind === "mission-status") {
      setPill(msg.status);
      setStage(msg.status);
      setAgentFromStatus(msg.status);
    } else if (msg.kind === "mission-done") {
      renderAgents(null);
      if (msg.ok && msg.previewUrl) {
        showPreview(msg.previewUrl);
      } else if (msg.ok) {
        // imagine mission completed — refresh board to be safe
        api("/api/boards/" + state.boardId).then(({ body }) => {
          state.elements = new Map((body.elements || []).map((e) => [e.id, e]));
          for (const e of body.elements || []) animateIn(e.id);
          render();
          loadBoards();
        });
      }
    }
  }

  // ------------------------------------------------------------------ 2D canvas

  const c2 = $("board");
  const ctx = c2.getContext("2d");

  function elementColor(el) {
    if (el.color) return el.color;
    return {
      heading: "#e8f4ff", text: "#9fb6cc", button: "#3fd4ff",
      box: "#3f6fa8", image: "#8f7bff", divider: "#3fd4ff", input: "#58d891"
    }[el.type] || "#3fd4ff";
  }

  function drawElement(el, selected) {
    const born = state.animating.has(el.id) ? 0.25 : 1;
    const color = elementColor(el);
    ctx.save();
    ctx.globalAlpha = born;
    if (born < 1) {
      const cx = el.x + el.w / 2;
      const cy = el.y + el.h / 2;
      ctx.translate(cx, cy);
      ctx.scale(born, born);
      ctx.translate(-cx, -cy);
    }

    ctx.strokeStyle = color;
    ctx.fillStyle = hexA(color, 0.10);
    ctx.lineWidth = 1.4;

    if (el.type === "divider") {
      ctx.beginPath();
      ctx.moveTo(el.x, el.y + el.h / 2);
      ctx.lineTo(el.x + el.w, el.y + el.h / 2);
      ctx.stroke();
    } else if (el.type === "image") {
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(el.x, el.y, el.w, el.h);
      ctx.setLineDash([]);
      ctx.globalAlpha = born * 0.8;
      ctx.fillStyle = color;
      ctx.font = "700 11px Segoe UI, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("IMG", el.x + el.w / 2, el.y + el.h / 2 + 4);
    } else if (el.type === "button") {
      roundRect(el.x, el.y, el.w, el.h, 6);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = "#04070d";
      ctx.font = "700 12px Segoe UI, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(clip(el.text, el.w - 12), el.x + el.w / 2, el.y + el.h / 2 + 1);
    } else if (el.type === "input") {
      roundRect(el.x, el.y, el.w, el.h, 4);
      ctx.stroke();
      ctx.fillStyle = color;
      ctx.font = "10px Segoe UI, sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(clip(el.text || "input…", el.w - 10), el.x + 8, el.y + el.h / 2 + 1);
    } else if (el.type === "heading") {
      ctx.strokeRect(el.x, el.y, el.w, el.h);
      ctx.fillStyle = color;
      ctx.font = "700 20px Segoe UI, sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(clip(el.text, el.w - 8), el.x + 6, el.y + el.h / 2 + 1);
    } else if (el.type === "text") {
      ctx.strokeStyle = hexA(color, 0.55);
      ctx.strokeRect(el.x, el.y, el.w, el.h);
      ctx.fillStyle = color;
      ctx.font = "12px Segoe UI, sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      wrapText(el.text, el.x + 6, el.y + 10, el.w - 12, 16);
    } else {
      ctx.strokeRect(el.x, el.y, el.w, el.h);
      ctx.globalAlpha = born * 0.6;
      ctx.fillStyle = color;
      ctx.font = "9px Segoe UI, sans-serif";
      ctx.textAlign = "left";
      ctx.fillText(clip(el.text, el.w - 8), el.x + 6, el.y + 12);
    }

    if (selected) {
      ctx.globalAlpha = 1;
      ctx.strokeStyle = "#3fd4ff";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(el.x - 3, el.y - 3, el.w + 6, el.h + 6);
      ctx.setLineDash([]);
    }
    ctx.restore();
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function clip(text, maxW) {
    let t = String(text || "");
    while (t && ctx.measureText(t).width > maxW) t = t.slice(0, -1);
    return t;
  }

  function wrapText(text, x, y, maxW, lineH) {
    const words = String(text || "").split(" ");
    let line = "";
    let yy = y;
    for (const word of words) {
      const test = line ? line + " " + word : word;
      if (ctx.measureText(test).width > maxW && line) {
        ctx.fillText(line, x, yy);
        line = word;
        yy += lineH;
      } else {
        line = test;
      }
    }
    if (line) ctx.fillText(line, x, yy);
  }

  function render() {
    ctx.clearRect(0, 0, 1000, 640);
    // drafting grid
    ctx.strokeStyle = "rgba(63, 212, 255, 0.07)";
    ctx.lineWidth = 1;
    for (let x = 0; x <= 1000; x += 20) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, 640); ctx.stroke(); }
    for (let y = 0; y <= 640; y += 20) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(1000, y); ctx.stroke(); }
    // border
    ctx.strokeStyle = "rgba(63, 212, 255, 0.35)";
    ctx.strokeRect(0.5, 0.5, 999, 639);

    for (const el of state.elements.values()) {
      drawElement(el, el.id === state.selectedId);
    }

    // rubber band preview
    if (state.rubber) {
      const r = state.rubber;
      ctx.save();
      ctx.strokeStyle = "#3fd4ff";
      ctx.setLineDash([5, 4]);
      ctx.strokeRect(Math.min(r.x1, r.x2), Math.min(r.y1, r.y2), Math.abs(r.x2 - r.x1), Math.abs(r.y2 - r.y1));
      ctx.restore();
    }

    if (!state.elements.size) {
      ctx.fillStyle = "rgba(114, 134, 160, 0.5)";
      ctx.font = "12px Segoe UI, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("Draw with the tools on the left — or describe your page and let MUSE imagine it", 500, 320);
    }
  }

  function animateIn(id) {
    state.animating.add(id);
    setTimeout(() => {
      state.animating.delete(id);
      render();
    }, 400);
    // re-render a few frames for the grow effect
    let n = 0;
    const tick = () => {
      render();
      if (++n < 8) requestAnimationFrame(tick);
    };
    tick();
  }

  // ------------------------------------------------------------------ interactions

  function toBoard(e) {
    const r = c2.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width * 1000, y: (e.clientY - r.top) / r.height * 640 };
  }

  function hitTest(x, y) {
    const list = [...state.elements.values()];
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const el = list[i];
      if (x >= el.x && x <= el.x + el.w && y >= el.y && y <= el.y + el.h) return el;
    }
    return null;
  }

  c2.addEventListener("pointerdown", (e) => {
    if (state.mode !== "2d") return;
    const p = toBoard(e);
    if (state.tool === "select") {
      const el = hitTest(p.x, p.y);
      state.selectedId = el ? el.id : null;
      if (el) state.drag = { id: el.id, dx: p.x - el.x, dy: p.y - el.y };
      renderProps();
      render();
    } else {
      state.rubber = { x1: p.x, y1: p.y, x2: p.x, y2: p.y };
    }
  });

  c2.addEventListener("pointermove", (e) => {
    if (state.mode !== "2d") return;
    const p = toBoard(e);
    if (state.drag) {
      const el = state.elements.get(state.drag.id);
      if (!el) return;
      el.x = Math.max(0, Math.min(Math.round(p.x - state.drag.dx), 1000 - el.w));
      el.y = Math.max(0, Math.min(Math.round(p.y - state.drag.dy), 640 - el.h));
      render();
    } else if (state.rubber) {
      state.rubber.x2 = Math.max(0, Math.min(p.x, 1000));
      state.rubber.y2 = Math.max(0, Math.min(p.y, 640));
      render();
    }
  });

  c2.addEventListener("pointerup", async () => {
    if (state.mode !== "2d") return;
    if (state.drag) {
      const el = state.elements.get(state.drag.id);
      state.drag = null;
      if (el) await patch("/api/elements/" + el.id, { x: el.x, y: el.y });
      renderProps();
      return;
    }
    if (state.rubber) {
      const r = state.rubber;
      state.rubber = null;
      const x = Math.round(Math.min(r.x1, r.x2));
      const y = Math.round(Math.min(r.y1, r.y2));
      const w = Math.round(Math.abs(r.x2 - r.x1));
      const h = Math.round(Math.abs(r.y2 - r.y1));
      if (w >= 12 && h >= 8 && state.tool !== "select") {
        const defs = {
          heading: { w: 400, h: 60, text: "Your Heading" },
          text: { w: 320, h: 60, text: "Body text — say something real." },
          button: { w: 160, h: 46, text: "Click Me" },
          box: { w: 300, h: 160, text: "section" },
          image: { w: 280, h: 180, text: "image" },
          divider: { w: 300, h: 10, text: "" },
          input: { w: 260, h: 40, text: "" }
        };
        const d = defs[state.tool] || defs.box;
        const { body } = await post(`/api/boards/${state.boardId}/elements`, {
          type: state.tool,
          x, y,
          w: Math.max(w, Math.min(d.w, 40)),
          h: state.tool === "divider" ? 10 : Math.max(h, Math.min(d.h, 20)),
          text: d.text
        });
        if (body.element) {
          state.elements.set(body.element.id, body.element);
          animateIn(body.element.id);
        }
      }
      render();
    }
  });

  document.addEventListener("keydown", async (e) => {
    const typing = ["TEXTAREA", "INPUT", "SELECT"].includes(document.activeElement && document.activeElement.tagName);
    if (typing) return;
    if ((e.key === "Delete" || e.key === "Backspace") && state.selectedId) {
      await del("/api/elements/" + state.selectedId);
      state.elements.delete(state.selectedId);
      state.selectedId = null;
      renderProps();
      render();
    }
  });

  // tool palette
  $("tool-grid").addEventListener("click", (e) => {
    const btn = e.target.closest(".tool-btn");
    if (!btn) return;
    document.querySelectorAll(".tool-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    state.tool = btn.dataset.tool;
    c2.style.cursor = state.tool === "select" ? "default" : "crosshair";
  });

  $("clear-board-btn").addEventListener("click", async () => {
    if (!confirm("Clear every element on this board?")) return;
    await del(`/api/boards/${state.boardId}/elements`);
    state.elements.clear();
    state.selectedId = null;
    renderProps();
    render();
  });

  // ------------------------------------------------------------------ properties

  function renderProps() {
    const zone = $("props-zone");
    const el = state.selectedId ? state.elements.get(state.selectedId) : null;
    if (!el) {
      zone.innerHTML = '<div class="empty">Select an element to edit it.</div>';
      return;
    }
    zone.innerHTML =
      `<div class="props-row"><label>TEXT</label><input type="text" id="prop-text" value=""></div>` +
      `<div class="props-row"><label>TYPE / POSITION</label><div class="props-meta" id="prop-meta"></div></div>`;
    $("prop-text").value = el.text || "";
    $("prop-meta").textContent = `${el.type} • x:${Math.round(el.x)} y:${Math.round(el.y)} • ${Math.round(el.w)}×${Math.round(el.h)}`;
    let timer = null;
    $("prop-text").addEventListener("input", async (ev) => {
      el.text = ev.target.value;
      render();
      clearTimeout(timer);
      timer = setTimeout(async () => {
        await patch("/api/elements/" + el.id, { text: ev.target.value });
      }, 400);
    });
  }

  // ------------------------------------------------------------------ missions

  async function imagine() {
    const prompt = $("imagine-input").value.trim();
    const model = $("model-select").value;
    const errBox = $("imagine-error");
    errBox.textContent = "";
    if (prompt.length < 4) { errBox.textContent = "Describe the page you want first."; return; }
    if (!model) { errBox.textContent = "No Ollama model available."; return; }
    $("imagine-btn").disabled = true;
    $("imagine-btn").textContent = "✦ MUSE IS SKETCHING…";
    state.lastPrompt = prompt;
    $("feed").innerHTML = "";
    setPill("queued");
    setStage("queued");
    const { status, body } = await post("/api/missions", { boardId: state.boardId, prompt, model, kind: "imagine" });
    $("imagine-btn").disabled = false;
    $("imagine-btn").textContent = "✦ IMAGINE WIREFRAME";
    if (status !== 201 || !body.ok) { errBox.textContent = body.error || "Mission rejected."; setPill("failed"); return; }
    startPolling(body.missionId);
  }

  async function buildPrototype() {
    const model = $("model-select").value;
    const errBox = $("imagine-error");
    errBox.textContent = "";
    if (!state.elements.size) { errBox.textContent = "The board is empty — draw or imagine a wireframe first."; return; }
    if (!model) { errBox.textContent = "No Ollama model available."; return; }
    $("prototype-btn").disabled = true;
    $("prototype-btn").textContent = "⚒ SMITH IS BUILDING…";
    $("feed").innerHTML = "";
    setPill("queued");
    setStage("queued");
    const { status, body } = await post("/api/missions", {
      boardId: state.boardId,
      prompt: state.lastPrompt || (state.boardName + " page"),
      model,
      kind: "prototype"
    });
    $("prototype-btn").disabled = false;
    $("prototype-btn").textContent = "⚒ BUILD REAL APP FROM BOARD";
    if (status !== 201 || !body.ok) { errBox.textContent = body.error || "Mission rejected."; setPill("failed"); return; }
    startPolling(body.missionId);
  }

  function startPolling(missionId) {
    if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
    let lastEvent = 0;
    let lastStatus = null;
    let lastKind = null;

    const poll = async () => {
      const { body } = await api("/api/missions/" + missionId);
      if (!body.mission) { clearInterval(state.pollTimer); state.pollTimer = null; return; }
      lastKind = body.mission.kind;
      if (body.mission.status !== lastStatus) {
        lastStatus = body.mission.status;
        setPill(lastStatus);
        setStage(lastStatus);
        setAgentFromStatus(lastStatus);
      }
      for (let i = lastEvent; i < body.events.length; i += 1) {
        const ev = body.events[i];
        addFeedRow(ev);
        if (ev.type === "wireframe-applied" && ev.data && ev.data.elements) {
          for (const el of ev.data.elements) {
            if (!state.elements.has(el.id)) { state.elements.set(el.id, el); animateIn(el.id); }
          }
          render();
          loadBoards();
        }
      }
      lastEvent = body.events.length;

      if (body.mission.status === "complete" || body.mission.status === "failed") {
        clearInterval(state.pollTimer);
        state.pollTimer = null;
        renderAgents(null);
        if (body.mission.status === "failed") setPill("failed");
        if (body.mission.kind === "prototype" && body.mission.status === "complete") {
          const previewUrl = `/p/${missionId}/index.html`;
          showPreview(previewUrl, body.mission);
        } else if (body.mission.status === "complete") {
          loadBoards();
        }
      }
    };
    poll();
    state.pollTimer = setInterval(poll, 1200);
  }

  function showPreview(previewUrl, mission) {
    const zone = $("preview-zone");
    zone.innerHTML = "";
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts");
    frame.src = previewUrl;
    frame.title = "Prototype preview";
    zone.append(frame);
    $("preview-actions").classList.remove("hidden");
    $("preview-link").href = previewUrl;
    const dlLink = $("preview-download");
    if (dlLink && mission && mission.id) dlLink.href = "/api/missions/" + mission.id + "/download";
    const meta = $("preview-meta");
    if (mission) {
      const secs = mission.duration_ms ? Math.round(mission.duration_ms / 1000) : null;
      meta.innerHTML = "";
      const l1 = document.createElement("div");
      l1.textContent = `ATTEMPTS: ${mission.attempts || 1}` + (secs ? ` • FORGED IN ${secs}s` : "");
      l1.className = "meta-strong";
      meta.append(l1);
    }
  }

  // ------------------------------------------------------------------ mode toggle

  function toggleMode(mode) {
    state.mode = mode;
    const in3d = mode === "3d";
    $("mode-2d").classList.toggle("active", !in3d);
    $("mode-3d").classList.toggle("active", in3d);
    c2.classList.toggle("hidden", in3d);
    $("board3d").classList.toggle("hidden", !in3d);
    if (in3d) {
      window.Blueprint3D.start($("board3d"), () => [...state.elements.values()]);
    } else {
      window.Blueprint3D.stop();
      render();
    }
  }

  $("mode-2d").addEventListener("click", () => toggleMode("2d"));
  $("mode-3d").addEventListener("click", () => toggleMode("3d"));

  // ------------------------------------------------------------------ ollama

  async function refreshOllama() {
    const el = $("ollama-status");
    const sel = $("model-select");
    try {
      const { body } = await api("/api/ollama/status");
      if (body.online) {
        el.textContent = "ONLINE";
        el.className = "status-value online";
        sel.innerHTML = "";
        if (body.models.length) {
          body.models.forEach((m) => {
            const opt = document.createElement("option");
            opt.value = m;
            opt.textContent = m;
            sel.append(opt);
          });
          const coder = body.models.find((m) => m.includes("coder"));
          if (coder) sel.value = coder;
        } else {
          sel.innerHTML = '<option value="">no models — run `ollama pull qwen2.5-coder:3b`</option>';
        }
      } else {
        el.textContent = "OFFLINE";
        el.className = "status-value offline";
        sel.innerHTML = '<option value="">install Ollama first</option>';
      }
    } catch {
      el.textContent = "OFFLINE";
      el.className = "status-value offline";
    }
  }

  // ------------------------------------------------------------------ boot

  renderAgents(null);
  setStage("standby");
  render();
  connectWS();
  loadBoards();
  refreshOllama();
  setInterval(refreshOllama, 20000);

  $("imagine-btn").addEventListener("click", imagine);
  $("prototype-btn").addEventListener("click", buildPrototype);
  $("new-board-btn").addEventListener("click", newBoard);
  $("board-select").addEventListener("change", (e) => selectBoard(e.target.value));
})();
