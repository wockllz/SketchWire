/**
 * SketchWire — mock Ollama server for tests.
 * Responds like a real Ollama /api/chat endpoint so the full pipeline
 * (MUSE → SMITH → PRISM, including the repair loop) can be tested
 * with zero model and zero cost.
 *
 * Set MOCK_FAIL_ONCE=1 to make the FIRST SMITH call return broken
 * JavaScript — the engine must repair it on attempt 2.
 */
"use strict";

const http = require("http");

const PORT = Number(process.env.MOCK_PORT) || 11510;
let failOnce = process.env.MOCK_FAIL_ONCE === "1";
let smithCalls = 0;

const MUSE_WIREFRAME = JSON.stringify({
  thinking: "A landing page needs a clear hero, one primary action, and a place to capture emails.",
  name: "coffee-house",
  summary: "A cozy coffee shop landing page with a hero, menu highlights and a newsletter signup.",
  palette: ["#171019", "#f2e6d8", "#c98a4b"],
  elements: [
    { type: "box", x: 0, y: 0, w: 1000, h: 60, text: "nav" },
    { type: "heading", x: 60, y: 110, w: 620, h: 90, text: "Bold Coffee, Zero Pretense" },
    { type: "text", x: 60, y: 220, w: 520, h: 60, text: "Small-batch roasts, brewed with obsessive care." },
    { type: "button", x: 60, y: 310, w: 180, h: 52, text: "Order Now" },
    { type: "image", x: 640, y: 110, w: 300, h: 252, text: "hero photo" },
    { type: "divider", x: 60, y: 400, w: 880, h: 10, text: "" },
    { type: "heading", x: 60, y: 430, w: 400, h: 50, text: "Today's Menu" },
    { type: "text", x: 60, y: 490, w: 880, h: 60, text: "Espresso, flat white, cold brew and fresh pastries." },
    { type: "input", x: 300, y: 580, w: 320, h: 40, text: "your@email.com" },
    { type: "button", x: 640, y: 580, w: 150, h: 40, text: "Subscribe" }
  ]
});

function smithGood() {
  return "```html:index.html\n" +
`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Coffee House</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <nav class="nav"><span class="logo">☕ Coffee House</span></nav>
  <header class="hero">
    <h1>Bold Coffee, Zero Pretense</h1>
    <p>Small-batch roasts, brewed with obsessive care.</p>
    <button id="order-btn">Order Now</button>
  </header>
  <img class="hero-photo" alt="hero photo" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='300' height='200'%3E%3Crect width='300' height='200' fill='%23c98a4b'/%3E%3C/svg%3E">
  <section class="menu">
    <h2>Today's Menu</h2>
    <p>Espresso, flat white, cold brew and fresh pastries.</p>
  </section>
  <footer class="signup">
    <input id="email-input" type="email" placeholder="your@email.com">
    <button id="subscribe-btn">Subscribe</button>
  </footer>
  <script src="app.js"></script>
</body>
</html>
` + "```\n" +
"```css:style.css\n" +
`:root { --bg:#171019; --cream:#f2e6d8; --accent:#c98a4b; }
* { box-sizing:border-box; margin:0; }
body { background:var(--bg); color:var(--cream); font-family:system-ui, sans-serif; }
.nav { display:flex; align-items:center; padding:14px 24px; border-bottom:1px solid rgba(242,230,216,0.15); }
.logo { font-weight:700; letter-spacing:0.06em; }
.hero { padding:64px 24px; }
.hero h1 { font-size:44px; max-width:640px; line-height:1.1; }
.hero p { margin:16px 0 24px; opacity:0.8; }
button { background:var(--accent); border:0; padding:14px 28px; font-weight:700; cursor:pointer; color:#171019; }
.hero-photo { display:block; margin:24px; border-radius:12px; }
.menu { padding:24px; border-top:1px solid rgba(242,230,216,0.12); }
.menu h2 { margin-bottom:12px; }
.signup { display:flex; gap:12px; padding:24px; }
.signup input { flex:1; padding:12px; background:transparent; border:1px solid rgba(242,230,216,0.3); color:var(--cream); }
` + "```\n" +
"```javascript:app.js\n" +
`// Coffee House interactions
document.addEventListener("DOMContentLoaded", () => {
  const order = document.getElementById("order-btn");
  const subscribe = document.getElementById("subscribe-btn");
  const email = document.getElementById("email-input");
  order.addEventListener("click", () => {
    order.textContent = "Added ✓";
  });
  subscribe.addEventListener("click", () => {
    if (email.value.includes("@")) subscribe.textContent = "Subscribed ✓";
    else email.focus();
  });
  email.addEventListener("keydown", (e) => {
    if (e.key === "Enter") subscribe.click();
  });
});
` + "```";
}

function smithBroken() {
  return "```html:index.html\n" +
`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Coffee House</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <h1>Bold Coffee, Zero Pretense</h1>
  <button id="order-btn">Order Now</button>
  <input id="email-input" placeholder="your@email.com">
  <button id="subscribe-btn">Subscribe</button>
  <script src="app.js"></script>
</body>
</html>
` + "```\n" +
"```css:style.css\n" +
`body { background:#171019; color:#f2e6d8; font-family:system-ui; padding:32px; }
h1 { font-size:40px; }
button { background:#c98a4b; border:0; padding:12px 22px; cursor:pointer; }
input { padding:10px; }
` + "```\n" +
"```javascript:app.js\n" +
`// broken on purpose — engine must catch and repair
function startOrder( {
  console.log("never parses");
}
` + "```";
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/api/tags") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ models: [{ name: "mock-coder:7b" }] }));
    return;
  }
  if (req.method === "POST" && req.url === "/api/chat") {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      let prompt = "";
      let model = "mock-coder:7b";
      try {
        const parsed = JSON.parse(body);
        model = parsed.model || model;
        const msgs = parsed.messages || [];
        prompt = (msgs[msgs.length - 1] || {}).content || "";
      } catch { /* ignore */ }

      let content = "";
      if (prompt.startsWith("You are MUSE")) {
        content = MUSE_WIREFRAME;
      } else if (prompt.startsWith("You are SMITH")) {
        smithCalls += 1;
        if (failOnce && smithCalls === 1) {
          failOnce = false;
          content = smithBroken();
        } else {
          content = smithGood();
        }
      } else if (prompt.startsWith("You are PRISM")) {
        content = JSON.stringify({ ok: true, notes: "Structure is clean and every wireframe element is implemented." });
      } else {
        content = "unknown agent";
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ model, message: { role: "assistant", content }, done: true }));
    });
    return;
  }
  res.writeHead(404);
  res.end("not found");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`mock-ollama listening on 127.0.0.1:${PORT} (failOnce=${process.env.MOCK_FAIL_ONCE === "1"})`);
});
