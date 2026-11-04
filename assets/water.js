/*
 * Lil Floaty Cam water.
 *
 * Two WebGL2 layers run the same height-field wave simulation:
 *  - #water-pond sits behind the page and draws the pond (refracted caustics plus ripple lighting).
 *  - #water-surface sits above the page with pointer-events off and draws only the ripple lighting,
 *    so clicks look like they disturb the whole page, the way the app ripples your camera.
 * Lily pads (home page only) are DOM elements you can push with clicks or grab and toss.
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
    const oldW = width, oldH = height;
    width = innerWidth;
    height = innerHeight;
    layers.forEach(layer => layer.resize(width, height));
    if (oldW) pads.resize(oldW, oldH); // Only after the first sizing, by which point pads exist
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
    pads.push(e.clientX, e.clientY);
  }, { passive: true });

  addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse') return;
    if (!lastMove || Math.hypot(e.clientX - lastMove[0], e.clientY - lastMove[1]) > 14) {
      if (lastMove) ripple(e.clientX, e.clientY, 9, 0.07);
      lastMove = [e.clientX, e.clientY];
    }
  }, { passive: true });

  // ---------- Lily pads ----------

  const pads = (() => {
    const host = document.getElementById('pads');
    const list = [];
    const api = { push() {}, step() {}, resize() {} };
    if (!host) return api;

    const small = width < 720;
    const seeds = [
      { x: 0.07, y: 0.30, r: 64, lotus: false },
      { x: 0.93, y: 0.22, r: 54, lotus: true },
      { x: 0.90, y: 0.78, r: 72, lotus: false },
      { x: 0.10, y: 0.84, r: 46, lotus: true },
      { x: 0.55, y: 0.96, r: 40, lotus: false },
      { x: 0.70, y: 0.08, r: 34, lotus: false },
    ].slice(0, small ? 3 : 6);

    seeds.forEach((seed, index) => {
      const r = seed.r * (small ? 0.7 : 1);
      const el = document.createElement('div');
      el.className = 'pad';
      el.style.width = el.style.height = `${r * 2}px`;
      el.innerHTML = `<svg viewBox="0 0 100 100"><use href="#lily-pad" width="100" height="100"/>${seed.lotus ? '<use href="#lotus" width="100" height="100"/>' : ''}</svg>`;
      host.append(el);
      list.push({
        el, r,
        x: seed.x * width, y: seed.y * height,
        vx: 0, vy: 0,
        rot: index * 47, vr: (index % 2 ? 1 : -1) * 4,
        phase: index * 1.7,
      });
    });

    let dragging = null;
    const samples = [];

    const padAt = (x, y) => list.find(p => Math.hypot(p.x - x, p.y - y) < p.r * 0.95);
    const canGrab = (e) => e.pointerType === 'mouse' && !e.target.closest(INTERACTIVE) && !e.target.closest(TEXTY);

    addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !canGrab(e)) return;
      const pad = padAt(e.clientX, e.clientY);
      if (!pad) return;
      e.preventDefault();
      dragging = { pad, dx: pad.x - e.clientX, dy: pad.y - e.clientY };
      samples.length = 0;
      samples.push([e.clientX, e.clientY, performance.now()]);
      document.body.classList.add('dragging');
    });

    addEventListener('pointermove', (e) => {
      if (dragging) {
        const { pad } = dragging;
        pad.x = e.clientX + dragging.dx;
        pad.y = e.clientY + dragging.dy;
        samples.push([e.clientX, e.clientY, performance.now()]);
        while (samples.length > 2 && performance.now() - samples[0][2] > 90) samples.shift();
        ripple(pad.x, pad.y, pad.r * 0.55, 0.06);
        return;
      }
      if (e.pointerType === 'mouse') {
        document.body.classList.toggle('over-pad', canGrab(e) && !!padAt(e.clientX, e.clientY));
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
      ripple(pad.x, pad.y, pad.r * 0.9, 0.5);
      dragging = null;
      document.body.classList.remove('dragging');
    });

    // Keep pads at the same relative spot when the window changes size
    api.resize = (oldW, oldH) => {
      for (const pad of list) { pad.x *= width / oldW; pad.y *= height / oldH; }
    };

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

    let lastScroll = scrollY;
    addEventListener('scroll', () => {
      const delta = scrollY - lastScroll;
      lastScroll = scrollY;
      for (const pad of list) if (!dragging || dragging.pad !== pad) pad.vy -= Math.max(-40, Math.min(40, delta)) * 2.2;
    }, { passive: true });

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

        const bounce = (speed) => Math.abs(speed) > 90;
        if (pad.x < pad.r) { if (bounce(pad.vx)) ripple(pad.r * 0.3, pad.y, pad.r * 0.7, 0.7); pad.x = pad.r; pad.vx = Math.abs(pad.vx) * 0.55; }
        if (pad.x > width - pad.r) { if (bounce(pad.vx)) ripple(width - pad.r * 0.3, pad.y, pad.r * 0.7, 0.7); pad.x = width - pad.r; pad.vx = -Math.abs(pad.vx) * 0.55; }
        if (pad.y < pad.r) { if (bounce(pad.vy)) ripple(pad.x, pad.r * 0.3, pad.r * 0.7, 0.7); pad.y = pad.r; pad.vy = Math.abs(pad.vy) * 0.55; }
        if (pad.y > height - pad.r) { if (bounce(pad.vy)) ripple(pad.x, height - pad.r * 0.3, pad.r * 0.7, 0.7); pad.y = height - pad.r; pad.vy = -Math.abs(pad.vy) * 0.55; }
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
            if (impulse > 120) ripple(a.x + nx * a.r, a.y + ny * a.r, 14, 0.5);
          }
        }
      }
      for (const pad of list) {
        const bob = 1 + Math.sin(time * 1.4 + pad.phase) * 0.015;
        pad.el.style.transform = `translate3d(${pad.x - pad.r}px, ${pad.y - pad.r}px, 0) rotate(${pad.rot}deg) scale(${bob})`;
      }
    };

    return api;
  })();

  // ---------- Hero icon: the logo makes a splash ----------

  const icon = document.querySelector('.hero-icon');
  if (icon) {
    icon.addEventListener('click', (e) => {
      const box = icon.getBoundingClientRect();
      ripple(box.left + box.width / 2, box.top + box.height / 2, box.width * 0.6, 2.2);
      icon.animate([{ transform: 'scale(1)' }, { transform: 'scale(0.88) rotate(-8deg)' }, { transform: 'scale(1.06) rotate(6deg)' }, { transform: 'scale(1)' }],
        { duration: 650, easing: 'cubic-bezier(.3,1.6,.5,1)' });
    });
  }

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
