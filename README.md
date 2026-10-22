# ✏️ SketchWire

**Draw a wireframe. Watch local AI agents turn it into a real, working web app. Then see it float in 3D.**

SketchWire is a real-time wireframing studio powered by a team of autonomous AI agents that run **100% locally** (via [Ollama](https://ollama.com)) — no cloud APIs, no API keys, zero cost per run.

You sketch boxes and buttons on an infinite drafting board, hit **IMAGINE** and the agents do the rest: one designs, one builds, one verifies. The generated prototype deploys to a live preview you can open instantly.

---

## ✦ What makes it different

- **Draw → App pipeline.** Sketch a layout with the 2D editor (or let MUSE imagine it from one sentence), and SMITH turns *that exact wireframe* into working HTML/CSS/JS.
- **3D BLUEPRINT mode.** Your flat wireframe extrudes into floating 3D slabs with an animated transition — drag to orbit your design in space. Zero 3D libraries, all custom canvas math.
- **Real-time collaboration.** WebSocket sync — open the studio in two browser tabs and watch elements appear live in both.
- **Verified builds.** PRISM runs real `node --check` syntax validation, structure checks and wireframe-fidelity checks. Broken code gets sent back for repairs, up to 3 attempts. AI reviewing AI.
- **Local-first.** Runs on Ollama models like `qwen2.5-coder:3b`. If your Wi-Fi dies mid-mission, nothing stops.

## 🤖 The agent team

| Agent | Role | What it does |
|-------|------|--------------|
| 🎨 **MUSE** | Design director | Turns one sentence into a full wireframe layout (JSON), sets the design direction, name and color palette |
| ⚒️ **SMITH** | Builder | Turns the board's wireframe into a complete single-page app — every element, real copy, real interactions |
| 🔺 **PRISM** | Verifier | Syntax-checks with `node --check`, validates structure + wireframe fidelity, deploys to the live preview, forces repairs when needed |

## 🚀 Quick start

**Prerequisites:** [Node.js](https://nodejs.org) 18+ and [Ollama](https://ollama.com/download) with a model pulled.

```bash
# 1. get the code
git clone https://github.com/wockllz/SketchWire.git
cd SketchWire

# 2. install
npm install

# 3. pull a model (skip if you already have one)
ollama pull qwen2.5-coder:3b     # ~1.9 GB, fits 8 GB RAM
# or: ollama pull qwen2.5-coder:7b   # better output, needs ~8 GB free RAM

# 4. launch the studio
npm start
```

Open **http://localhost:4400** and:

1. Check the top bar says `OLLAMA: ONLINE` and pick your model
2. Type an idea — e.g. *"a coffee shop landing page with a hero, menu and newsletter signup"* — and hit **✦ IMAGINE WIREFRAME**
3. Watch MUSE sketch the layout onto the board, then hit **✦ 3D BLUEPRINT** to see it float
4. Hit **⚒ BUILD REAL APP FROM BOARD** — SMITH writes the app, PRISM verifies it
5. Click **↗ OPEN PREVIEW** — that's a real, working web app

You can also draw everything yourself with the tools on the left and skip straight to BUILD.

## 🧪 Test it (no model needed)

```bash
npm run selftest                        # full end-to-end pipeline with a mock model
MOCK_FAIL_ONCE=1 npm run selftest      # also tests the broken-build repair loop
npm run demo                            # live narrated run against your real model (studio must be running)
```

The self test boots the real server plus a mock Ollama and drives the entire product: board CRUD, WebSocket realtime sync, MUSE wireframe generation, SMITH build, PRISM verification, the repair loop, and live preview serving — **32 checks, zero mocks skipped**.

## 🗂 Project structure

```
SketchWire/
├── server.js                  # Express + WebSocket server, APIs, preview serving
├── src/
│   ├── db.js                  # SQLite (boards, elements, missions, events)
│   ├── prompts.js             # MUSE / SMITH / PRISM prompt library
│   └── agents/engine.js       # imagine + prototype pipelines, repair loop
├── views/index.ejs            # the studio UI
├── public/
│   ├── css/style.css          # blueprint theme
│   └── js/
│       ├── main.js            # 2D editor, realtime sync, missions
│       ├── blueprint3d.js     # 3D blueprint mode (custom 3D projection)
│       └── viz.js              # hero visualization
└── tests/
    ├── mock-ollama.js         # offline model mock for tests
    ├── selftest.js            # 32-check end-to-end suite
    └── demo.js                # narrated live demo command
```

## 🛠 Troubleshooting

| Problem | Fix |
|---------|-----|
| `OLLAMA: OFFLINE` in the top bar | Start the Ollama app from your Start menu, wait 5s, it reconnects automatically |
| Model dropdown empty | `ollama pull qwen2.5-coder:3b` |
| Mission stuck on "queued" | Check the Ollama model is running: `ollama list` — big models load slowly on first run |
| Port 4400 already in use | `PORT=4500 npm start` (or `$env:PORT=4500; npm start` in PowerShell) |
| Self test times out on a slow machine | It allows up to 5 minutes per mission — check nothing else is eating your CPU, then rerun |

## 📄 License

MIT — do whatever you want, attribution appreciated.

---

**SketchWire** — built by [Ntshuxeko Sambo](https://github.com/wockllz) • part of a local-first AI tooling portfolio alongside [AgentForge](https://github.com/wockllz/AgentForge)
