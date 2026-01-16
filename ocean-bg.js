// Deep ocean background: lightweight WebGL shader + subtle drifting sparks
// No dependencies. Runs behind the UI on <canvas id="ocean-bg">.

(function () {
  const canvas = document.getElementById('ocean-bg');
  if (!canvas) return;

  /** @type {WebGLRenderingContext | null} */
  const gl =
    canvas.getContext('webgl', { antialias: false, alpha: true, depth: false, stencil: false, preserveDrawingBuffer: false }) ||
    canvas.getContext('experimental-webgl');
  if (!gl) return; // CSS fallback will remain
  document.body.classList.add('webgl-bg');

  const VERT = `
    attribute vec2 a_pos;
    varying vec2 v_uv;
    void main() {
      v_uv = a_pos * 0.5 + 0.5;
      gl_Position = vec4(a_pos, 0.0, 1.0);
    }
  `;

  // Very slow “breathing” flow: fbm noise with time-warped coordinates.
  // Visible-but-sparse spark specks drift gently (bioluminescent / stars).
  const FRAG = `
    precision mediump float;
    varying vec2 v_uv;
    uniform vec2 u_res;
    uniform float u_time;

    float hash21(vec2 p){
      p = fract(p*vec2(123.34, 456.21));
      p += dot(p, p+45.32);
      return fract(p.x*p.y);
    }

    float noise(vec2 p){
      vec2 i = floor(p);
      vec2 f = fract(p);
      float a = hash21(i);
      float b = hash21(i + vec2(1.0, 0.0));
      float c = hash21(i + vec2(0.0, 1.0));
      float d = hash21(i + vec2(1.0, 1.0));
      vec2 u = f*f*(3.0-2.0*f);
      return mix(a,b,u.x) + (c-a)*u.y*(1.0-u.x) + (d-b)*u.x*u.y;
    }

    float fbm(vec2 p){
      float v = 0.0;
      float a = 0.5;
      for(int i=0;i<5;i++){
        v += a * noise(p);
        p = p*2.02 + vec2(17.2, 9.3);
        a *= 0.55;
      }
      return v;
    }

    float ridge(float n){
      n = 1.0 - abs(n*2.0 - 1.0);
      return n*n;
    }

    float ridgedFbm(vec2 p){
      float v = 0.0;
      float a = 0.52;
      float w = 1.0;
      for(int i=0;i<5;i++){
        float n = noise(p);
        v += a * ridge(n) * w;
        w = mix(w, ridge(n), 0.35);
        p = p*2.03 + vec2(31.7, 19.1);
        a *= 0.55;
      }
      return v;
    }

    vec3 palette(float t){
      // brighter sapphire -> cerulean (less oppressive than deep indigo)
      vec3 a = vec3(0.04, 0.18, 0.38);
      vec3 b = vec3(0.05, 0.32, 0.58);
      vec3 c = vec3(0.10, 0.50, 0.72);
      return mix(mix(a,b,smoothstep(0.0,0.75,t)), c, smoothstep(0.45,1.0,t));
    }

    float spark(vec2 uv, float t){
      // Sparse specks: grid hash + soft circle; drift slowly
      vec2 g = uv * vec2(220.0, 140.0);
      vec2 id = floor(g);
      vec2 f = fract(g) - 0.5;
      float h = hash21(id);
      // keep very sparse
      float m = smoothstep(0.9935, 0.9998, h);
      float speed = mix(-0.012, 0.012, hash21(id+13.7));
      // drift mostly vertical
      vec2 drift = vec2(0.0, t*speed*60.0) + vec2(0.0, 0.15*sin(t*0.12 + h*6.283));
      float d = length(f + drift);
      float glow = smoothstep(0.30, 0.0, d);
      float tw = 0.65 + 0.35*sin(t*0.5 + h*6.283);
      return m * glow * tw;
    }

    void main() {
      vec2 uv = v_uv;
      float aspect = u_res.x / max(u_res.y, 1.0);
      vec2 p = uv;
      p.x *= aspect;

      float t = u_time;
      float breathe = 0.5 + 0.5*sin(t*0.075); // very slow “breathing”

      // big, slow currents
      vec2 warp = vec2(
        fbm(p*1.4 + vec2(t*0.035, -t*0.018)),
        fbm(p*1.2 + vec2(-t*0.024, t*0.030))
      );
      vec2 q = p*1.28 + (warp-0.5)*0.70;
      float n1 = fbm(q + vec2(0.0, t*0.030));
      float n2 = fbm(q*0.62 - vec2(t*0.020, t*0.014));
      float n3 = fbm(q*2.2 + vec2(t*0.010, -t*0.012));
      float n = mix(mix(n1, n2, 0.46), n3, 0.22);

      // nebula folds / creases (ridged noise)
      float r1 = ridgedFbm(q*1.15 + vec2(t*0.018, -t*0.010));
      float r2 = ridgedFbm(q*2.1  + vec2(-t*0.010, t*0.015));
      float folds = clamp(mix(r1, r2, 0.45), 0.0, 1.0);

      // depth vignette
      float vign = smoothstep(1.25, 0.15, length((uv-0.5)*vec2(1.05,1.0)));
      float depth = clamp(n*0.78 + 0.32*breathe, 0.0, 1.0);

      vec3 col = palette(depth);
      col *= 1.02 + 0.10*vign;
      col += vec3(0.03, 0.06, 0.09); // lift overall brightness a touch

      // subtle cyan mist
      float mist = smoothstep(0.48, 0.96, n) * (0.22 + 0.05*breathe);
      col += vec3(0.08, 0.26, 0.34) * mist;

      // fold highlights (dreamy 3D depth)
      float foldMask = smoothstep(0.35, 0.90, folds);
      col += vec3(0.10, 0.32, 0.38) * foldMask * (0.55 + 0.25*breathe);

      // sparks
      float sp = spark(uv, t);
      vec3 sparkCol = vec3(1.0, 0.98, 0.88) * 0.95;
      col += sparkCol * sp;

      gl_FragColor = vec4(col, 1.0);
    }
  `;

  function compile(type, src) {
    const sh = gl.createShader(type);
    if (!sh) return null;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      // eslint-disable-next-line no-console
      console.warn('ocean-bg shader compile failed:', gl.getShaderInfoLog(sh));
      return null;
    }
    return sh;
  }

  const vs = compile(gl.VERTEX_SHADER, VERT);
  const fs = compile(gl.FRAGMENT_SHADER, FRAG);
  if (!vs || !fs) return;

  const prog = gl.createProgram();
  if (!prog) return;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    // eslint-disable-next-line no-console
    console.warn('ocean-bg program link failed:', gl.getProgramInfoLog(prog));
    return;
  }
  gl.useProgram(prog);

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([
      -1, -1,
      1, -1,
      -1, 1,
      -1, 1,
      1, -1,
      1, 1,
    ]),
    gl.STATIC_DRAW
  );

  const locPos = gl.getAttribLocation(prog, 'a_pos');
  gl.enableVertexAttribArray(locPos);
  gl.vertexAttribPointer(locPos, 2, gl.FLOAT, false, 0, 0);

  const locRes = gl.getUniformLocation(prog, 'u_res');
  const locTime = gl.getUniformLocation(prog, 'u_time');

  let dpr = 1;
  function resize() {
    // Render slightly undersampled for performance; looks smooth due to blur layers.
    dpr = Math.min(2, window.devicePixelRatio || 1) * 0.85;
    const w = Math.max(1, Math.floor(window.innerWidth * dpr));
    const h = Math.max(1, Math.floor(window.innerHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      gl.viewport(0, 0, w, h);
    }
  }

  let start = performance.now();
  function frame(now) {
    resize();
    const t = (now - start) / 1000;
    gl.uniform2f(locRes, canvas.width, canvas.height);
    gl.uniform1f(locTime, t);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    requestAnimationFrame(frame);
  }

  window.addEventListener('resize', resize, { passive: true });
  requestAnimationFrame(frame);
})();

