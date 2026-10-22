/**
 * SketchWire — 3D BLUEPRINT MODE.
 * The 2D wireframe extrudes into floating 3D slabs with an animated
 * flat → isometric transition. Drag to orbit. Zero dependencies.
 */
"use strict";

window.Blueprint3D = (function () {
  let canvas = null;
  let ctx = null;
  let W = 1000;
  let H = 640;
  let raf = null;
  let running = false;
  let getElements = null;

  let yaw = 0;
  let pitch = 0;
  let tStart = 0;
  const TARGET = { yaw: 0.62, pitch: 0.46 };
  let transition = 0;
  let auto = true;

  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  let velYaw = 0;

  const DEPTH = { heading: 14, text: 9, button: 22, box: 18, image: 28, divider: 6, input: 16 };
  const COLORS = {
    heading: "#e8f4ff", text: "#9fb6cc", button: "#3fd4ff",
    box: "#3f6fa8", image: "#8f7bff", divider: "#3fd4ff", input: "#58d891"
  };
  const BOARD = { w: 1000, h: 640 };

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    W = rect.width || 1000;
    H = (rect.width || 1000) * 0.64;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // world: x right, y down (board plane z=0), z toward viewer is NEGATIVE
  function project(px, py, pz) {
    const cx = px - BOARD.w / 2;
    const cy = py - BOARD.h / 2;
    const cY = Math.cos(yaw);
    const sY = Math.sin(yaw);
    const x1 = cx * cY + pz * sY;
    const z1 = -cx * sY + pz * cY;
    const cP = Math.cos(pitch);
    const sP = Math.sin(pitch);
    const y1 = cy * cP - z1 * sP;
    const z2 = cy * sP + z1 * cP;
    const D = 2400;
    const scale = D / (D + z2);
    return { x: W / 2 + x1 * scale, y: H / 2 + y1 * scale, s: scale, z: z2 };
  }

  function line(a, b) {
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }

  function box(x, y, w, h, depth, color, label) {
    // 8 corners — board plane at z=0, top face at z=-depth (toward viewer)
    const c = [
      project(x, y, 0), project(x + w, y, 0), project(x + w, y + h, 0), project(x, y + h, 0),
      project(x, y, -depth), project(x + w, y, -depth), project(x + w, y + h, -depth), project(x, y + h, -depth)
    ];
    // top face fill
    ctx.fillStyle = color.replace(")", ", 0.08)").replace("rgb", "rgba").startsWith("rgba") ? color : color;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(c[4].x, c[4].y);
    ctx.lineTo(c[5].x, c[5].y);
    ctx.lineTo(c[6].x, c[6].y);
    ctx.lineTo(c[7].x, c[7].y);
    ctx.closePath();
    ctx.globalAlpha = 0.10;
    ctx.fillStyle = color;
    ctx.fill();
    ctx.restore();

    // edges
    ctx.strokeStyle = color;
    const edges = [
      [0, 1], [1, 2], [2, 3], [3, 0],           // base
      [4, 5], [5, 6], [6, 7], [7, 4],           // top
      [0, 4], [1, 5], [2, 6], [3, 7]            // risers
    ];
    for (const [i, j] of edges) {
      const depthAvg = (c[i].z + c[j].z) / 2;
      ctx.globalAlpha = 0.30 + 0.45 * Math.max(0, Math.min(1, (depthAvg + 700) / 1400));
      ctx.lineWidth = 1;
      line(c[i], c[j]);
    }
    ctx.globalAlpha = 1;

    // label on top face
    if (label && transition > 0.9) {
      const mid = project(x + w / 2, y + h / 2, -depth);
      if (mid.s > 0.55) {
        ctx.save();
        ctx.globalAlpha = 0.85;
        ctx.fillStyle = color;
        ctx.font = `700 ${Math.max(8, 11 * mid.s)}px Segoe UI, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(label.slice(0, 34), mid.x, mid.y);
        ctx.restore();
      }
    }
  }

  function draw(now) {
    if (!running) return;
    ctx.clearRect(0, 0, W, H);

    // transition: flat → isometric with easing
    if (tStart) {
      const t = Math.min(1, (now - tStart) / 1300);
      const e = 1 - Math.pow(1 - t, 3);
      yaw = e * TARGET.yaw;
      pitch = e * TARGET.pitch;
      transition = e;
      if (t >= 1) { tStart = 0; auto = true; }
    } else if (auto) {
      yaw += 0.0018 + velYaw;
      velYaw *= 0.95;
    }

    // stars / dust
    ctx.fillStyle = "rgba(120, 170, 220, 0.35)";
    for (let i = 0; i < 40; i += 1) {
      const sx = (i * 977 % W);
      const sy = (i * 613 % H);
      ctx.globalAlpha = 0.12 + 0.2 * Math.abs(Math.sin(now / 900 + i));
      ctx.fillRect(sx, sy, 1.4, 1.4);
    }
    ctx.globalAlpha = 1;

    // board frame slab
    box(0, 0, BOARD.w, BOARD.h, 8, "#3fd4ff", null);

    // drafting grid on the board plane
    ctx.strokeStyle = "rgba(63, 212, 255, 0.14)";
    ctx.lineWidth = 1;
    for (let gx = 0; gx <= BOARD.w; gx += 50) {
      line(project(gx, 0, 0), project(gx, BOARD.h, 0));
    }
    for (let gy = 0; gy <= BOARD.h; gy += 50) {
      line(project(0, gy, 0), project(BOARD.w, gy, 0));
    }

    // elements as extruded slabs
    const els = (typeof getElements === "function" ? getElements() : []) || [];
    for (const el of els) {
      const depth = DEPTH[el.type] || 14;
      const color = COLORS[el.type] || "#3fd4ff";
      let label = "";
      if (el.type === "heading" || el.type === "button" || el.type === "input" || el.type === "text") {
        label = el.text || "";
      }
      box(el.x, el.y, el.w, el.h, depth, color, label);
    }

    raf = requestAnimationFrame(draw);
  }

  function onDown(e) {
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    auto = false;
  }
  function onMove(e) {
    if (!dragging) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    yaw += dx * 0.006;
    pitch = Math.max(0.06, Math.min(1.15, pitch + dy * 0.005));
    velYaw = dx * 0.0006;
  }
  function onUp() {
    dragging = false;
    auto = true;
  }

  function start(c, getter) {
    canvas = c;
    ctx = canvas.getContext("2d");
    getElements = getter;
    resize();
    window.addEventListener("resize", resize);
    canvas.addEventListener("pointerdown", onDown);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    running = true;
    tStart = performance.now();
    transition = 0;
    yaw = 0;
    pitch = 0;
    raf = requestAnimationFrame(draw);
  }

  function stop() {
    running = false;
    if (raf) cancelAnimationFrame(raf);
    if (canvas) canvas.removeEventListener("pointerdown", onDown);
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
  }

  return { start, stop };
})();
