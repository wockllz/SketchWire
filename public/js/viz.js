/**
 * SketchWire — hero visualization.
 * A rotating wireframe cube (the sketch object) orbited by the three
 * agent sparks: MUSE, SMITH, PRISM. Zero dependencies, 60fps.
 */
"use strict";

(function () {
  const canvas = document.getElementById("viz");
  if (!canvas || !canvas.getContext) return;
  const ctx = canvas.getContext("2d");

  let W = 0;
  let H = 92;
  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    W = rect.width;
    H = 92;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  window.addEventListener("resize", resize);
  resize();

  const AGENTS = [
    { id: "muse", color: "#a78bff", speed: 1.5, phase: 0 },
    { id: "smith", color: "#3fd4ff", speed: 1.9, phase: 2.1 },
    { id: "prism", color: "#58d891", speed: 1.2, phase: 4.2 }
  ];

  let activeAgent = null;
  window.AgentViz = {
    setActive(a) { activeAgent = a; }
  };

  // wireframe cube vertices
  const V = [[-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1], [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]];
  const E = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];

  let t = 0;
  const particles = [];

  function project(p, ry, rx) {
    const cY = Math.cos(ry);
    const sY = Math.sin(ry);
    const x1 = p[0] * cY + p[2] * sY;
    const z1 = -p[0] * sY + p[2] * cY;
    const cX = Math.cos(rx);
    const sX = Math.sin(rx);
    const y1 = p[1] * cX - z1 * sX;
    const z2 = p[1] * sX + z1 * cX;
    return { x: x1, y: y1, z: z2 };
  }

  function hexA(hex, a) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${a})`;
  }

  function loop() {
    t += 0.012;
    ctx.clearRect(0, 0, W, H);
    const cx = W / 2;
    const cy = H / 2;
    const R = 24;

    // active tint
    const activeColor = (AGENTS.find((a) => a.id === activeAgent) || {}).color || "#3fd4ff";

    // glow
    const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, 70);
    glow.addColorStop(0, hexA(activeColor, 0.18));
    glow.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, H);

    // rotating cube
    const ry = t;
    const rx = 0.4 + Math.sin(t * 0.7) * 0.2;
    for (const [i, j] of E) {
      const a = project(V[i], ry, rx);
      const b = project(V[j], ry, rx);
      const depth = (a.z + b.z) / 2;
      ctx.strokeStyle = hexA(activeColor, 0.25 + 0.4 * ((depth + 2) / 4));
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx + a.x * R, cy + a.y * R);
      ctx.lineTo(cx + b.x * R, cy + b.y * R);
      ctx.stroke();
    }

    // agent sparks orbiting
    for (const a of AGENTS) {
      const ang = t * a.speed + a.phase;
      const orx = Math.cos(ang) * (W / 2 - 18);
      const ory = Math.sin(ang) * 22 + Math.sin(ang * 2) * 6;
      const x = cx + orx;
      const y = cy + ory;
      const isActive = a.id === activeAgent;
      const size = isActive ? 4 + Math.sin(t * 8) : 2.4;
      const halo = ctx.createRadialGradient(x, y, 0, x, y, size * 4.5);
      halo.addColorStop(0, hexA(a.color, isActive ? 0.9 : 0.45));
      halo.addColorStop(1, hexA(a.color, 0));
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(x, y, size * 4.5, 0, 7);
      ctx.fill();
      ctx.fillStyle = a.color;
      ctx.beginPath();
      ctx.arc(x, y, size, 0, 7);
      ctx.fill();
      if (isActive && Math.random() < 0.3) {
        particles.push({ x, y, c: a.color, life: 1 });
      }
    }

    // particles drift toward the cube
    for (let i = particles.length - 1; i >= 0; i -= 1) {
      const p = particles[i];
      p.x += (cx - p.x) * 0.04;
      p.y += (cy - p.y) * 0.04;
      p.life -= 0.02;
      if (p.life <= 0) { particles.splice(i, 1); continue; }
      ctx.fillStyle = hexA(p.c, p.life * 0.8);
      ctx.beginPath();
      ctx.arc(p.x, p.y, 1.3, 0, 7);
      ctx.fill();
    }

    requestAnimationFrame(loop);
  }

  loop();
})();
