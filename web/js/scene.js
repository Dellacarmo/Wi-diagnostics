// RF space: Three.js scene with a digital-rain dome, radar floor, estimated
// RF field, access-point nodes, signal beams and post-processing.

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { CSS2DObject, CSS2DRenderer } from "three/addons/renderers/CSS2DRenderer.js";
import { BAND_CSS, BAND_HEX, GLYPHS, LINK_CSS, LINK_HEX, REF_RSSI, RING_METERS, WORLD_R, esc, fmtDist, fromScene, toScene } from "./util.js";

const TAU = Math.PI * 2;
const FIELD_N = 176;
const FIELD_L = WORLD_R * 1.12;
const MAX_PACKETS = 600;
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

const CAMERAS = {
  orbit: { pos: [0, 30, 54], target: [0, 1.5, 0] },
  radar: { pos: [0, 92, 0.01], target: [0, 0, 0] },
  ground: { pos: [-6, 4.2, 36], target: [0, 3, 0] },
};

function glyphAtlas() {
  const c = document.createElement("canvas");
  c.width = c.height = 512;
  const g = c.getContext("2d");
  g.fillStyle = "#000";
  g.fillRect(0, 0, 512, 512);
  g.fillStyle = "#fff";
  g.font = "bold 50px 'JetBrains Mono', monospace";
  g.textAlign = "center";
  g.textBaseline = "middle";
  for (let i = 0; i < 64; i++) {
    const ch = GLYPHS[i % GLYPHS.length];
    const x = (i % 8) * 64 + 32;
    const y = Math.floor(i / 8) * 64 + 34;
    g.save();
    g.translate(x, y);
    g.scale(-1, 1); // mirrored glyphs, like the films
    g.fillText(ch, 0, 0);
    g.restore();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.NoColorSpace;
  return tex;
}

function haloTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d");
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.18, "rgba(255,255,255,0.75)");
  grad.addColorStop(0.45, "rgba(255,255,255,0.18)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

/** CSS2DRenderer rewrites the root's inline transform every frame, so the styled (offset) box is an inner div. */
function cssLabel(className, cx = 0.5, cy = 0.5) {
  const root = document.createElement("div");
  const el = document.createElement("div");
  el.className = className;
  root.appendChild(el);
  const label = new CSS2DObject(root);
  label.center.set(cx, cy);
  return { label, el };
}

const RAIN_SHADER = {
  vertex: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragment: /* glsl */ `
    uniform sampler2D uAtlas;
    uniform float uTime;
    uniform vec2 uGrid;
    uniform float uOpacity;
    uniform vec3 uColor;
    varying vec2 vUv;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    void main() {
      vec2 cell = floor(vUv * uGrid);
      vec2 local = fract(vUv * uGrid);
      float speed = 0.35 + hash(vec2(cell.x, 1.0)) * 1.1;
      float len = 6.0 + hash(vec2(cell.x, 3.0)) * 26.0;
      float offset = hash(vec2(cell.x, 7.0)) * 300.0;
      float row = uGrid.y - 1.0 - cell.y;
      float head = mod(uTime * speed * 7.0 + offset, uGrid.y + len * 2.5) - len;
      float d = head - row;
      if (d < 0.0 || d > len) discard;
      float trail = 1.0 - d / len;
      float idx = floor(hash(cell + floor(uTime * (1.5 + hash(cell) * 5.0))) * 64.0);
      vec2 g = vec2(mod(idx, 8.0), floor(idx / 8.0));
      vec2 auv = vec2((g.x + local.x) / 8.0, (7.0 - g.y + local.y) / 8.0);
      float a = texture2D(uAtlas, auv).r;
      float headGlow = smoothstep(1.5, 0.0, d);
      vec3 color = mix(uColor, vec3(0.8, 1.0, 0.88), headGlow);
      float fade = smoothstep(0.02, 0.3, vUv.y) * smoothstep(1.0, 0.72, vUv.y);
      float alpha = a * (trail * trail * 0.85 + headGlow * 1.2) * uOpacity * fade;
      gl_FragColor = vec4(color * alpha, alpha);
    }`,
};

const FLOOR_SHADER = {
  vertex: /* glsl */ `
    varying vec3 vPos;
    void main() {
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vPos = wp.xyz;
      gl_Position = projectionMatrix * viewMatrix * wp;
    }`,
  fragment: /* glsl */ `
    uniform float uTime;
    uniform float uRings[6];
    uniform float uPulse;
    uniform float uSweep;
    uniform float uRadius;
    uniform vec3 uColor;
    varying vec3 vPos;
    void main() {
      float r = length(vPos.xz);
      float ang = atan(vPos.z, vPos.x);
      float fw = fwidth(r);

      vec2 gp = vPos.xz / 2.5;
      vec2 gg = abs(fract(gp - 0.5) - 0.5) / fwidth(gp);
      float grid = 1.0 - min(min(gg.x, gg.y), 1.0);

      float ring = 0.0;
      for (int i = 0; i < 6; i++) {
        float d = abs(r - uRings[i]);
        ring = max(ring, 1.0 - smoothstep(0.0, fw * 1.6 + 0.03, d));
      }

      float a = ang / 6.2831853 * 24.0;
      float da = abs(a - floor(a + 0.5)) * 6.2831853 / 24.0 * r;
      float spoke = (1.0 - smoothstep(0.0, fwidth(da) * 1.4 + 0.01, da)) * smoothstep(1.5, 6.0, r);

      float behind = mod(uSweep - ang + 6.2831853, 6.2831853);
      float sweep = exp(-behind * 2.6) * (1.0 - smoothstep(uRadius * 0.98, uRadius * 1.02, r));
      float edge = (1.0 - smoothstep(0.0, 0.05, behind)) * (1.0 - smoothstep(uRadius * 0.98, uRadius * 1.02, r));

      float pr = uPulse * 34.0;
      float pulse = exp(-abs(r - pr) * 0.9) * exp(-uPulse * 1.4) * step(0.0, uPulse);

      float center = exp(-r * 0.35) * 0.6;
      float fall = 1.0 - smoothstep(uRadius * 0.9, uRadius * 1.5, r);

      float v = grid * 0.07 + ring * 0.5 + spoke * 0.08 + sweep * 0.16 + edge * 0.35 + pulse * 0.6 + center;
      vec3 col = uColor * v * fall;
      gl_FragColor = vec4(col, clamp(v * fall, 0.0, 1.0));
    }`,
};

const GRADE_SHADER = {
  uniforms: { tDiffuse: { value: null }, uTime: { value: 0 }, uRes: { value: new THREE.Vector2(1, 1) } },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform vec2 uRes;
    varying vec2 vUv;
    void main() {
      vec2 c = vUv - 0.5;
      float ca = dot(c, c) * 0.012;
      vec3 col;
      col.r = texture2D(tDiffuse, vUv + c * ca).r;
      col.g = texture2D(tDiffuse, vUv).g;
      col.b = texture2D(tDiffuse, vUv - c * ca).b;
      float scan = 0.97 + 0.03 * sin(vUv.y * uRes.y * 1.25 + uTime * 2.0);
      float vig = smoothstep(1.0, 0.28, length(c * vec2(1.0, 1.15)));
      float n = fract(sin(dot(vUv * uRes + uTime * 37.0, vec2(12.9898, 78.233))) * 43758.5453);
      col = col * scan * mix(0.5, 1.0, vig) + (n - 0.5) * 0.02;
      gl_FragColor = vec4(col, 1.0);
    }`,
};

export class RFScene extends EventTarget {
  constructor(container) {
    super();
    this.container = container;
    this.nodes = new Map();
    this.snapshot = null;
    this.selectedId = null;
    this.hoverId = null;
    this.labelMode = "auto";
    this.opts = { field: true, beams: true, rain: true, rotate: true };
    this.lastInteraction = 0;
    this.camTween = null;
    this.pulseStart = -10;
    this.lastScanCount = -1;
    this.clock = new THREE.Clock();
    this.tmp = new THREE.Vector3();
    this.frameCount = 0;

    this.#initRenderer();
    this.#initWorld();
    this.#initInput();
    this.#resize();
    window.addEventListener("resize", () => this.#resize());
    this.renderer.setAnimationLoop(() => this.#frame());
  }

  // ─── Setup ──────────────────────────────────────────────────────────────

  #initRenderer() {
    const r = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    r.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.05;
    this.container.appendChild(r.domElement);
    this.renderer = r;

    this.labels = new CSS2DRenderer();
    this.labels.domElement.className = "label-layer";
    this.container.appendChild(this.labels.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x010403);
    this.scene.fog = new THREE.FogExp2(0x010403, 0.0105);

    this.camera = new THREE.PerspectiveCamera(52, 1, 0.1, 2000);
    this.camera.position.set(...CAMERAS.orbit.pos);

    this.controls = new OrbitControls(this.camera, r.domElement);
    this.controls.target.set(...CAMERAS.orbit.target);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.06;
    this.controls.minDistance = 6;
    this.controls.maxDistance = 170;
    this.controls.maxPolarAngle = Math.PI * 0.49;
    this.controls.autoRotateSpeed = 0.35;
    this.controls.addEventListener("start", () => {
      this.lastInteraction = performance.now();
      this.camTween = null;
    });

    this.composer = new EffectComposer(r);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.85, 0.55, 0.16);
    this.composer.addPass(this.bloom);
    this.grade = new ShaderPass(GRADE_SHADER);
    this.composer.addPass(this.grade);
    this.composer.addPass(new OutputPass());
  }

  #initWorld() {
    const s = this.scene;
    this.haloTex = haloTexture();

    // Digital rain dome
    this.rain = new THREE.Mesh(
      new THREE.CylinderGeometry(150, 150, 120, 120, 1, true),
      new THREE.ShaderMaterial({
        uniforms: {
          uAtlas: { value: glyphAtlas() },
          uTime: { value: 0 },
          uGrid: { value: new THREE.Vector2(280, 72) },
          uOpacity: { value: 0.75 },
          uColor: { value: new THREE.Color(0.08, 1.0, 0.42) },
        },
        vertexShader: RAIN_SHADER.vertex,
        fragmentShader: RAIN_SHADER.fragment,
        side: THREE.BackSide,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        fog: false,
      }),
    );
    this.rain.position.y = 38;
    s.add(this.rain);

    // Radar floor
    this.floorMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uRings: { value: RING_METERS.map(toScene) },
        uPulse: { value: -1 },
        uSweep: { value: 0 },
        uRadius: { value: WORLD_R },
        uColor: { value: new THREE.Color(0.12, 1.0, 0.5) },
      },
      vertexShader: FLOOR_SHADER.vertex,
      fragmentShader: FLOOR_SHADER.fragment,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(WORLD_R * 4, WORLD_R * 4), this.floorMat);
    floor.rotation.x = -Math.PI / 2;
    s.add(floor);

    for (const m of RING_METERS) {
      const { label, el } = cssLabel("ring-label", 0, 0.5); // left edge on the ring, CSS nudges it off the line
      el.textContent = `${m} m`;
      label.position.set(toScene(m), 0.05, 0);
      s.add(label);
    }

    // Estimated RF field
    this.fieldData = new Uint8Array(FIELD_N * FIELD_N * 4);
    this.fieldTex = new THREE.DataTexture(this.fieldData, FIELD_N, FIELD_N, THREE.RGBAFormat);
    this.fieldTex.magFilter = THREE.LinearFilter;
    this.fieldTex.minFilter = THREE.LinearFilter;
    this.fieldTex.colorSpace = THREE.LinearSRGBColorSpace; // bytes are already linear (THREE.Color working space)
    this.field = new THREE.Mesh(
      new THREE.PlaneGeometry(FIELD_L * 2, FIELD_L * 2),
      new THREE.MeshBasicMaterial({ map: this.fieldTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.9 }),
    );
    this.field.rotation.x = -Math.PI / 2;
    this.field.position.y = 0.03;
    s.add(this.field);

    // Receiver ("you")
    const you = new THREE.Group();
    you.position.set(0, 1.2, 0);
    const core = new THREE.Mesh(new THREE.SphereGeometry(0.42, 32, 16), new THREE.MeshBasicMaterial({ color: new THREE.Color(1.6, 2.0, 1.7) }));
    const cage = new THREE.Mesh(
      new THREE.IcosahedronGeometry(1.05, 1),
      new THREE.MeshBasicMaterial({ color: 0x46ff8f, wireframe: true, transparent: true, opacity: 0.55 }),
    );
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.haloTex, color: 0x7dffb0, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false }));
    halo.scale.setScalar(5);
    you.add(core, cage, halo);
    const beamGeo = new THREE.CylinderGeometry(0.05, 0.22, 40, 12, 1, true);
    beamGeo.translate(0, 20, 0);
    const beam = new THREE.Mesh(beamGeo, new THREE.MeshBasicMaterial({ color: 0x3dff9e, transparent: true, opacity: 0.12, blending: THREE.AdditiveBlending, depthWrite: false }));
    beam.position.y = -1.2;
    you.add(beam);
    const youLabel = cssLabel("you-label");
    youLabel.el.textContent = "VOCÊ";
    you.add(youLabel.label);
    s.add(you);
    this.you = { group: you, cage, halo };

    // Floating dust
    const dust = new Float32Array(1400 * 3);
    for (let i = 0; i < 1400; i++) {
      const r = Math.sqrt(Math.random()) * WORLD_R * 1.6;
      const a = Math.random() * TAU;
      dust.set([r * Math.cos(a), Math.random() * 32, r * Math.sin(a)], i * 3);
    }
    const dustGeo = new THREE.BufferGeometry();
    dustGeo.setAttribute("position", new THREE.BufferAttribute(dust, 3));
    this.dust = new THREE.Points(
      dustGeo,
      new THREE.PointsMaterial({ size: 0.16, color: 0x3dff8f, transparent: true, opacity: 0.4, depthWrite: false, blending: THREE.AdditiveBlending }),
    );
    s.add(this.dust);

    // Data packets travelling along beams (one shared buffer)
    this.packetPos = new Float32Array(MAX_PACKETS * 3);
    this.packetCol = new Float32Array(MAX_PACKETS * 3);
    const pg = new THREE.BufferGeometry();
    pg.setAttribute("position", new THREE.BufferAttribute(this.packetPos, 3));
    pg.setAttribute("color", new THREE.BufferAttribute(this.packetCol, 3));
    this.packets = new THREE.Points(
      pg,
      new THREE.PointsMaterial({ size: 0.55, map: this.haloTex, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
    );
    this.packets.frustumCulled = false;
    s.add(this.packets);

    // Selection uncertainty: probable sector + full estimate ring
    this.sector = new THREE.Mesh(
      new THREE.RingGeometry(1, 2, 48, 1, 0, 1),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.09, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending }),
    );
    this.sector.rotation.x = Math.PI / 2;
    this.sector.position.y = 0.06;
    this.sector.visible = false;
    s.add(this.sector);
    const circle = new THREE.BufferGeometry().setFromPoints(
      Array.from({ length: 129 }, (_, i) => new THREE.Vector3(Math.cos((i / 128) * TAU), 0, Math.sin((i / 128) * TAU))),
    );
    this.estRing = new THREE.Line(circle, new THREE.LineDashedMaterial({ color: 0xffffff, dashSize: 0.04, gapSize: 0.03, transparent: true, opacity: 0.55 }));
    this.estRing.computeLineDistances();
    this.estRing.position.y = 0.08;
    this.estRing.visible = false;
    s.add(this.estRing);
  }

  #initInput() {
    const el = this.renderer.domElement;
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    let down = null;
    el.addEventListener("pointermove", (e) => {
      this.pointer.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
      this.pointerPx = { x: e.clientX, y: e.clientY };
      this.pointerDirty = true;
    });
    el.addEventListener("pointerleave", () => {
      this.pointerPx = null;
      this.#setHover(null);
    });
    el.addEventListener("pointerdown", (e) => (down = { x: e.clientX, y: e.clientY }));
    el.addEventListener("pointerup", (e) => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return;
      const id = this.#pick();
      this.dispatchEvent(new CustomEvent("select", { detail: { id } }));
    });
  }

  #resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    this.labels.setSize(w, h);
    this.grade.uniforms.uRes.value.set(w, h);
  }

  // ─── Public API ─────────────────────────────────────────────────────────

  update(snap) {
    this.snapshot = snap;
    if (snap.scan.count !== this.lastScanCount) {
      if (this.lastScanCount >= 0) this.pulseStart = this.clock.elapsedTime;
      this.lastScanCount = snap.scan.count;
    }
    const alive = new Set();
    // Auto labels: the top radios, but only one per physical AP (connected radio first).
    const leaders = new Map();
    for (const n of snap.networks) {
      const key = n.group ?? n.id;
      const cur = leaders.get(key);
      if (!cur || (n.connected && !cur.connected) || (!cur.connected && n.rssi > cur.rssi)) leaders.set(key, n);
    }
    const strongest = new Set([...leaders.values()].filter((n) => !n.stale).sort((a, b) => b.rssi - a.rssi).slice(0, 6).map((n) => n.id));
    this.groupBands = new Map();
    for (const n of snap.networks) {
      const key = n.group ?? n.id;
      this.groupBands.set(key, [...new Set([...(this.groupBands.get(key) ?? []), n.band])].sort());
    }
    for (const n of snap.networks) {
      alive.add(n.id);
      let node = this.nodes.get(n.id);
      if (!node) {
        node = this.#createNode(n);
        this.nodes.set(n.id, node);
      }
      this.#applyNetwork(node, n, strongest.has(n.id));
    }
    for (const [id, node] of this.nodes) if (!alive.has(id)) node.dying ??= this.clock.elapsedTime;
    this.#updateSelectionGeometry();
    this.#computeField();
  }

  select(id) {
    this.selectedId = id;
    for (const node of this.nodes.values()) this.#refreshLabel(node);
    this.#updateSelectionGeometry();
    this.#computeField();
  }

  hover(id) {
    this.#setHover(id, false);
  }

  focus(id) {
    const node = this.nodes.get(id);
    if (!node) return;
    const target = node.target.clone();
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    const dist = Math.min(Math.max(this.camera.position.distanceTo(this.controls.target) * 0.6, 14), 40);
    this.#tween(target.clone().add(dir.multiplyScalar(dist)).setY(Math.max(target.y + dist * 0.45, 6)), target);
  }

  setCamera(name) {
    const c = CAMERAS[name];
    if (!c) return;
    this.#tween(new THREE.Vector3(...c.pos), new THREE.Vector3(...c.target));
  }

  setOption(key, value) {
    this.opts[key] = value;
    if (key === "rain") this.rain.visible = value;
    if (key === "field") this.field.visible = value;
    if (key === "rotate") this.lastInteraction = 0;
  }

  setLabelMode(mode) {
    this.labelMode = mode;
    for (const node of this.nodes.values()) this.#refreshLabel(node);
  }

  capture() {
    this.composer.render();
    return this.renderer.domElement.toDataURL("image/png");
  }

  /** Projects a network's position to screen pixels (for tooltips). */
  screenPos(id) {
    const node = this.nodes.get(id);
    if (!node) return null;
    this.tmp.copy(node.group.position).project(this.camera);
    return { x: (this.tmp.x * 0.5 + 0.5) * window.innerWidth, y: (-this.tmp.y * 0.5 + 0.5) * window.innerHeight };
  }

  // ─── Nodes ──────────────────────────────────────────────────────────────

  #createNode(n) {
    const color = new THREE.Color(n.connected ? LINK_HEX : BAND_HEX[n.band]);
    const group = new THREE.Group();
    const core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.5, 1), new THREE.MeshBasicMaterial({ color: color.clone(), transparent: true }));
    const shell = new THREE.Mesh(
      new THREE.OctahedronGeometry(1.05, 0),
      new THREE.MeshBasicMaterial({ color: color.clone(), wireframe: true, transparent: true, opacity: 0.45 }),
    );
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.haloTex, color: color.clone(), transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false }));
    halo.scale.setScalar(4);
    const pick = new THREE.Mesh(new THREE.SphereGeometry(1.5, 8, 6), new THREE.MeshBasicMaterial({ visible: false }));
    group.add(core, shell, halo, pick);

    const stemGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, -1, 0)]);
    const stem = new THREE.Line(stemGeo, new THREE.LineDashedMaterial({ color: color.clone(), dashSize: 0.08, gapSize: 0.06, transparent: true, opacity: 0.35 }));
    stem.computeLineDistances();
    group.add(stem);

    const foot = new THREE.Mesh(
      new THREE.RingGeometry(0.55, 0.75, 32),
      new THREE.MeshBasicMaterial({ color: color.clone(), transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending }),
    );
    foot.rotation.x = -Math.PI / 2;
    this.scene.add(foot);

    const beamGeo = new THREE.BufferGeometry();
    beamGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(41 * 3), 3));
    const beam = new THREE.Line(beamGeo, new THREE.LineBasicMaterial({ color: color.clone(), transparent: true, opacity: 0.2, blending: THREE.AdditiveBlending, depthWrite: false }));
    beam.frustumCulled = false;
    this.scene.add(beam);

    // Bottom-centre anchored on the shell's top vertex, so the box never covers its own node.
    const { label, el } = cssLabel("node-label", 0.5, 1);
    label.position.set(0, 1.05, 0);
    group.add(label);

    group.position.set(0, 1.2, 0); // born at the receiver, then flies out
    group.scale.setScalar(0.01);
    this.scene.add(group);
    pick.userData.id = n.id;

    return {
      id: n.id, group, core, shell, halo, pick, stem, foot, beam, label, el,
      color, target: new THREE.Vector3(), size: 1, opacity: 1, net: n, prominent: false,
      curve: new THREE.QuadraticBezierCurve3(new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()),
      spin: (Math.random() - 0.5) * 0.8, born: this.clock.elapsedTime,
    };
  }

  #applyNetwork(node, n, prominent) {
    node.net = n;
    node.prominent = prominent;
    node.dying = undefined;
    const r = toScene(n.distance.est);
    const az = n.position.azimuth;
    node.target.set(r * Math.cos(az), 1.6 + (n.position.y + 0.4) * 2.2, r * Math.sin(az));
    node.size = 0.45 + Math.min(Math.max((n.rssi + 95) / 65, 0), 1) * 0.85;
    node.opacity = n.stale ? 0.28 : 1;
    const hex = n.connected ? LINK_HEX : BAND_HEX[n.band];
    node.color.setHex(hex);
    const hdr = node.color.clone().multiplyScalar(n.connected ? 2.2 : 1.6);
    node.core.material.color.copy(hdr);
    node.shell.material.color.copy(node.color);
    node.halo.material.color.copy(node.color);
    node.stem.material.color.copy(node.color);
    node.foot.material.color.copy(node.color);
    node.beam.material.color.copy(node.color);
    this.#refreshLabel(node);
  }

  #refreshLabel(node) {
    const n = node.net;
    const sel = node.id === this.selectedId;
    const show =
      this.labelMode === "all" ||
      sel ||
      node.id === this.hoverId ||
      (this.labelMode === "auto" && node.prominent);
    node.label.visible = show && !node.dying;
    if (!show) return;
    const color = n.connected ? LINK_CSS : BAND_CSS[n.band];
    node.el.style.setProperty("--c", color);
    node.el.className = `node-label${n.connected ? " connected" : ""}${sel ? " selected" : ""}`;
    const bands = this.groupBands?.get(n.group ?? n.id) ?? [n.band];
    const radios = bands.length > 1 && !sel ? ` · ${bands.join("/")} GHz` : ` · ch ${n.channel}`;
    node.el.innerHTML = `${n.connected ? "◆ " : ""}${esc(n.name)}<small>${Math.round(n.rssi)} dBm · ~${fmtDist(n.distance.est)}${radios}</small>`;
  }

  #setHover(id, emit = true) {
    if (id === this.hoverId) return;
    const prev = this.hoverId;
    this.hoverId = id;
    for (const k of [prev, id]) {
      const node = k && this.nodes.get(k);
      if (node) this.#refreshLabel(node);
    }
    this.renderer.domElement.style.cursor = id ? "pointer" : "";
    if (emit) this.dispatchEvent(new CustomEvent("hover", { detail: { id, ...this.pointerPx } }));
  }

  #pick() {
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const picks = [...this.nodes.values()].filter((n) => !n.dying).map((n) => n.pick);
    const hit = this.raycaster.intersectObjects(picks, false)[0];
    return hit?.object.userData.id ?? null;
  }

  #updateSelectionGeometry() {
    const node = this.selectedId && this.nodes.get(this.selectedId);
    if (!node) {
      this.sector.visible = this.estRing.visible = false;
      return;
    }
    const n = node.net;
    const r0 = toScene(n.distance.min);
    const r1 = Math.max(toScene(n.distance.max), r0 + 0.3);
    const spread = 0.22 + (1 - n.position.confidence) * 0.45;
    this.sector.geometry.dispose();
    this.sector.geometry = new THREE.RingGeometry(r0, r1, 64, 1, n.position.azimuth - spread, spread * 2);
    this.sector.material.color.copy(node.color);
    this.sector.visible = true;
    const est = toScene(n.distance.est);
    this.estRing.scale.set(est, 1, est);
    this.estRing.material.color.copy(node.color);
    this.estRing.material.dashSize = 0.6 / est;
    this.estRing.material.gapSize = 0.45 / est;
    this.estRing.visible = true;
  }

  // ─── RF field ───────────────────────────────────────────────────────────

  #computeField() {
    const snap = this.snapshot;
    if (!snap) return;
    const n = snap.env.exponent;
    const sources = snap.networks
      .filter((x) => !x.stale && (!this.selectedId || x.id === this.selectedId))
      .map((x) => {
        const d = x.distance.est;
        const col = new THREE.Color(x.connected ? LINK_HEX : BAND_HEX[x.band]);
        return { x: d * Math.cos(x.position.azimuth), z: d * Math.sin(x.position.azimuth), ref: REF_RSSI[x.band], col };
      });
    const data = this.fieldData;
    const levels = [-50, -60, -70, -80];
    for (let j = 0; j < FIELD_N; j++) {
      const sz = FIELD_L - ((j + 0.5) / FIELD_N) * 2 * FIELD_L;
      for (let i = 0; i < FIELD_N; i++) {
        const sx = -FIELD_L + ((i + 0.5) / FIELD_N) * 2 * FIELD_L;
        const rs = Math.hypot(sx, sz);
        const k = (j * FIELD_N + i) * 4;
        if (rs > WORLD_R * 1.1 || !sources.length) {
          data[k] = data[k + 1] = data[k + 2] = data[k + 3] = 0;
          continue;
        }
        const rm = fromScene(rs);
        const ang = Math.atan2(sz, sx);
        const px = rm * Math.cos(ang);
        const pz = rm * Math.sin(ang);
        let best = -200;
        let bestCol = null;
        for (const s of sources) {
          const d = Math.hypot(px - s.x, pz - s.z, 1.5);
          const v = s.ref - 10 * n * Math.log10(d);
          if (v > best) {
            best = v;
            bestCol = s.col;
          }
        }
        const t = Math.min(Math.max((best + 92) / 58, 0), 1);
        let inten = Math.pow(t, 2) * (this.selectedId ? 0.32 : 0.42);
        for (const L of levels) inten += Math.exp(-(((best - L) / 0.45) ** 2)) * 0.28; // soft iso-dBm contours
        inten *= 1 - Math.min(Math.max((rs - WORLD_R * 0.85) / (WORLD_R * 0.25), 0), 1);
        data[k] = Math.min(bestCol.r * inten * 255, 255);
        data[k + 1] = Math.min(bestCol.g * inten * 255, 255);
        data[k + 2] = Math.min(bestCol.b * inten * 255, 255);
        data[k + 3] = Math.min(inten * 255, 255);
      }
    }
    this.fieldTex.needsUpdate = true;
  }

  // ─── Animation ──────────────────────────────────────────────────────────

  #tween(pos, target) {
    this.camTween = { t: 0, fromPos: this.camera.position.clone(), fromTarget: this.controls.target.clone(), pos, target };
    this.lastInteraction = performance.now();
  }

  #frame() {
    const dt = Math.min(this.clock.getDelta(), 0.05);
    const t = this.clock.elapsedTime;

    this.rain.material.uniforms.uTime.value = t;
    this.floorMat.uniforms.uTime.value = t;
    this.floorMat.uniforms.uSweep.value = (t * 0.9) % TAU;
    this.floorMat.uniforms.uPulse.value = t - this.pulseStart;
    this.grade.uniforms.uTime.value = t;

    this.you.cage.rotation.y += dt * 0.5;
    this.you.cage.rotation.x += dt * 0.2;
    this.you.halo.scale.setScalar(4.6 + Math.sin(t * 2.2) * 0.5);
    this.dust.rotation.y += dt * 0.01;
    const dp = this.dust.geometry.attributes.position;
    for (let i = 0; i < dp.count; i++) {
      let y = dp.getY(i) + dt * 0.35;
      if (y > 32) y = 0;
      dp.setY(i, y);
    }
    dp.needsUpdate = true;

    if (++this.frameCount % 6 === 0) this.#declutterLabels();

    if (this.pointerDirty && this.pointerPx) {
      this.pointerDirty = false;
      this.#setHover(this.#pick());
    }

    let packet = 0;
    const youPos = this.you.group.position;
    for (const [id, node] of this.nodes) {
      const k = 1 - Math.exp(-dt * 3);
      node.group.position.lerp(node.target, k);
      let scale = node.size * (id === this.selectedId ? 1.25 : 1);
      let alpha = node.opacity;
      if (node.dying !== undefined) {
        const f = (t - node.dying) / 0.8;
        if (f >= 1) {
          this.#dispose(node);
          this.nodes.delete(id);
          continue;
        }
        alpha *= 1 - f;
        scale *= 1 - f;
      }
      const s = THREE.MathUtils.lerp(node.group.scale.x, scale, k);
      node.group.scale.setScalar(s);
      node.core.material.opacity = alpha;
      node.shell.material.opacity = alpha * (0.25 + node.net.position.confidence * 0.35);
      node.halo.material.opacity = alpha * (id === this.selectedId || id === this.hoverId ? 0.95 : 0.5) * (0.85 + Math.sin(t * 3 + node.spin * 10) * 0.15);
      node.shell.rotation.y += dt * node.spin;
      node.shell.rotation.x += dt * node.spin * 0.6;

      const p = node.group.position;
      node.stem.scale.y = p.y / Math.max(s, 0.01);
      node.stem.material.opacity = alpha * 0.35;
      node.foot.position.set(p.x, 0.05, p.z);
      node.foot.material.opacity = alpha * 0.45;

      // Beam: arc from AP to receiver
      const mid = this.tmp.copy(p).add(youPos).multiplyScalar(0.5);
      mid.y += 2 + p.distanceTo(youPos) * 0.12;
      node.curve.v0.copy(p);
      node.curve.v1.copy(mid);
      node.curve.v2.copy(youPos);
      const highlight = id === this.selectedId || id === this.hoverId;
      const showBeam = this.opts.beams && !node.net.stale && (node.net.connected || highlight || node.prominent || this.labelMode === "all");
      node.beam.visible = showBeam || (this.opts.beams && !node.net.stale);
      if (node.beam.visible) {
        const arr = node.beam.geometry.attributes.position.array;
        for (let i = 0; i <= 40; i++) {
          node.curve.getPoint(i / 40, this.tmp);
          arr[i * 3] = this.tmp.x;
          arr[i * 3 + 1] = this.tmp.y;
          arr[i * 3 + 2] = this.tmp.z;
        }
        node.beam.geometry.attributes.position.needsUpdate = true;
        const q = Math.min(Math.max((node.net.rssi + 95) / 65, 0), 1);
        node.beam.material.opacity = alpha * (node.net.connected ? 0.75 : highlight ? 0.7 : showBeam ? 0.12 + q * 0.25 : 0.04);
      }

      // Packets: speed and density scale with signal quality
      const count = !showBeam ? 0 : node.net.connected ? 12 : highlight ? 9 : 4;
      const q = Math.min(Math.max((node.net.rssi + 95) / 65, 0.1), 1);
      for (let i = 0; i < count && packet < MAX_PACKETS; i++, packet++) {
        const u = (t * (0.12 + q * 0.35) + i / count + node.spin) % 1;
        node.curve.getPoint(u, this.tmp);
        this.packetPos.set([this.tmp.x, this.tmp.y, this.tmp.z], packet * 3);
        const glow = Math.sin(u * Math.PI) * alpha * (node.net.connected ? 1.6 : 1.1);
        this.packetCol.set([node.color.r * glow, node.color.g * glow, node.color.b * glow], packet * 3);
      }
    }
    for (let i = packet; i < MAX_PACKETS; i++) this.packetPos[i * 3 + 1] = -999;
    this.packets.geometry.attributes.position.needsUpdate = true;
    this.packets.geometry.attributes.color.needsUpdate = true;
    this.packets.geometry.setDrawRange(0, Math.max(packet, 1));

    if (this.camTween) {
      const tw = this.camTween;
      tw.t = Math.min(tw.t + dt / 1.3, 1);
      const e = ease(tw.t);
      this.camera.position.lerpVectors(tw.fromPos, tw.pos, e);
      this.controls.target.lerpVectors(tw.fromTarget, tw.target, e);
      if (tw.t >= 1) this.camTween = null;
    }
    this.controls.autoRotate = this.opts.rotate && !this.camTween && performance.now() - this.lastInteraction > 9000;
    this.controls.update();

    this.composer.render();
    this.labels.render(this.scene, this.camera);
  }

  /** Hides labels that would overlap a higher-priority one in screen space. */
  #declutterLabels() {
    const priority = (node) =>
      node.id === this.selectedId ? 1e4 : node.id === this.hoverId ? 1e3 : node.net.connected ? 500 : node.net.rssi + 200;
    const candidates = [...this.nodes.values()].filter((n) => n.label.visible).sort((a, b) => priority(b) - priority(a));
    // On-screen boxes as last rendered (anchor + CSS offset); read all before writing any opacity.
    const boxes = candidates.map((node) => node.el.getBoundingClientRect());
    const placed = [];
    for (const [i, node] of candidates.entries()) {
      const b = boxes[i];
      const forced = node.id === this.selectedId || node.id === this.hoverId;
      if (!b.width) {
        // Not placed by the renderer yet (just shown) or off-screen: nothing to measure this pass.
        if (forced) node.el.style.opacity = "1";
        continue;
      }
      const rect = { x0: b.left - 4, x1: b.right + 4, y0: b.top - 4, y1: b.bottom + 4 };
      const clash = placed.some((r) => rect.x0 < r.x1 && rect.x1 > r.x0 && rect.y0 < r.y1 && rect.y1 > r.y0);
      const show = forced || !clash;
      node.el.style.opacity = show ? "1" : "0";
      if (show) placed.push(rect);
    }
  }

  #dispose(node) {
    node.group.traverse((o) => {
      o.geometry?.dispose();
      o.material?.dispose();
    });
    node.label.element.remove();
    this.scene.remove(node.group, node.foot, node.beam);
    node.foot.geometry.dispose();
    node.foot.material.dispose();
    node.beam.geometry.dispose();
    node.beam.material.dispose();
  }
}
