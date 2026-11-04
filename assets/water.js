/*
 * Lil Floaty Cam water.
 *
 * Two WebGL2 layers run the same height-field wave simulation:
 *  - #water-pond sits behind the page and draws the pond (refracted caustics plus ripple lighting).
 *  - #water-surface sits above the page with pointer-events off and draws only the ripple lighting,
 *    so clicks look like they disturb the whole page, the way the app ripples your camera.
 * Lily pads (home page only) float on the page: push them with clicks, or grab one and toss it.
 * With prefers-reduced-motion, or without WebGL2, the page keeps its static CSS pond.
 */
(() => {
  'use strict';

  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
  if (reduceMotion.matches) return;

  const SIM_SCALE = 0.25;      // Simulation texels per CSS pixel
  const RENDER_SCALE = 0.6;    // Canvas pixels per CSS pixel (soft water doesn't need full res)
  const STEPS_PER_SECOND = 120;

  const VERT = `#version 300 es
  in vec2 p; out vec2 uv;
  void main() { uv = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }`;

  const UPDATE = `#version 300 es
  precision highp float;
  uniform sampler2D s; uniform vec2 d; in vec2 uv; out vec4 o;
  void main() {
    vec4 i = texture(s, uv);
    float avg = (texture(s, uv - vec2(d.x, 0.0)).r + texture(s, uv + vec2(d.x, 0.0)).r +
                 texture(s, uv - vec2(0.0, d.y)).r + texture(s, uv + vec2(0.0, d.y)).r) * 0.25;
    i.g += (avg - i.r) * 2.0;
    i.g *= 0.986;
    i.r += i.g;
    i.r *= 0.9985;
    o = i;
  }`;

  const DROP = `#version 300 es
  precision highp float;
  uniform sampler2D s; uniform vec2 c; uniform float r; uniform float a; uniform float aspect;
  in vec2 uv; out vec4 o;
  void main() {
    vec4 i = texture(s, uv);
    vec2 q = (uv - c) * vec2(aspect, 1.0);
    float k = max(0.0, 1.0 - length(q) / r);
    i.r += (0.5 - cos(k * 3.14159265) * 0.5) * a;
    o = i;
  }`;

  const COMMON = `#version 300 es
  precision highp float;
  uniform sampler2D s; uniform vec2 d; uniform vec2 res; uniform float t; uniform float scroll;
  in vec2 uv; out vec4 o;
  float h(vec2 u) { return texture(s, u).r; }
  vec3 waterNormal() {
    float k = 0.9;
    return normalize(vec3((h(uv - vec2(d.x, 0.0)) - h(uv + vec2(d.x, 0.0))) * k,
                          (h(uv - vec2(0.0, d.y)) - h(uv + vec2(0.0, d.y))) * k, 1.0));
  }
  const vec3 L = normalize(vec3(-0.45, 0.65, 0.62));
  `;

  const POND = COMMON + `
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
  }
  float caustic(vec2 p) {
    vec2 w = vec2(noise(p * 1.3 + t * 0.05), noise(p * 1.3 + vec2(5.2, 1.3) - t * 0.04));
    float v = noise(p * 2.0 + w * 2.2 + t * 0.03);
    float v2 = noise(p * 3.1 - w * 1.7 - t * 0.02);
    return pow(1.0 - abs(v * 2.0 - 1.0), 7.0) * 0.7 + pow(1.0 - abs(v2 * 2.0 - 1.0), 9.0) * 0.4;
  }
  void main() {
    vec3 n = waterNormal();
    vec2 px = uv * res;
    vec2 p = (px + vec2(0.0, scroll * 0.35)) / 420.0 + n.xy * 0.35;
    vec3 top = vec3(0.933, 0.973, 0.953);
    vec3 bottom = vec3(0.776, 0.906, 0.859);
    vec3 col = mix(bottom, top, smoothstep(0.0, 1.0, uv.y));
    col = mix(col, vec3(0.70, 0.87, 0.81), noise(p * 0.35 + t * 0.01) * 0.35);
    col += caustic(p) * vec3(0.16, 0.20, 0.17);
    float shade = dot(n, L) - L.z;
    col += shade * vec3(0.9, 0.95, 0.92);
    float spec = pow(max(dot(reflect(-L, n), vec3(0.0, 0.0, 1.0)), 0.0), 90.0);
    col += spec * 0.35;
    o = vec4(col, 1.0);
  }`;

  const SURFACE = COMMON + `
  void main() {
    vec3 n = waterNormal();
    float shade = dot(n, L) - L.z;
    float hi = clamp(shade * 2.8, 0.0, 0.6);
    float lo = clamp(-shade * 1.6, 0.0, 0.32);
    vec3 dark = vec3(0.06, 0.29, 0.21);
    o = vec4(vec3(1.0) * hi + dark * lo, hi + lo);
  }`;

  class WaterLayer {
    constructor(canvas, fragment) {
      const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false });
      if (!gl || !(gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float'))) {
        throw new Error('WebGL2 float render targets unavailable');
      }
      this.gl = gl;
      this.canvas = canvas;
      this.update = this.program(UPDATE);
      this.drop = this.program(DROP);
      this.render = this.program(fragment);
      const buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    }

    program(fragment) {
      const gl = this.gl;
      const compile = (type, source) => {
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
        return shader;
      };
      const program = gl.createProgram();
      gl.attachShader(program, compile(gl.VERTEX_SHADER, VERT));
      gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragment));
      gl.bindAttribLocation(program, 0, 'p');
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
      const uniforms = {};
      const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
      for (let i = 0; i < count; i++) {
        const name = gl.getActiveUniform(program, i).name;
        uniforms[name] = gl.getUniformLocation(program, name);
      }
      return { program, uniforms };
    }

    resize(width, height) {
      const gl = this.gl;
      this.canvas.width = Math.max(1, Math.round(width * RENDER_SCALE));
      this.canvas.height = Math.max(1, Math.round(height * RENDER_SCALE));
      this.simW = Math.max(8, Math.round(width * SIM_SCALE));
      this.simH = Math.max(8, Math.round(height * SIM_SCALE));
      (this.targets || []).forEach(target => { gl.deleteTexture(target.texture); gl.deleteFramebuffer(target.fbo); });
      this.targets = [0, 1].map(() => {
        const texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, this.simW, this.simH, 0, gl.RGBA, gl.HALF_FLOAT, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        const fbo = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        return { texture, fbo };
      });
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('Incomplete framebuffer');
    }

    pass({ program, uniforms }, set) {
      const gl = this.gl;
      const [src, dst] = this.targets;
      gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
      gl.viewport(0, 0, this.simW, this.simH);
      gl.useProgram(program);
      gl.bindTexture(gl.TEXTURE_2D, src.texture);
      gl.uniform1i(uniforms.s, 0);
      set(uniforms);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      this.targets = [dst, src];
    }

    addDrop(x, y, radius, strength) {
      const gl = this.gl;
      this.pass(this.drop, u => {
        gl.uniform2f(u.c, x, y);
        gl.uniform1f(u.r, radius);
        gl.uniform1f(u.a, strength);
        gl.uniform1f(u.aspect, this.simW / this.simH);
      });
    }

    step() {
      const gl = this.gl;
      this.pass(this.update, u => gl.uniform2f(u.d, 1 / this.simW, 1 / this.simH));
    }

    draw(time, scroll, cssW, cssH) {
      const gl = this.gl;
      const { program, uniforms: u } = this.render;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      gl.useProgram(program);
      gl.bindTexture(gl.TEXTURE_2D, this.targets[0].texture);
      gl.uniform1i(u.s, 0);
      gl.uniform2f(u.d, 1 / this.simW, 1 / this.simH);
      if (u.res) gl.uniform2f(u.res, cssW, cssH);
      if (u.t) gl.uniform1f(u.t, time);
      if (u.scroll) gl.uniform1f(u.scroll, scroll);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
  }

  // ---------- Setup ----------

  const makeCanvas = (id) => {
    const canvas = document.createElement('canvas');
    canvas.id = id;
    canvas.className = 'water';
    canvas.setAttribute('aria-hidden', 'true');
    return canvas;
  };

  const pondCanvas = makeCanvas('water-pond');
  const surfaceCanvas = makeCanvas('water-surface');
  let layers;
  try {
    layers = [new WaterLayer(pondCanvas, POND), new WaterLayer(surfaceCanvas, SURFACE)];
  } catch (error) {
    console.info('Lil Floaty Cam: static pond (', error.message, ')');
    return;
  }
  document.body.prepend(pondCanvas);
  document.body.append(surfaceCanvas);

  let width = 0, height = 0;
  const resize = () => {
    const oldW = width;
    width = innerWidth;
    height = innerHeight;
    layers.forEach(layer => layer.resize(width, height));
    if (oldW) pads.resize(oldW); // Only after the first sizing, by which point pads exist
  };
  resize();
  let resizeTimer;
  addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(resize, 120); });

  let lastActivity = performance.now();
  const queue = [];
  /** Ripple from a point in CSS pixels (viewport). `radius` in CSS px. */
  const ripple = (x, y, radius = 18, strength = 1) => {
    queue.push([x / width, 1 - y / height, radius / height, strength]);
    lastActivity = performance.now();
  };
  window.lilFloatyRipple = ripple;

  // ---------- Pointer ----------

  const INTERACTIVE = 'a, button, input, textarea, select, summary, iframe, .video, label';
  const TEXTY = 'p, h1, h2, h3, li, img, figure, small, strong, span';

  let lastMove = null;
  addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    ripple(e.clientX, e.clientY, 22, 1.1);
    pads.push(e.pageX, e.pageY);
  }, { passive: true });

  addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse') return;
    if (!lastMove || Math.hypot(e.clientX - lastMove[0], e.clientY - lastMove[1]) > 14) {
      if (lastMove) ripple(e.clientX, e.clientY, 9, 0.07);
      lastMove = [e.clientX, e.clientY];
    }
  }, { passive: true });

  // ---------- Lily pads ----------

  // ---------- Lily pads ----------
  //
  // Pads float on the page itself: they scroll with it, bounce off the left and right edges, and stop
  // at the very top and bottom of the page. Each pad is drawn once. Only its spin changes, and the
  // lighting layers (shading, lit rim, shaded rim, drop shadow) never rotate, so light always comes
  // from the top left.

  const seeded = (seed) => {
    let state = (seed * 9973 + 17) % 2147483647;
    return () => { state = (state * 16807) % 2147483647; return state / 2147483647; };
  };

  const padSVG = (seed) => {
    const rand = seeded(seed);
    const TAU = Math.PI * 2;
    const R = 43;
    const notch = rand() * TAU;
    const half = 0.09 + rand() * 0.06;                 // Half the slit's opening at the rim (radians)
    const tipDepth = 0.5 + rand() * 0.15;              // How far the slit reaches toward the centre (1 = rim)
    const wobble2 = { amp: 0.02 + rand() * 0.02, phase: rand() * TAU };
    const wobble3 = { amp: 0.004 + rand() * 0.008, phase: rand() * TAU };
    const tilt = rand() * TAU;
    const stretch = 1 + (rand() - 0.5) * 0.1;
    const cosT = Math.cos(tilt), sinT = Math.sin(tilt);
    // Only the outline is stretched; veins are drawn afterwards to fit it, so they never look squashed
    const point = (a, scale = 1) => {
      const r = R * scale * (1 + wobble2.amp * Math.sin(2 * a + wobble2.phase) + wobble3.amp * Math.sin(3 * a + wobble3.phase));
      const x = Math.cos(a) * r, y = Math.sin(a) * r;
      const u = (x * cosT + y * sinT) * stretch, v = (-x * sinT + y * cosT) / stretch;
      return [50 + u * cosT - v * sinT, 50 + u * sinT + v * cosT];
    };
    const f = (n) => n.toFixed(2);
    const pt = (q) => `${f(q[0])} ${f(q[1])}`;

    // Rim: Catmull-Rom through points from one side of the slit around to the other
    const steps = 36;
    const rim = [];
    for (let i = 0; i <= steps; i++) rim.push(point(notch + half + (TAU - 2 * half) * (i / steps)));
    let d = `M${pt(rim[0])}`;
    for (let i = 0; i < rim.length - 1; i++) {
      const p0 = rim[Math.max(0, i - 1)], p1 = rim[i], p2 = rim[i + 1], p3 = rim[Math.min(rim.length - 1, i + 2)];
      d += ` C${f(p1[0] + (p2[0] - p0[0]) / 6)} ${f(p1[1] + (p2[1] - p0[1]) / 6)} ${f(p2[0] - (p3[0] - p1[0]) / 6)} ${f(p2[1] - (p3[1] - p1[1]) / 6)} ${pt(p2)}`;
    }
    // Slit: in to a softly rounded tip and back out
    const tip = point(notch, tipDepth);
    d += ` C${pt(point(notch - half * 0.8, 0.86))} ${pt(point(notch - 0.07, tipDepth + 0.04))} ${pt(tip)}`;
    d += ` C${pt(point(notch + 0.07, tipDepth + 0.04))} ${pt(point(notch + half * 0.8, 0.86))} ${pt(rim[0])} Z`;

    // Veins: soft tapered slivers that bend out from the centre, each a little different
    let veins = '';
    const count = 8 + Math.floor(rand() * 3);
    const swirl = (rand() < 0.5 ? -1 : 1) * (0.16 + rand() * 0.1);
    for (let i = 0; i < count; i++) {
      const a = notch + half + 0.28 + (TAU - 2 * half - 0.56) * (i / (count - 1)) + (rand() - 0.5) * 0.14;
      const edge = point(a);
      const reach = 0.8 + rand() * 0.13;
      const vx = (edge[0] - 50) * reach, vy = (edge[1] - 50) * reach;
      const len = Math.hypot(vx, vy);
      const nx = -vy / len, ny = vx / len;
      const bend = (swirl + (rand() - 0.5) * 0.12) * len;
      const width = 1.1 + rand() * 0.9;
      const along = 0.45 + rand() * 0.15;
      const start = [50 + vx * 0.05, 50 + vy * 0.05];
      const end = [50 + vx, 50 + vy];
      const c1 = [50 + vx * along + nx * bend, 50 + vy * along + ny * bend];
      const c2 = [c1[0] + nx * width, c1[1] + ny * width];
      veins += `<path d="M${pt(start)} Q${pt(c1)} ${pt(end)} Q${pt(c2)} ${pt(start)} Z"/>`;
    }

    const id = `pad${seed}`;
    const area = 'x="-15" y="-15" width="130" height="130"';
    return `<svg viewBox="0 0 100 100"><defs>` +
      `<path id="${id}s" d="${d}"/>` +
      `<clipPath id="${id}c"><use href="#${id}s" class="spin"/></clipPath>` +
      // Lit rim: the pad minus a copy nudged away from the light
      `<mask id="${id}hi" maskUnits="userSpaceOnUse" ${area}><use href="#${id}s" class="spin" fill="#fff"/><use href="#${id}s" class="spin" data-shift="2.4 3.2" fill="#000" filter="url(#pad-soft)"/></mask>` +
      // Shaded rim: the pad minus a copy nudged toward the light
      `<mask id="${id}lo" maskUnits="userSpaceOnUse" ${area}><use href="#${id}s" class="spin" fill="#fff"/><use href="#${id}s" class="spin" data-shift="-2.6 -3.4" fill="#000" filter="url(#pad-soft)"/></mask>` +
      `</defs>` +
      `<g class="spin"><use href="#${id}s" fill="url(#pad-fill)"/><g fill="url(#pad-vein)">${veins}</g></g>` +
      `<rect ${area} fill="url(#pad-shade)" clip-path="url(#${id}c)"/>` +
      `<rect ${area} fill="#9af5b8" fill-opacity="0.8" mask="url(#${id}hi)"/>` +
      `<rect ${area} fill="#02301a" fill-opacity="0.4" mask="url(#${id}lo)"/>` +
      `<use href="#${id}s" class="spin" fill="none" stroke="#0a3d22" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
  };

  const pads = (() => {
    const host = document.getElementById('pads');
    const list = [];
    const api = { push() {}, step() {}, resize() {} };
    if (!host) return api;

    let docH = 0;
    const measure = () => {
      host.style.height = '0px';
      docH = document.documentElement.scrollHeight;
      host.style.height = `${docH}px`;
    };
    measure();

    // A ripple at a page position, if that spot is on screen
    const splash = (x, y, radius, strength) => {
      const vy = y - scrollY;
      if (vy > -radius && vy < height + radius) ripple(x, vy, radius, strength);
    };

    // Scatter pads down the page, mostly along the sides where they don't sit under the text
    const small = width < 720;
    const place = seeded(42);
    const count = Math.max(5, Math.round(docH / (small ? 950 : 620)));
    for (let i = 0; i < count; i++) {
      const r = small ? 24 + place() * 18 : 32 + place() * 40;
      const side = i % 4 === 3 ? 'middle' : (i % 2 ? 'right' : 'left');
      const x = side === 'left' ? r + place() * width * 0.1
        : side === 'right' ? width - r - place() * width * 0.1
        : width * (0.3 + place() * 0.4);
      const y = Math.min(docH - r, Math.max(r, ((i + 0.5) / count + (place() - 0.5) * 0.4 / count) * docH));
      const el = document.createElement('div');
      el.className = 'pad';
      el.style.width = el.style.height = `${r * 2}px`;
      el.innerHTML = padSVG(i + 1);
      host.append(el);
      const spinners = [...el.querySelectorAll('.spin')].map(node => ({ node, shift: node.dataset.shift }));
      list.push({ el, r, x, y, vx: 0, vy: 0, rot: place() * 360, vr: (place() - 0.5) * 10, shownRot: null, spinners, phase: i * 1.7 });
    }

    let remeasure;
    new ResizeObserver(() => { clearTimeout(remeasure); remeasure = setTimeout(measure, 100); }).observe(document.querySelector('main') || document.body);

    let dragging = null;
    const samples = [];

    const padAt = (x, y) => list.find(p => Math.hypot(p.x - x, p.y - y) < p.r * 0.95);
    const canGrab = (e) => e.pointerType === 'mouse' && !e.target.closest(INTERACTIVE) && !e.target.closest(TEXTY);

    addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !canGrab(e)) return;
      const pad = padAt(e.pageX, e.pageY);
      if (!pad) return;
      e.preventDefault();
      dragging = { pad, dx: pad.x - e.pageX, dy: pad.y - e.pageY };
      samples.length = 0;
      samples.push([e.pageX, e.pageY, performance.now()]);
      document.body.classList.add('dragging');
    });

    addEventListener('pointermove', (e) => {
      if (dragging) {
        const { pad } = dragging;
        pad.x = e.pageX + dragging.dx;
        pad.y = e.pageY + dragging.dy;
        samples.push([e.pageX, e.pageY, performance.now()]);
        while (samples.length > 2 && performance.now() - samples[0][2] > 90) samples.shift();
        splash(pad.x, pad.y, pad.r * 0.55, 0.06);
        return;
      }
      if (e.pointerType === 'mouse') {
        document.body.classList.toggle('over-pad', canGrab(e) && !!padAt(e.pageX, e.pageY));
      }
    }, { passive: true });

    addEventListener('pointerup', () => {
      if (!dragging) return;
      const { pad } = dragging;
      if (samples.length > 1) {
        const [x0, y0, t0] = samples[0];
        const [x1, y1, t1] = samples[samples.length - 1];
        const dt = Math.max(16, t1 - t0) / 1000;
        pad.vx = Math.max(-2600, Math.min(2600, (x1 - x0) / dt));
        pad.vy = Math.max(-2600, Math.min(2600, (y1 - y0) / dt));
        pad.vr += pad.vx * 0.02;
      }
      splash(pad.x, pad.y, pad.r * 0.9, 0.5);
      dragging = null;
      document.body.classList.remove('dragging');
    });

    // Keep pads in the same relative spot across the page when the window changes width
    api.resize = (oldW) => {
      measure();
      for (const pad of list) { pad.x *= width / oldW; pad.y = Math.min(pad.y, docH - pad.r); }
    };

    // Clicks push nearby pads away (in page coordinates)
    api.push = (x, y) => {
      for (const pad of list) {
        if (dragging && dragging.pad === pad) continue;
        const dx = pad.x - x, dy = pad.y - y;
        const dist = Math.hypot(dx, dy) || 1;
        const reach = 260;
        if (dist > reach) continue;
        const force = (1 - dist / reach) * 520;
        pad.vx += (dx / dist) * force;
        pad.vy += (dy / dist) * force;
        pad.vr += (Math.random() - 0.5) * force * 0.15;
      }
    };

    api.step = (dt, time) => {
      for (const pad of list) {
        if (dragging && dragging.pad === pad) continue;
        // A lazy current so the pads never quite sit still
        pad.vx += Math.sin(time * 0.13 + pad.phase) * 4 * dt;
        pad.vy += Math.cos(time * 0.11 + pad.phase * 1.3) * 4 * dt;
        const drag = Math.exp(-1.3 * dt);
        pad.vx *= drag; pad.vy *= drag;
        pad.vr *= Math.exp(-1.6 * dt);
        pad.x += pad.vx * dt; pad.y += pad.vy * dt;
        pad.rot += pad.vr * dt;

        const hard = (speed) => Math.abs(speed) > 90;
        if (pad.x < pad.r) { if (hard(pad.vx)) splash(pad.r * 0.3, pad.y, pad.r * 0.7, 0.7); pad.x = pad.r; pad.vx = Math.abs(pad.vx) * 0.55; }
        if (pad.x > width - pad.r) { if (hard(pad.vx)) splash(width - pad.r * 0.3, pad.y, pad.r * 0.7, 0.7); pad.x = width - pad.r; pad.vx = -Math.abs(pad.vx) * 0.55; }
        if (pad.y < pad.r) { if (hard(pad.vy)) splash(pad.x, pad.r * 0.3, pad.r * 0.7, 0.7); pad.y = pad.r; pad.vy = Math.abs(pad.vy) * 0.55; }
        if (pad.y > docH - pad.r) { if (hard(pad.vy)) splash(pad.x, docH - pad.r * 0.3, pad.r * 0.7, 0.7); pad.y = docH - pad.r; pad.vy = -Math.abs(pad.vy) * 0.55; }
      }
      // Pads nudge each other apart
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const a = list[i], b = list[j];
          const dx = b.x - a.x, dy = b.y - a.y;
          const dist = Math.hypot(dx, dy) || 1;
          const overlap = a.r + b.r - dist;
          if (overlap <= 0) continue;
          const nx = dx / dist, ny = dy / dist;
          const aFixed = dragging && dragging.pad === a, bFixed = dragging && dragging.pad === b;
          const share = aFixed ? 0 : bFixed ? 1 : 0.5;
          a.x -= nx * overlap * share; a.y -= ny * overlap * share;
          b.x += nx * overlap * (1 - share); b.y += ny * overlap * (1 - share);
          const relative = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
          if (relative < 0) {
            const impulse = -relative * 0.8;
            if (!aFixed) { a.vx -= nx * impulse * (bFixed ? 2 : 1); a.vy -= ny * impulse * (bFixed ? 2 : 1); a.vr -= impulse * 0.05; }
            if (!bFixed) { b.vx += nx * impulse * (aFixed ? 2 : 1); b.vy += ny * impulse * (aFixed ? 2 : 1); b.vr += impulse * 0.05; }
            if (impulse > 120) splash(a.x + nx * a.r, a.y + ny * a.r, 14, 0.5);
          }
        }
      }
      for (const pad of list) {
        const bob = 1 + Math.sin(time * 1.4 + pad.phase) * 0.015;
        pad.el.style.transform = `translate3d(${pad.x - pad.r}px, ${pad.y - pad.r}px, 0) scale(${bob})`;
        // Spin only the leaf, never its lighting; skip pads that are off screen or barely turned
        const onScreen = pad.y + pad.r > scrollY - 50 && pad.y - pad.r < scrollY + height + 50;
        if (onScreen && (pad.shownRot === null || Math.abs(pad.rot - pad.shownRot) > 0.25)) {
          pad.shownRot = pad.rot;
          const turn = `rotate(${pad.rot.toFixed(2)} 50 50)`;
          for (const { node, shift } of pad.spinners) node.setAttribute('transform', shift ? `translate(${shift}) ${turn}` : turn);
        }
      }
    };

    return api;
  })();

  // ---------- The logo floats like the app's camera ----------
  //
  // Click it for a splash. Drag it out of the card and it floats over the window: set it down gently and
  // it stays exactly where you put it, like the webcam window. Throw it and it glides, bounces off the
  // window edges with a ripple, and settles. Scrolling down knocks it out of the card off the top of the
  // window; back at the very top of the page, it glides home into the card.

  const logo = (() => {
    const icon = document.querySelector('.hero-icon');
    const api = { step() {} };
    if (!icon) return api;

    const bounceAnim = () => icon.animate(
      [{ transform: 'scale(1)' }, { transform: 'scale(0.88) rotate(-8deg)' }, { transform: 'scale(1.06) rotate(6deg)' }, { transform: 'scale(1)' }],
      { duration: 650, easing: 'cubic-bezier(.3,1.6,.5,1)', composite: 'add' });

    let floating = false;
    let x = 0, y = 0, vx = 0, vy = 0, tilt = 0, size = 0;
    let press = null;          // Pointer down, not yet a drag
    let drag = null;           // Active drag
    let moving = false;        // Gliding after a throw
    let homing = null;         // Gliding back into the card
    const samples = [];

    const place = () => {
      icon.style.transform = `translate3d(${x - size / 2}px, ${y - size / 2}px, 0) rotate(${tilt}deg)`;
    };

    const lift = () => {
      const box = icon.getBoundingClientRect();
      size = box.width;
      x = box.left + size / 2;
      y = box.top + size / 2;
      // Hold its spot in the card so the layout doesn't jump
      const placeholder = document.createElement('div');
      placeholder.className = 'hero-icon-spot';
      placeholder.style.width = placeholder.style.height = `${size}px`;
      icon.before(placeholder);
      icon.classList.add('floating');
      document.body.append(icon);
      floating = true;
      place();
    };

    const dock = () => {
      const spot = document.querySelector('.hero-icon-spot');
      if (spot) spot.replaceWith(icon);
      icon.classList.remove('floating');
      icon.style.transform = '';
      floating = moving = false;
      homing = null;
      vx = vy = tilt = 0;
    };

    const easeOutBack = (t) => 1 + 2.2 * Math.pow(t - 1, 3) + 1.2 * Math.pow(t - 1, 2);

    let lastScrollY = scrollY, lastScrollT = performance.now();
    addEventListener('scroll', () => {
      const now = performance.now();
      const speed = (scrollY - lastScrollY) / Math.max(16, now - lastScrollT) * 1000;
      lastScrollY = scrollY; lastScrollT = now;
      if (drag || press) return;
      if (!floating && speed > 0) {
        // Reached the top of the window: pop out and bounce back down off the edge
        const box = icon.getBoundingClientRect();
        if (box.top < 6) {
          lift();
          clamp();
          place();
          vy = Math.min(2200, 420 + speed * 0.6);
          vx = (Math.random() - 0.5) * 600;
          tilt = vx * 0.02;
          moving = true;
          ripple(x, 0, size * 0.9, 1.4);
        }
      } else if (floating && !homing && scrollY < 4) {
        homing = { fromX: x, fromY: y, fromTilt: tilt, start: now };
        moving = false;
      }
    }, { passive: true });

    icon.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      homing = null;
      icon.setPointerCapture(e.pointerId);
      press = { x: e.clientX, y: e.clientY };
      samples.length = 0;
      samples.push([e.clientX, e.clientY, performance.now()]);
    });

    icon.addEventListener('pointermove', (e) => {
      if (!press && !drag) return;
      samples.push([e.clientX, e.clientY, performance.now()]);
      while (samples.length > 2 && performance.now() - samples[0][2] > 90) samples.shift();
      if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 6) {
        if (!floating) lift();
        drag = { dx: x - press.x, dy: y - press.y };
        press = null;
        moving = false;
        document.body.classList.add('dragging');
      }
      if (drag) {
        const nx = e.clientX + drag.dx, ny = e.clientY + drag.dy;
        tilt = Math.max(-14, Math.min(14, (nx - x) * 0.6));
        x = nx; y = ny;
        clamp();
        place();
        ripple(x, y, size * 0.35, 0.06);
      }
    });

    const release = () => {
      if (press) splash();
      if (drag) {
        const [x0, y0, t0] = samples[0];
        const [x1, y1, t1] = samples[samples.length - 1];
        const age = performance.now() - t1;
        const dt = Math.max(16, t1 - t0) / 1000;
        vx = Math.max(-3000, Math.min(3000, (x1 - x0) / dt));
        vy = Math.max(-3000, Math.min(3000, (y1 - y0) / dt));
        // Held still before letting go? Then it was placed, not thrown: it stays right there.
        if (age > 80 || Math.hypot(vx, vy) < 220) { vx = vy = 0; moving = false; tilt = 0; place(); }
        else moving = true;
        ripple(x, y, size * 0.6, 0.6);
        document.body.classList.remove('dragging');
      }
      press = null;
      drag = null;
    };
    // A plain click (or Enter/Space): a big splash and a wobble
    const splash = () => {
      const box = icon.getBoundingClientRect();
      ripple(box.left + box.width / 2, box.top + box.height / 2, box.width * 0.6, 2.2);
      bounceAnim();
    };
    icon.addEventListener('click', (e) => { if (e.detail === 0) splash(); });
    icon.addEventListener('pointerup', release);
    icon.addEventListener('pointercancel', release);

    const clamp = () => {
      const r = size / 2;
      x = Math.max(r, Math.min(width - r, x));
      y = Math.max(r, Math.min(height - r, y));
    };
    addEventListener('resize', () => { if (floating) { clamp(); place(); } });

    api.step = (dt) => {
      if (floating && homing && !drag) {
        const spot = document.querySelector('.hero-icon-spot');
        if (!spot) { dock(); return; }
        const box = spot.getBoundingClientRect();
        const t = Math.min(1, (performance.now() - homing.start) / 750);
        const k = easeOutBack(t);
        x = homing.fromX + (box.left + box.width / 2 - homing.fromX) * k;
        y = homing.fromY + (box.top + box.height / 2 - homing.fromY) * k;
        tilt = homing.fromTilt * (1 - t);
        place();
        if (t >= 1) { dock(); ripple(box.left + box.width / 2, box.top + box.height / 2, size * 0.6, 1); }
        return;
      }
      if (!floating || drag || !moving) return;
      const r = size / 2;
      const glide = Math.exp(-1.1 * dt);
      vx *= glide; vy *= glide;
      x += vx * dt; y += vy * dt;
      const hit = (speed) => Math.abs(speed) > 60;
      if (x < r) { if (hit(vx)) ripple(r * 0.4, y, r * 1.2, 1); x = r; vx = Math.abs(vx) * 0.6; }
      if (x > width - r) { if (hit(vx)) ripple(width - r * 0.4, y, r * 1.2, 1); x = width - r; vx = -Math.abs(vx) * 0.6; }
      if (y < r) { if (hit(vy)) ripple(x, r * 0.4, r * 1.2, 1); y = r; vy = Math.abs(vy) * 0.6; }
      if (y > height - r) { if (hit(vy)) ripple(x, height - r * 0.4, r * 1.2, 1); y = height - r; vy = -Math.abs(vy) * 0.6; }
      tilt += (Math.max(-14, Math.min(14, vx * 0.01)) - tilt) * Math.min(1, dt * 8);
      if (Math.hypot(vx, vy) < 12) { vx = vy = 0; moving = false; }
      if (Math.hypot(vx, vy) > 300 && Math.random() < 0.3) ripple(x, y, r * 0.5, 0.05);
      place();
    };

    return api;
  })();

  // ---------- Loop ----------

  const start = performance.now();
  let last = start;
  let carry = 0;
  let frame = 0;
  const loop = (now) => {
    requestAnimationFrame(loop);
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    frame++;
    const time = (now - start) / 1000;
    pads.step(dt, time);
    logo.step(dt);

    // When everything has settled, keep the caustics drifting at a gentler frame rate
    const idle = now - lastActivity > 7000;
    if (idle && frame % 3) return;

    while (queue.length) {
      const [x, y, r, a] = queue.shift();
      layers.forEach(layer => layer.addDrop(x, y, r, a));
    }
    if (!idle) {
      carry += dt * STEPS_PER_SECOND;
      const steps = Math.min(4, Math.floor(carry));
      carry -= steps;
      for (let i = 0; i < steps; i++) layers.forEach(layer => layer.step());
    }
    layers.forEach(layer => layer.draw(time, scrollY, width, height));
  };
  requestAnimationFrame(loop);

  // A welcome ripple so people notice the water
  setTimeout(() => ripple(width * 0.5, height * 0.32, 40, 1.4), 500);
})();
