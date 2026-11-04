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
  const POND_SCALE = 0.6;      // Pond canvas pixels per CSS pixel (soft water doesn't need full res)
  // The page overlay draws thin colour fringes, which turn blocky when upscaled: give it device pixels
  const SURFACE_SCALE = Math.min(devicePixelRatio || 1, 2);
  const STEPS_PER_SECOND = 120;

  const VERT = `#version 300 es
  in vec2 p; out vec2 uv;
  void main() { uv = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }`;

  // Everything you can tune live with ?tune on the URL. Colours are 0-1 RGB.
  const DEFAULTS = {
    noise: 0,            // 0 = smooth ridged noise, 1 = cells (Voronoi edges)
    scale: 692,          // Size of the caustic pattern, in CSS px
    speed: 1.62,         // How fast the caustics drift
    caustics: 0.21,      // Caustic brightness
    sharpness: 6.7,      // Higher = thinner, crisper caustic lines
    warp: 1.2,           // How wobbly the caustic lines are
    chroma: 0.006,       // Chromatic aberration in the caustics
    refraction: 1.5,     // How much ripples bend the caustics
    shading: 0.9,        // Ripple light and shadow on the pond
    lightMix: 0.5,       // 0 = one light from the top left (leaves a seam across each ring), 1 = crests lit evenly all round
    surface: 0.26,       // Ripple light and shadow drawn over the page
    surfaceChroma: 1.0,  // Chromatic aberration on the ripples over the page (fringe px per unit of slope / 20)
    surfaceChromaMax: 4, // Widest the ripple fringes get, in CSS px, however hard the click
    damping: 0.976,      // How long ripples last (closer to 1 = longer)
    click: 2.4,          // Strength of a click ripple
    top: [0.933, 0.973, 0.953],
    bottom: [0.776, 0.906, 0.859],
  };
  const settings = { ...DEFAULTS };
  const tuning = new URLSearchParams(location.search).has('tune');
  if (tuning) {
    try { Object.assign(settings, JSON.parse(localStorage.getItem('lilfloaty-water') || '{}')); } catch (_) { /* ignore */ }
  }

  const UPDATE = `#version 300 es
  precision highp float;
  uniform sampler2D s; uniform vec2 d; uniform float u_damping; in vec2 uv; out vec4 o;
  void main() {
    vec4 i = texture(s, uv);
    float avg = (texture(s, uv - vec2(d.x, 0.0)).r + texture(s, uv + vec2(d.x, 0.0)).r +
                 texture(s, uv - vec2(0.0, d.y)).r + texture(s, uv + vec2(0.0, d.y)).r) * 0.25;
    i.g += (avg - i.r) * 2.0;
    i.g *= u_damping;
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
  // Height with cubic B-spline filtering (4 linear taps). Plain linear filtering has a slope that
  // jumps at every sim texel, which made the normals, and the colour fringes built on them, blocky.
  float h(vec2 u) {
    vec2 tex = u / d - 0.5;
    vec2 i = floor(tex), f = tex - i;
    vec2 f2 = f * f, f3 = f2 * f;
    vec2 w0 = (1.0 - 3.0 * f + 3.0 * f2 - f3) / 6.0;
    vec2 w1 = (4.0 - 6.0 * f2 + 3.0 * f3) / 6.0;
    vec2 w3 = f3 / 6.0;
    vec2 w2 = 1.0 - w0 - w1 - w3;
    vec2 g0 = w0 + w1, g1 = w2 + w3;
    vec2 a = (i - 0.5 + w1 / g0) * d;
    vec2 b = (i + 1.5 + w3 / g1) * d;
    return g0.y * (g0.x * texture(s, a).r + g1.x * texture(s, vec2(b.x, a.y)).r) +
           g1.y * (g0.x * texture(s, vec2(a.x, b.y)).r + g1.x * texture(s, b).r);
  }
  // About half an 8-bit step of noise, to break up banding in the soft gradients
  float dither() { return (fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) / 255.0; }
  vec3 normalAt(vec2 u) {
    float k = 0.9;
    return normalize(vec3((h(u - vec2(d.x, 0.0)) - h(u + vec2(d.x, 0.0))) * k,
                          (h(u - vec2(0.0, d.y)) - h(u + vec2(0.0, d.y))) * k, 1.0));
  }
  const vec3 L = normalize(vec3(-0.45, 0.65, 0.62));
  uniform float u_lightMix;
  // A single directional light can't shade the part of a ring whose slope runs across it, which shows
  // as a seam through every ripple (bottom left to top right). Blending in height (crests light,
  // troughs dark) lights the ring evenly all the way round.
  float shadeAt(vec2 u) { return mix(dot(normalAt(u), L) - L.z, h(u), u_lightMix); }
  `;

  const POND = COMMON + `
  uniform float u_noise, u_scale, u_speed, u_caustics, u_sharpness, u_warp, u_chroma, u_refraction, u_shading;
  uniform vec3 u_top, u_bottom;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  vec2 hash2(vec2 p) { return fract(sin(vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
  }
  // Distance to the nearest cell edge (F2 - F1) for drifting Voronoi cells
  float cellEdge(vec2 p, float time) {
    vec2 i = floor(p), f = fract(p);
    float f1 = 8.0, f2 = 8.0;
    for (int y = -1; y <= 1; y++) {
      for (int x = -1; x <= 1; x++) {
        vec2 g = vec2(float(x), float(y));
        vec2 jitter = 0.5 + 0.42 * sin(time + 6.2831 * hash2(i + g));
        float dist = length(g + jitter - f);
        if (dist < f1) { f2 = f1; f1 = dist; } else if (dist < f2) { f2 = dist; }
      }
    }
    return f2 - f1;
  }
  float caustic(vec2 p, float time) {
    if (u_noise > 0.5) {
      vec2 w = vec2(noise(p * 0.9 + time * 0.05), noise(p * 0.9 + vec2(5.2, 1.3) - time * 0.05)) - 0.5;
      p += w * u_warp;
      float a = 1.0 - smoothstep(0.0, 0.6, cellEdge(p, time * 0.7));
      float b = 1.0 - smoothstep(0.0, 0.6, cellEdge(p * 1.6 + vec2(3.1, 7.7), time * 0.5));
      return pow(a, u_sharpness) + 0.55 * pow(b, u_sharpness);
    }
    vec2 w = vec2(noise(p * 1.3 + time * 0.05), noise(p * 1.3 + vec2(5.2, 1.3) - time * 0.04));
    float v = noise(p * 2.0 + w * u_warp + time * 0.03);
    float v2 = noise(p * 3.1 - w * u_warp * 0.8 - time * 0.02);
    return pow(1.0 - abs(v * 2.0 - 1.0), u_sharpness * 1.4) * 0.7 + pow(1.0 - abs(v2 * 2.0 - 1.0), u_sharpness * 1.8) * 0.4;
  }
  void main() {
    vec3 n = normalAt(uv);
    float time = t * u_speed;
    vec2 px = uv * res;
    vec2 p = (px + vec2(0.0, scroll * 0.35)) / u_scale + n.xy * u_refraction;
    vec3 col = mix(u_bottom, u_top, smoothstep(0.0, 1.0, uv.y));
    col = mix(col, u_bottom * 0.9, noise(p * 0.35 + time * 0.01) * 0.3);
    // Cheap dispersion: red and blue see the pattern slightly shifted, more so where the water bends
    vec2 split = (vec2(0.7, 0.45) + n.xy * 6.0) * u_chroma;
    vec3 light = vec3(caustic(p + split, time), caustic(p, time), caustic(p - split, time));
    col += light * u_caustics * vec3(1.0, 1.12, 1.05);
    float shade = shadeAt(uv);
    col += shade * u_shading * vec3(0.95, 1.0, 0.97);
    float spec = pow(max(dot(reflect(-L, n), vec3(0.0, 0.0, 1.0)), 0.0), 90.0);
    col += spec * 0.35;
    o = vec4(col + dither(), 1.0);
  }`;

  const SURFACE = COMMON + `
  uniform float u_surface, u_surfaceChroma, u_surfaceChromaMax;
  void main() {
    vec3 n = normalAt(uv);
    if (dot(n.xy, n.xy) < 1e-8) { o = vec4(0.0); return; } // Calm water: nothing to draw
    // Dispersion: red and blue refract a little more and less than green, so each highlight gets a
    // warm edge on one side and a cool one on the other, along the slope (across the ring). The width
    // grows with the slope but saturates, so a hard click gives a thin fringe, not separate rainbow bands.
    vec2 bend = n.xy * 20.0 * u_surfaceChroma;                // CSS px
    bend /= 1.0 + length(bend) / max(u_surfaceChromaMax, 0.01);
    vec2 split = bend / res;
    vec3 shade = vec3(shadeAt(uv + split), shadeAt(uv), shadeAt(uv - split));
    vec3 hi = clamp(shade * 2.8 * u_surface, 0.0, 0.6);
    float lo = clamp(-shade.g * 1.6 * u_surface, 0.0, 0.32);
    vec3 dark = vec3(0.06, 0.29, 0.21);
    float alpha = max(max(hi.r, hi.g), hi.b) + lo;
    // Dither only where there's something drawn, and keep it valid premultiplied colour
    float grain = alpha > 0.0 ? dither() : 0.0;
    alpha = clamp(alpha + grain, 0.0, 1.0);
    o = vec4(min(clamp(hi + dark * lo + grain, 0.0, 1.0), vec3(alpha)), alpha);
  }`;

  class WaterLayer {
    constructor(canvas, fragment, renderScale) {
      this.renderScale = renderScale;
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
      this.canvas.width = Math.max(1, Math.round(width * this.renderScale));
      this.canvas.height = Math.max(1, Math.round(height * this.renderScale));
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
      this.pass(this.update, u => {
        gl.uniform2f(u.d, 1 / this.simW, 1 / this.simH);
        gl.uniform1f(u.u_damping, settings.damping);
      });
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
      for (const [key, value] of Object.entries(settings)) {
        const location = u[`u_${key}`];
        if (!location) continue;
        if (Array.isArray(value)) gl.uniform3f(location, value[0], value[1], value[2]);
        else gl.uniform1f(location, value);
      }
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
    layers = [new WaterLayer(pondCanvas, POND, POND_SCALE), new WaterLayer(surfaceCanvas, SURFACE, SURFACE_SCALE)];
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
    if (e.button !== 0 || e.target.closest('.tune')) return;
    ripple(e.clientX, e.clientY, 22, settings.click);
    pads.push(e.pageX, e.pageY);
  }, { passive: true });

  addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse' || e.target.closest('.tune')) return;
    if (!lastMove || Math.hypot(e.clientX - lastMove[0], e.clientY - lastMove[1]) > 14) {
      if (lastMove) ripple(e.clientX, e.clientY, 9, 0.07);
      lastMove = [e.clientX, e.clientY];
    }
  }, { passive: true });

  // ---------- Lily pads ----------

  // ---------- Lily pads ----------
  //
  // Pads float on the page itself: they scroll with it, bounce off the left and right edges, and stop
  // at the very top and bottom of the page. Every pad is the same lily pad picture in a different size,
  // tint and (sometimes) mirrored. The picture has its highlight along the top, so pads only ever tilt a
  // little and spring back, which keeps the light coming from above.
  const LILY = new URL('img/lily.webp', document.currentScript ? document.currentScript.src : location.href).href;

  const seeded = (seed) => {
    let state = (seed * 9973 + 17) % 2147483647;
    return () => { state = (state * 16807) % 2147483647; return state / 2147483647; };
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
      const brightness = 0.82 + place() * 0.36;           // Darker to lighter greens
      const saturation = 0.9 + place() * 0.25;
      const hue = (place() - 0.5) * 16;
      el.style.filter = `brightness(${brightness.toFixed(2)}) saturate(${saturation.toFixed(2)}) hue-rotate(${hue.toFixed(1)}deg) drop-shadow(3px 7px 6px rgba(8, 60, 38, 0.3))`;
      el.innerHTML = `<img src="${LILY}" alt="" draggable="false" width="${Math.round(r * 2)}" height="${Math.round(r * 2)}">`;
      host.append(el);
      const flip = place() < 0.5 ? -1 : 1;
      const rest = (place() - 0.5) * 24;                   // Resting tilt, in degrees
      list.push({ el, r, x, y, vx: 0, vy: 0, rot: rest, rest, vr: 0, flip, phase: i * 1.7 });
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
        pad.vr += (Math.random() - 0.5) * force * 0.25;
      }
    };

    api.step = (dt, time) => {
      for (const pad of list) {
        if (dragging && dragging.pad === pad) continue;
        // A lazy current so the pads never quite sit still
        pad.vx += Math.sin(time * 0.17 + pad.phase) * 11 * dt;
        pad.vy += Math.cos(time * 0.14 + pad.phase * 1.3) * 11 * dt;
        const drag = Math.exp(-1.1 * dt);
        pad.vx *= drag; pad.vy *= drag;
        pad.vr += (pad.rest - pad.rot) * 10 * dt;
        pad.vr *= Math.exp(-3 * dt);
        pad.x += pad.vx * dt; pad.y += pad.vy * dt;
        pad.rot += pad.vr * dt;
        pad.rot = Math.max(pad.rest - 25, Math.min(pad.rest + 25, pad.rot));

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
        pad.el.style.transform = `translate3d(${pad.x - pad.r}px, ${pad.y - pad.r}px, 0) rotate(${pad.rot.toFixed(2)}deg) scale(${bob * pad.flip}, ${bob})`;
      }
    };

    return api;
  })();

  // ---------- The logo floats like the app's camera ----------
  //
  // Click it for a splash. Drag it out of the card and it floats over the window: set it down gently and
  // it stays exactly where you put it, like the webcam window. Throw it and it glides, bounces off the
  // window edges with a ripple, and settles. Once it's out, it stays on screen as you scroll; back at the
  // very top of the page, it glides home into the card.

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
    let leftTop = false;       // Has the page been scrolled away from the top since the logo came out?
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
      leftTop = scrollY > 80;
      place();
    };

    const dock = () => {
      const spot = document.querySelector('.hero-icon-spot');
      if (spot) spot.replaceWith(icon);
      icon.classList.remove('floating');
      icon.style.transform = '';
      floating = moving = false;
      homing = null;
      leftTop = false;
      vx = vy = tilt = 0;
    };

    const easeOutBack = (t) => 1 + 2.2 * Math.pow(t - 1, 3) + 1.2 * Math.pow(t - 1, 2);

    addEventListener('scroll', () => {
      const now = performance.now();
      if (!floating) return;
      // Only head home after you've scrolled away and come back up to the very top
      if (scrollY > 80) {
        leftTop = true;
        if (homing) { homing = null; tilt = 0; place(); }   // Scrolled away again mid-glide: stay floating
        return;
      }
      if (drag || press || homing || !leftTop || scrollY >= 4) return;
      homing = { fromX: x, fromY: y, fromTilt: tilt, start: now };
      moving = false;
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
        const t = Math.min(1, (performance.now() - homing.start) / 1400);
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

  // ---------- Tuning panel (add ?tune to the URL) ----------

  if (tuning) {
    const controls = [
      ['noise', 'Noise', 'select', [['Cells', 1], ['Smooth', 0]]],
      ['scale', 'Pattern size', 'range', 80, 900, 1],
      ['speed', 'Drift speed', 'range', 0, 4, 0.01],
      ['caustics', 'Caustic brightness', 'range', 0, 0.8, 0.005],
      ['sharpness', 'Line sharpness', 'range', 1, 24, 0.1],
      ['warp', 'Wobble', 'range', 0, 4, 0.01],
      ['chroma', 'Caustic aberration', 'range', 0, 0.2, 0.001],
      ['refraction', 'Ripple refraction', 'range', 0, 1.5, 0.01],
      ['shading', 'Ripple shading (pond)', 'range', 0, 2.5, 0.01],
      ['lightMix', 'Ripple light: side to even', 'range', 0, 1, 0.01],
      ['surface', 'Ripple shading (page)', 'range', 0, 2.5, 0.01],
      ['surfaceChroma', 'Ripple aberration (page)', 'range', 0, 6, 0.05],
      ['surfaceChromaMax', 'Ripple aberration max (px)', 'range', 0, 30, 0.5],
      ['damping', 'Ripple length', 'range', 0.95, 0.998, 0.001],
      ['click', 'Click strength', 'range', 0, 4, 0.05],
      ['top', 'Water (top)', 'color'],
      ['bottom', 'Water (bottom)', 'color'],
    ];
    const toHex = (rgb) => '#' + rgb.map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
    const fromHex = (hex) => [1, 3, 5].map(i => +(parseInt(hex.slice(i, i + 2), 16) / 255).toFixed(3));
    const save = () => localStorage.setItem('lilfloaty-water', JSON.stringify(settings));

    const style = document.createElement('style');
    style.textContent = `
      .tune { position: fixed; right: 16px; bottom: 16px; z-index: 200; width: 290px; max-height: calc(100vh - 32px); overflow: auto;
        padding: 14px 16px 16px; border-radius: 20px; font: 13px/1.3 var(--font); color: var(--ink);
        background: rgba(255,255,255,0.86); border: 1px solid rgba(255,255,255,0.9); box-shadow: var(--shadow);
        -webkit-backdrop-filter: blur(16px); backdrop-filter: blur(16px); }
      .tune.closed > :not(header) { display: none; }
      .tune header { display: flex; align-items: center; justify-content: space-between; font-weight: 800; font-size: 14px; margin-bottom: 8px; }
      .tune.closed header { margin: 0; }
      .tune header button { border: 0; background: rgba(31,138,76,0.12); color: var(--leaf-deep); border-radius: 999px; padding: 4px 10px; font: 700 12px var(--font); cursor: pointer; }
      .tune label { display: grid; grid-template-columns: 1fr auto; gap: 2px 8px; margin: 9px 0; font-weight: 600; }
      .tune label output { color: var(--ink-soft); font-variant-numeric: tabular-nums; }
      .tune input[type=range], .tune select { grid-column: 1 / -1; width: 100%; accent-color: var(--leaf); }
      .tune input[type=color] { width: 44px; height: 24px; border: 0; padding: 0; background: none; }
      .tune .row { display: flex; gap: 8px; margin-top: 12px; }
      .tune .row button { flex: 1; border: 0; border-radius: 999px; padding: 9px 10px; font: 700 13px var(--font); cursor: pointer; background: var(--leaf); color: #fff; }
      .tune .row button + button { background: rgba(31,138,76,0.12); color: var(--leaf-deep); }
    `;
    document.head.append(style);

    const panel = document.createElement('section');
    panel.className = 'tune';
    panel.setAttribute('aria-label', 'Water settings');
    panel.innerHTML = `<header>Water settings <button type="button" data-act="toggle">Hide</button></header>`;
    const inputs = {};
    for (const [key, label, type, a, b, step] of controls) {
      const row = document.createElement('label');
      if (type === 'select') {
        row.innerHTML = `<span>${label}</span><output></output><select>${a.map(([name, v]) => `<option value="${v}">${name}</option>`).join('')}</select>`;
      } else if (type === 'color') {
        row.innerHTML = `<span>${label}</span><input type="color">`;
      } else {
        row.innerHTML = `<span>${label}</span><output></output><input type="range" min="${a}" max="${b}" step="${step}">`;
      }
      const input = row.querySelector('select, input');
      const out = row.querySelector('output');
      const show = () => {
        if (type === 'color') input.value = toHex(settings[key]);
        else input.value = settings[key];
        if (out && type === 'range') out.textContent = (+settings[key]).toFixed(step < 0.01 ? 3 : step < 1 ? 2 : 0);
      };
      input.addEventListener('input', () => {
        settings[key] = type === 'color' ? fromHex(input.value) : +input.value;
        show();
        save();
        lastActivity = performance.now();
      });
      inputs[key] = show;
      show();
      panel.append(row);
    }
    const buttons = document.createElement('div');
    buttons.className = 'row';
    buttons.innerHTML = `<button type="button" data-act="copy">Copy settings</button><button type="button" data-act="reset">Reset</button>`;
    panel.append(buttons);
    panel.addEventListener('click', async (e) => {
      const act = e.target.dataset && e.target.dataset.act;
      if (act === 'toggle') {
        panel.classList.toggle('closed');
        e.target.textContent = panel.classList.contains('closed') ? 'Show' : 'Hide';
      } else if (act === 'copy') {
        const text = JSON.stringify(settings, null, 2);
        try { await navigator.clipboard.writeText(text); e.target.textContent = 'Copied!'; }
        catch (_) { prompt('Copy these settings:', text); }
        setTimeout(() => { e.target.textContent = 'Copy settings'; }, 1500);
      } else if (act === 'reset') {
        Object.assign(settings, DEFAULTS);
        localStorage.removeItem('lilfloaty-water');
        Object.values(inputs).forEach(show => show());
      }
    });
    document.body.append(panel);
  }

  // A welcome ripple from behind the logo so people notice the water
  setTimeout(() => {
    const logoBox = document.querySelector('.hero-icon');
    if (logoBox && scrollY < height) {
      const box = logoBox.getBoundingClientRect();
      ripple(box.left + box.width / 2, box.top + box.height / 2, Math.max(40, box.width * 0.45), 1.4);
    } else {
      ripple(width * 0.5, height * 0.32, 40, 1.4);
    }
  }, 500);
})();
