/**
 * RF Space Observatory — 3D Scene Manager
 * Three.js-based real-time WiFi space visualization
 * with bloom glow, coverage spheres, matrix rain, and convergence animation.
 */

class RFScene3D {
  constructor(containerId) {
    this.container = document.getElementById(containerId);
    if (!this.container) {
      console.error("[scene3d] Container not found:", containerId);
      return;
    }

    // State
    this.apNodes = {}; // bssid → { mesh, sphere, label, line, targetPos }
    this.originNode = null;
    this.particles = null;
    this.matrixRain = null;
    this.starfield = null;
    this.skyDome = null;
    this.graphLinksGroup = null;
    this.renderMode = "rf-space";
    this.labelMode = "show-wifi";
    this.clock = new THREE.Clock();
    this.animationId = null;
    this.isInitialized = false;
    this._savedOrbitState = null;

    // Colors
    this.colors = {
      cyan: new THREE.Color(0x00ffcc),
      magenta: new THREE.Color(0xff00aa),
      amber: new THREE.Color(0xffb800),
      grid: new THREE.Color(0x0a1628),
      gridBright: new THREE.Color(0x00ffcc),
      bg: new THREE.Color(0x060a12),
    };

    this._init();
  }

  _getContainerSize() {
    const rect = this.container.getBoundingClientRect();
    const width = Math.max(
      1,
      Math.floor(
        rect.width || this.container.clientWidth || window.innerWidth || 1,
      ),
    );
    const fallbackHeight = Math.max(
      320,
      Math.floor((window.innerHeight || 720) - 92),
    );
    const height = Math.max(
      1,
      Math.floor(rect.height || this.container.clientHeight || fallbackHeight),
    );
    return { width, height };
  }

  _init() {
    const { width, height } = this._getContainerSize();

    // Scene
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0x060a12, 0.08);

    // Camera
    this.camera = new THREE.PerspectiveCamera(60, width / height, 0.1, 1000);
    this.camera.position.set(6, 4, 8);
    this.camera.lookAt(0, 0, 0);

    // Renderer
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      powerPreference: "high-performance",
    });
    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x060a12);
    this.renderer.shadowMap.enabled = false;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.2;
    this.container.appendChild(this.renderer.domElement);

    // Lights
    this._setupLights();

    // Atmospheric layers
    this._createSkyDome();
    this._createStarfield();

    // Grid floor
    this._createGrid();

    // Link layer for graph mode
    this._createGraphLayer();

    // Origin marker
    this._createOriginMarker();

    // Matrix rain particles
    this._createMatrixRain();

    // Scan ring effect
    this._createScanRing();

    // Controls (manual orbit)
    this._setupControls();

    // Resize handler
    window.addEventListener("resize", () => this._onResize());

    // Start render loop
    this.isInitialized = true;
    this._applyRenderModeEnvironment();
    this._animate();

    console.log("[scene3d] ✅ 3D scene initialized");
  }

  _setupLights() {
    // Ambient
    const ambient = new THREE.AmbientLight(0x1a2235, 0.8);
    this.scene.add(ambient);

    // Main directional (from above)
    const dirLight = new THREE.DirectionalLight(0x00ffcc, 0.3);
    dirLight.position.set(5, 10, 5);
    this.scene.add(dirLight);

    // Point light at origin
    const pointLight = new THREE.PointLight(0xffb800, 1, 20);
    pointLight.position.set(0, 1, 0);
    this.scene.add(pointLight);
    this.originLight = pointLight;

    // Hemisphere
    const hemiLight = new THREE.HemisphereLight(0x0a0e17, 0x00ffcc, 0.15);
    this.scene.add(hemiLight);
  }

  _createSkyDome() {
    const skyGeo = new THREE.SphereGeometry(120, 32, 32);
    const skyMat = new THREE.MeshBasicMaterial({
      color: 0x04101a,
      transparent: true,
      opacity: 0.9,
      side: THREE.BackSide,
      depthWrite: false,
    });
    this.skyDome = new THREE.Mesh(skyGeo, skyMat);
    this.scene.add(this.skyDome);

    const tintGeo = new THREE.SphereGeometry(90, 24, 24);
    const tintMat = new THREE.MeshBasicMaterial({
      color: 0x062433,
      transparent: true,
      opacity: 0.08,
      side: THREE.BackSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const tint = new THREE.Mesh(tintGeo, tintMat);
    this.scene.add(tint);
  }

  _createStarfield() {
    const count = 900;
    const radius = 65;
    const positions = new Float32Array(count * 3);

    for (let i = 0; i < count; i++) {
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(Math.random() * 2 - 1);
      const r = radius * (0.65 + Math.random() * 0.35);

      positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = r * Math.cos(phi);
      positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));

    const mat = new THREE.PointsMaterial({
      color: 0x76ffd9,
      size: 0.05,
      transparent: true,
      opacity: 0.42,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      sizeAttenuation: true,
    });

    this.starfield = new THREE.Points(geo, mat);
    this.scene.add(this.starfield);
  }

  _createGrid() {
    // Custom grid with glow
    const gridSize = 30;
    const gridDivisions = 30;
    const grid = new THREE.GridHelper(
      gridSize,
      gridDivisions,
      0x00ffcc,
      0x0a1628,
    );
    grid.material.opacity = 0.15;
    grid.material.transparent = true;
    grid.position.y = -0.01;
    this.scene.add(grid);

    // Inner bright grid
    const innerGrid = new THREE.GridHelper(10, 10, 0x00ffcc, 0x00ffcc);
    innerGrid.material.opacity = 0.05;
    innerGrid.material.transparent = true;
    innerGrid.position.y = 0;
    this.scene.add(innerGrid);

    // Axes helper (subtle)
    const axisLen = 2;
    const axisMat = (color) =>
      new THREE.LineBasicMaterial({ color, opacity: 0.3, transparent: true });

    const xGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(axisLen, 0, 0),
    ]);
    const yGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, axisLen, 0),
    ]);
    const zGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, 0, axisLen),
    ]);

    this.scene.add(new THREE.Line(xGeo, axisMat(0xff4444)));
    this.scene.add(new THREE.Line(yGeo, axisMat(0x44ff44)));
    this.scene.add(new THREE.Line(zGeo, axisMat(0x4444ff)));
  }

  _createGraphLayer() {
    this.graphLinksGroup = new THREE.Group();
    this.graphLinksGroup.visible = false;
    this.scene.add(this.graphLinksGroup);
  }

  _createOriginMarker() {
    // Diamond shape for user position
    const geo = new THREE.OctahedronGeometry(0.2, 0);
    const mat = new THREE.MeshPhongMaterial({
      color: 0xffb800,
      emissive: 0xffb800,
      emissiveIntensity: 0.8,
      transparent: true,
      opacity: 0.9,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(0, 0.2, 0);
    this.scene.add(mesh);

    // Glow ring
    const ringGeo = new THREE.RingGeometry(0.3, 0.35, 32);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xffb800,
      transparent: true,
      opacity: 0.4,
      side: THREE.DoubleSide,
    });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.01;
    this.scene.add(ring);

    // Outer pulse ring
    const pulseGeo = new THREE.RingGeometry(0.5, 0.52, 32);
    const pulseMat = new THREE.MeshBasicMaterial({
      color: 0xffb800,
      transparent: true,
      opacity: 0.2,
      side: THREE.DoubleSide,
    });
    const pulseRing = new THREE.Mesh(pulseGeo, pulseMat);
    pulseRing.rotation.x = -Math.PI / 2;
    pulseRing.position.y = 0.01;
    this.scene.add(pulseRing);

    this.originNode = { mesh, ring, pulseRing };
  }

  _createMatrixRain() {
    // Falling particle system — Matrix-style digital rain
    const count = 500;
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(count * 3);
    const velocities = new Float32Array(count);
    const sizes = new Float32Array(count);

    for (let i = 0; i < count; i++) {
      positions[i * 3] = (Math.random() - 0.5) * 30;
      positions[i * 3 + 1] = Math.random() * 15;
      positions[i * 3 + 2] = (Math.random() - 0.5) * 30;
      velocities[i] = 0.5 + Math.random() * 1.5;
      sizes[i] = 1 + Math.random() * 2;
    }

    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("size", new THREE.BufferAttribute(sizes, 1));

    const material = new THREE.PointsMaterial({
      color: 0x00ffcc,
      size: 0.04,
      transparent: true,
      opacity: 0.3,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      sizeAttenuation: true,
    });

    this.matrixRain = new THREE.Points(geometry, material);
    this.matrixRain._velocities = velocities;
    this.scene.add(this.matrixRain);
  }

  _createScanRing() {
    // Expanding ring that pulses when a scan happens
    const geo = new THREE.RingGeometry(0.1, 0.15, 64);
    const mat = new THREE.MeshBasicMaterial({
      color: 0x00ffcc,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
    });
    this.scanRing = new THREE.Mesh(geo, mat);
    this.scanRing.rotation.x = -Math.PI / 2;
    this.scanRing.position.y = 0.02;
    this.scene.add(this.scanRing);
    this.scanRing._active = false;
    this.scanRing._progress = 0;
  }

  triggerScanPulse() {
    if (this.scanRing) {
      this.scanRing._active = true;
      this.scanRing._progress = 0;
      this.scanRing.material.opacity = 0.6;
      this.scanRing.scale.set(1, 1, 1);
    }
  }

  _setupControls() {
    // Simple orbit controls (manual implementation)
    this._isDragging = false;
    this._isPanning = false;
    this._prevMouse = { x: 0, y: 0 };
    this._spherical = {
      theta: Math.atan2(this.camera.position.x, this.camera.position.z),
      phi: Math.acos(this.camera.position.y / this.camera.position.length()),
      radius: this.camera.position.length(),
    };
    this._target = new THREE.Vector3(0, 0.5, 0);
    this._savedOrbitState = null;

    const canvas = this.renderer.domElement;

    canvas.addEventListener("mousedown", (e) => {
      if (e.button === 0) this._isDragging = true;
      if (e.button === 2) this._isPanning = true;
      this._prevMouse = { x: e.clientX, y: e.clientY };
    });

    canvas.addEventListener("mousemove", (e) => {
      const dx = e.clientX - this._prevMouse.x;
      const dy = e.clientY - this._prevMouse.y;
      this._prevMouse = { x: e.clientX, y: e.clientY };

      if (this._isDragging) {
        this._spherical.theta -= dx * 0.005;
        this._spherical.phi = Math.max(
          0.1,
          Math.min(Math.PI - 0.1, this._spherical.phi + dy * 0.005),
        );
      }

      if (this._isPanning) {
        const panSpeed = 0.01;
        const right = new THREE.Vector3();
        const up = new THREE.Vector3(0, 1, 0);
        right
          .crossVectors(this.camera.getWorldDirection(new THREE.Vector3()), up)
          .normalize();
        this._target.add(right.multiplyScalar(-dx * panSpeed));
        this._target.y += dy * panSpeed;
      }
    });

    canvas.addEventListener("mouseup", () => {
      this._isDragging = false;
      this._isPanning = false;
    });

    canvas.addEventListener("mouseleave", () => {
      this._isDragging = false;
      this._isPanning = false;
    });

    canvas.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        this._spherical.radius += e.deltaY * 0.005;
        this._spherical.radius = Math.max(
          2,
          Math.min(30, this._spherical.radius),
        );
      },
      { passive: false },
    );

    canvas.addEventListener("contextmenu", (e) => e.preventDefault());

    // Touch controls
    let touchStart = null;
    let touchDist = null;

    canvas.addEventListener("touchstart", (e) => {
      if (e.touches.length === 1) {
        touchStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      } else if (e.touches.length === 2) {
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        touchDist = Math.sqrt(dx * dx + dy * dy);
      }
    });

    canvas.addEventListener(
      "touchmove",
      (e) => {
        e.preventDefault();
        if (e.touches.length === 1 && touchStart) {
          const dx = e.touches[0].clientX - touchStart.x;
          const dy = e.touches[0].clientY - touchStart.y;
          this._spherical.theta -= dx * 0.005;
          this._spherical.phi = Math.max(
            0.1,
            Math.min(Math.PI - 0.1, this._spherical.phi + dy * 0.005),
          );
          touchStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
        } else if (e.touches.length === 2 && touchDist) {
          const dx = e.touches[0].clientX - e.touches[1].clientX;
          const dy = e.touches[0].clientY - e.touches[1].clientY;
          const newDist = Math.sqrt(dx * dx + dy * dy);
          this._spherical.radius *= touchDist / newDist;
          this._spherical.radius = Math.max(
            2,
            Math.min(30, this._spherical.radius),
          );
          touchDist = newDist;
        }
      },
      { passive: false },
    );
  }

  _updateCamera() {
    const r = this._spherical.radius;
    const theta = this._spherical.theta;
    const phi = this._spherical.phi;

    this.camera.position.set(
      this._target.x + r * Math.sin(phi) * Math.sin(theta),
      this._target.y + r * Math.cos(phi),
      this._target.z + r * Math.sin(phi) * Math.cos(theta),
    );
    this.camera.lookAt(this._target);
  }

  // ─── AP Node Management ───

  updateAccessPoints(positions, apMetadata, options = {}) {
    if (!this.isInitialized) return;

    this.setDisplayOptions(options);

    const activeBssids = new Set();

    for (const [bssid, pos] of Object.entries(positions)) {
      activeBssids.add(bssid);
      const meta = apMetadata[bssid] || {};

      if (this.apNodes[bssid]) {
        // Update existing node
        this._updateAPNode(bssid, pos, meta);
      } else {
        // Create new node
        this._createAPNode(bssid, pos, meta);
      }

      this._applyRenderModeToNode(this.apNodes[bssid]);
    }

    // Remove nodes that are no longer visible
    for (const bssid of Object.keys(this.apNodes)) {
      if (!activeBssids.has(bssid)) {
        this._removeAPNode(bssid);
      }
    }

    if (this.renderMode === "nodes") {
      this._rebuildGraphLinks();
    }
  }

  _createAPNode(bssid, pos, meta) {
    const band = meta.band || "2.4GHz";
    const color = band === "5GHz" ? this.colors.magenta : this.colors.cyan;
    const signalQuality = meta.signal_quality || 50;
    const rssi = meta.rssi_mean || -70;

    // Node size based on signal strength
    const nodeSize = 0.08 + (signalQuality / 100) * 0.2;

    // AP core sphere
    const geo = new THREE.SphereGeometry(nodeSize, 16, 16);
    const mat = new THREE.MeshPhongMaterial({
      color: color,
      emissive: color,
      emissiveIntensity: 0.6 + (signalQuality / 100) * 0.4,
      transparent: true,
      opacity: 0.9,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(pos.x || 0, (pos.y || 0) + 0.5, pos.z || 0);
    this.scene.add(mesh);

    // Outer glow sphere
    const glowGeo = new THREE.SphereGeometry(nodeSize * 2.5, 16, 16);
    const glowMat = new THREE.MeshBasicMaterial({
      color: color,
      transparent: true,
      opacity: 0.08,
      side: THREE.BackSide,
    });
    const glowMesh = new THREE.Mesh(glowGeo, glowMat);
    mesh.add(glowMesh);

    // Coverage sphere (translucent)
    const coverageRadius = this._estimateCoverageRadius(signalQuality, band);
    const coverageGeo = new THREE.SphereGeometry(coverageRadius, 24, 24);
    const uncertainty = pos.uncertainty || 1;
    const coverageMat = new THREE.MeshPhongMaterial({
      color: color,
      transparent: true,
      opacity: 0.04 * (1 - uncertainty * 0.7),
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const coverageMesh = new THREE.Mesh(coverageGeo, coverageMat);
    coverageMesh.position.copy(mesh.position);
    this.scene.add(coverageMesh);

    // Halo ring around AP base for faster visual reading.
    const haloGeo = new THREE.RingGeometry(nodeSize * 1.7, nodeSize * 2.2, 32);
    const haloMat = new THREE.MeshBasicMaterial({
      color: color,
      transparent: true,
      opacity: 0.35,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const haloRing = new THREE.Mesh(haloGeo, haloMat);
    haloRing.rotation.x = -Math.PI / 2;
    haloRing.position.set(mesh.position.x, 0.03, mesh.position.z);
    this.scene.add(haloRing);

    // Connection line to origin
    const lineGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0.2, 0),
      mesh.position.clone(),
    ]);
    const lineMat = new THREE.LineBasicMaterial({
      color: color,
      transparent: true,
      opacity: 0.15,
    });
    const line = new THREE.Line(lineGeo, lineMat);
    this.scene.add(line);

    // Label (HTML overlay via sprite)
    const label = this._createLabel(this._resolveLabel(meta), band);

    // Store reference
    this.apNodes[bssid] = {
      mesh,
      glowMesh,
      coverageMesh,
      targetScale: Math.max(nodeSize / 0.15, 0.65),
      coverageTargetScale: 1,
      haloRing,
      line,
      label,
      targetPos: new THREE.Vector3(pos.x || 0, (pos.y || 0) + 0.5, pos.z || 0),
      currentConfidence: pos.confidence || 0,
      meta,
    };

    // Animate in: start at origin and expand
    mesh.position.set(0, 0.2, 0);
    mesh.scale.set(0.01, 0.01, 0.01);
  }

  _updateAPNode(bssid, pos, meta) {
    const node = this.apNodes[bssid];
    if (!node) return;

    const band = meta.band || node.meta.band || "2.4GHz";
    const color = band === "5GHz" ? this.colors.magenta : this.colors.cyan;
    const signalQuality = meta.signal_quality || 50;
    const uncertainty = pos.uncertainty || 1;
    const confidence = pos.confidence || 0;

    // Update target position (smooth convergence)
    node.targetPos.set(pos.x || 0, (pos.y || 0) + 0.5, pos.z || 0);
    node.currentConfidence = confidence;

    // Update node size based on signal
    const nodeSize = 0.08 + (signalQuality / 100) * 0.2;
    const targetScale = nodeSize / 0.15; // Normalize to base size
    node.targetScale = Math.max(targetScale, 0.65);

    // Update emissive intensity based on confidence
    node.mesh.material.emissiveIntensity = 0.4 + confidence * 0.6;

    // Update coverage sphere opacity (uncertainty visualization)
    if (node.coverageMesh) {
      node.coverageMesh.material.opacity = 0.03 + 0.07 * (1 - uncertainty);

      // Update coverage radius
      const newRadius = this._estimateCoverageRadius(signalQuality, band);
      const baseRadius = node.coverageMesh.geometry.parameters.radius || 1;
      node.coverageTargetScale = newRadius / baseRadius;
      node.coverageMesh.scale.lerp(
        new THREE.Vector3(
          node.coverageTargetScale,
          node.coverageTargetScale,
          node.coverageTargetScale,
        ),
        0.05,
      );
    }

    if (node.haloRing) {
      const haloOpacity = 0.15 + confidence * 0.45;
      node.haloRing.material.opacity = haloOpacity;
      node.haloRing.material.color.copy(color);
      node.haloRing.position.set(
        node.mesh.position.x,
        0.03,
        node.mesh.position.z,
      );
    }

    // Update line
    if (node.line) {
      node.line.material.opacity = 0.08 + confidence * 0.24;
      const positions = node.line.geometry.attributes.position;
      if (positions) {
        positions.setXYZ(
          1,
          node.mesh.position.x,
          node.mesh.position.y,
          node.mesh.position.z,
        );
        positions.needsUpdate = true;
      }
    }

    node.meta = { ...node.meta, ...meta };
    this._updateLabelSprite(node.label, this._resolveLabel(node.meta), band);
  }

  _removeAPNode(bssid) {
    const node = this.apNodes[bssid];
    if (!node) return;

    this.scene.remove(node.mesh);
    this.scene.remove(node.coverageMesh);
    this.scene.remove(node.haloRing);
    this.scene.remove(node.line);
    if (node.label) {
      this.scene.remove(node.label);
    }

    // Dispose geometries and materials
    node.mesh.geometry.dispose();
    node.mesh.material.dispose();
    node.coverageMesh.geometry.dispose();
    node.coverageMesh.material.dispose();
    if (node.haloRing) {
      node.haloRing.geometry.dispose();
      node.haloRing.material.dispose();
    }
    node.line.geometry.dispose();
    node.line.material.dispose();
    if (node.label && node.label.material) {
      if (node.label.material.map) {
        node.label.material.map.dispose();
      }
      node.label.material.dispose();
    }

    delete this.apNodes[bssid];
  }

  _drawRoundedRect(ctx, x, y, w, h, r) {
    if (typeof ctx.roundRect === "function") {
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, r);
      return;
    }

    const radius = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + w, y, x + w, y + h, radius);
    ctx.arcTo(x + w, y + h, x, y + h, radius);
    ctx.arcTo(x, y + h, x, y, radius);
    ctx.arcTo(x, y, x + w, y, radius);
    ctx.closePath();
  }

  _resolveLabel(meta) {
    if (this.labelMode === "ssid-only") {
      return (meta && meta.ssid_label) || "SSID";
    }
    return (meta && (meta.ssid_raw || meta.ssid_label)) || "Unknown";
  }

  _paintLabelCanvas(ctx, canvas, text, band) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    ctx.fillStyle = "rgba(8, 14, 22, 0.9)";
    this._drawRoundedRect(ctx, 0, 0, canvas.width, canvas.height, 10);
    ctx.fill();

    ctx.strokeStyle =
      band === "5GHz" ? "rgba(255, 0, 170, 0.42)" : "rgba(0, 255, 204, 0.42)";
    ctx.lineWidth = 2;
    this._drawRoundedRect(ctx, 0, 0, canvas.width, canvas.height, 10);
    ctx.stroke();

    ctx.fillStyle = band === "5GHz" ? "#ff6bcd" : "#5dffe0";
    ctx.font = "700 20px 'IBM Plex Mono', monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    const maxLength = 19;
    const normalizedText = String(text || "").trim() || "Unknown";
    const clipped =
      normalizedText.length > maxLength
        ? `${normalizedText.slice(0, maxLength - 1)}…`
        : normalizedText;

    ctx.fillText(clipped.toUpperCase(), canvas.width / 2, canvas.height / 2);
  }

  _updateLabelSprite(sprite, text, band) {
    if (!sprite || !sprite.userData) return;

    const state = sprite.userData;
    if (state.text === text && state.band === band) {
      return;
    }

    this._paintLabelCanvas(state.ctx, state.canvas, text, band);
    state.texture.needsUpdate = true;
    state.text = text;
    state.band = band;
  }

  _createLabel(text, band) {
    // Create a simple sprite label
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    canvas.width = 256;
    canvas.height = 64;

    this._paintLabelCanvas(ctx, canvas, text, band);

    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;

    const spriteMat = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
    });
    const sprite = new THREE.Sprite(spriteMat);
    sprite.scale.set(1.2, 0.3, 1);
    sprite.userData = {
      canvas,
      ctx,
      texture,
      text,
      band,
    };
    this.scene.add(sprite);

    return sprite;
  }

  _estimateCoverageRadius(quality, band) {
    const base = band === "5GHz" ? 1.5 : 2.5;
    return base * (0.5 + quality / 100);
  }

  _clearGraphLinks() {
    if (!this.graphLinksGroup) return;
    for (const child of [...this.graphLinksGroup.children]) {
      this.graphLinksGroup.remove(child);
      if (child.geometry) child.geometry.dispose();
      if (child.material) child.material.dispose();
    }
  }

  _rebuildGraphLinks() {
    if (!this.graphLinksGroup) return;
    this._clearGraphLinks();

    const entries = Object.entries(this.apNodes);
    if (entries.length < 2) {
      return;
    }

    const maxNeighbors = 3;
    const maxDistance = 8.5;
    const seenPairs = new Set();

    for (let i = 0; i < entries.length; i++) {
      const [aId, aNode] = entries[i];
      const distances = [];

      for (let j = 0; j < entries.length; j++) {
        if (i === j) continue;
        const [bId, bNode] = entries[j];
        const dist = aNode.mesh.position.distanceTo(bNode.mesh.position);
        if (dist <= maxDistance) {
          distances.push({ bId, dist });
        }
      }

      distances.sort((x, y) => x.dist - y.dist);
      for (const neighbor of distances.slice(0, maxNeighbors)) {
        const pairKey = [aId, neighbor.bId].sort().join("|");
        if (seenPairs.has(pairKey)) continue;
        seenPairs.add(pairKey);

        const geometry = new THREE.BufferGeometry().setFromPoints([
          this.apNodes[aId].mesh.position.clone(),
          this.apNodes[neighbor.bId].mesh.position.clone(),
        ]);

        const material = new THREE.LineBasicMaterial({
          color: 0xb3cbe0,
          transparent: true,
          opacity: 0.22,
        });

        const line = new THREE.Line(geometry, material);
        line.userData = { aId, bId: neighbor.bId };
        this.graphLinksGroup.add(line);
      }
    }
  }

  _updateGraphLinksPositions() {
    if (!this.graphLinksGroup || !this.graphLinksGroup.visible) return;
    for (const line of this.graphLinksGroup.children) {
      const { aId, bId } = line.userData || {};
      const aNode = this.apNodes[aId];
      const bNode = this.apNodes[bId];
      if (!aNode || !bNode) {
        line.visible = false;
        continue;
      }
      line.visible = true;
      const attr = line.geometry.attributes.position;
      attr.setXYZ(
        0,
        aNode.mesh.position.x,
        aNode.mesh.position.y,
        aNode.mesh.position.z,
      );
      attr.setXYZ(
        1,
        bNode.mesh.position.x,
        bNode.mesh.position.y,
        bNode.mesh.position.z,
      );
      attr.needsUpdate = true;
    }
  }

  _applyRenderModeToNode(node) {
    if (!node) return;
    const isNodes = this.renderMode === "nodes";
    const singleNodeOnly = Object.keys(this.apNodes).length <= 1;

    if (node.coverageMesh) node.coverageMesh.visible = !isNodes;
    if (node.haloRing) node.haloRing.visible = !isNodes;
    if (node.line) node.line.visible = !isNodes || singleNodeOnly;
    if (node.glowMesh) node.glowMesh.visible = !isNodes;
    if (node.mesh && node.mesh.material) {
      node.mesh.material.opacity = isNodes ? 0.98 : 0.9;
    }
    if (node.label) {
      node.label.scale.set(isNodes ? 0.95 : 1.2, isNodes ? 0.24 : 0.3, 1);
    }
  }

  _applyRenderModeEnvironment() {
    const isNodes = this.renderMode === "nodes";

    if (this.matrixRain) this.matrixRain.visible = !isNodes;
    if (this.scanRing) this.scanRing.visible = !isNodes;
    if (this.graphLinksGroup) this.graphLinksGroup.visible = isNodes;

    if (this.starfield && this.starfield.material) {
      this.starfield.material.opacity = isNodes ? 0.2 : 0.35;
    }

    if (this.scene && this.scene.fog) {
      this.scene.fog.density = isNodes ? 0.045 : 0.08;
    }

    if (this.originNode?.ring) this.originNode.ring.visible = !isNodes;
    if (this.originNode?.pulseRing)
      this.originNode.pulseRing.visible = !isNodes;

    for (const node of Object.values(this.apNodes)) {
      this._applyRenderModeToNode(node);
    }
  }

  _applyNodesCameraPreset() {
    if (!this._spherical || !this._target) return;

    if (!this._savedOrbitState) {
      this._savedOrbitState = {
        theta: this._spherical.theta,
        phi: this._spherical.phi,
        radius: this._spherical.radius,
        target: this._target.clone(),
      };
    }

    this._spherical.radius = Math.max(
      6.2,
      Math.min(this._spherical.radius, 10.5),
    );
    this._spherical.phi = Math.max(0.95, Math.min(this._spherical.phi, 1.12));
    this._target.y = 0.28;
  }

  _restoreSpaceCameraPreset() {
    if (!this._savedOrbitState || !this._spherical || !this._target) {
      return;
    }

    this._spherical.theta = this._savedOrbitState.theta;
    this._spherical.phi = this._savedOrbitState.phi;
    this._spherical.radius = this._savedOrbitState.radius;
    this._target.copy(this._savedOrbitState.target);
    this._savedOrbitState = null;
  }

  setRenderMode(mode) {
    const next = mode === "nodes" ? "nodes" : "rf-space";
    if (this.renderMode === next) {
      return;
    }
    this.renderMode = next;
    if (this.renderMode === "nodes") {
      this._rebuildGraphLinks();
      this._applyNodesCameraPreset();
    } else {
      this._restoreSpaceCameraPreset();
    }
    this._applyRenderModeEnvironment();
  }

  setLabelMode(mode) {
    const next = mode === "ssid-only" ? "ssid-only" : "show-wifi";
    if (this.labelMode === next) {
      return;
    }
    this.labelMode = next;
    for (const node of Object.values(this.apNodes)) {
      const band = (node.meta && node.meta.band) || "2.4GHz";
      this._updateLabelSprite(
        node.label,
        this._resolveLabel(node.meta || {}),
        band,
      );
    }
  }

  setDisplayOptions(options = {}) {
    if (options.renderMode) {
      this.setRenderMode(options.renderMode);
    }
    if (options.labelMode) {
      this.setLabelMode(options.labelMode);
    }
  }

  // ─── Animation Loop ───

  _animate() {
    this.animationId = requestAnimationFrame(() => this._animate());

    const delta = this.clock.getDelta();
    const time = this.clock.getElapsedTime();

    // Update camera
    this._updateCamera();

    // Animate matrix rain
    this._animateMatrixRain(delta);

    // Atmosphere drift
    this._animateStarfield(time);

    // Animate origin marker
    this._animateOrigin(time);

    // Animate AP nodes (convergence)
    this._animateAPNodes(delta, time);

    // Animate scan ring
    this._animateScanRing(delta);

    // Update labels to face camera
    this._updateLabels();

    // Render
    this.renderer.render(this.scene, this.camera);
  }

  _animateMatrixRain(delta) {
    if (!this.matrixRain) return;

    const positions = this.matrixRain.geometry.attributes.position;
    const velocities = this.matrixRain._velocities;

    for (let i = 0; i < positions.count; i++) {
      let y = positions.getY(i);
      y -= velocities[i] * delta;

      if (y < -1) {
        y = 15;
        positions.setX(i, (Math.random() - 0.5) * 30);
        positions.setZ(i, (Math.random() - 0.5) * 30);
      }

      positions.setY(i, y);
    }
    positions.needsUpdate = true;

    // Subtle opacity pulse
    this.matrixRain.material.opacity =
      0.2 + Math.sin(this.clock.getElapsedTime() * 0.5) * 0.1;
  }

  _animateStarfield(time) {
    if (!this.starfield) return;
    this.starfield.rotation.y = time * 0.012;
    this.starfield.rotation.x = Math.sin(time * 0.04) * 0.03;
    const base = this.renderMode === "nodes" ? 0.16 : 0.28;
    const amp = this.renderMode === "nodes" ? 0.04 : 0.07;
    this.starfield.material.opacity = base + Math.sin(time * 0.3) * amp;
  }

  _animateOrigin(time) {
    if (!this.originNode) return;

    // Gentle bob
    this.originNode.mesh.position.y = 0.2 + Math.sin(time * 2) * 0.05;
    this.originNode.mesh.rotation.y = time * 0.5;

    // Pulse ring
    const pulseScale = 1 + Math.sin(time * 3) * 0.2;
    this.originNode.pulseRing.scale.set(pulseScale, pulseScale, pulseScale);
    this.originNode.pulseRing.material.opacity =
      0.2 * (1 - (pulseScale - 1) * 2);

    // Origin light pulse
    this.originLight.intensity = 0.8 + Math.sin(time * 2) * 0.3;
  }

  _animateAPNodes(delta, time) {
    for (const [bssid, node] of Object.entries(this.apNodes)) {
      const isNodes = this.renderMode === "nodes";
      const fallbackSeed =
        parseInt(
          String(bssid || "")
            .replace(/:/g, "")
            .slice(-6),
          16,
        ) || 1;
      const fallbackAngle = ((fallbackSeed % 360) * Math.PI) / 180;

      const targetVector = node.targetPos.clone();
      if (isNodes) {
        const planar = new THREE.Vector2(targetVector.x, targetVector.z);
        if (planar.lengthSq() < 0.15) {
          planar
            .set(Math.cos(fallbackAngle), Math.sin(fallbackAngle))
            .multiplyScalar(1.25);
        } else if (planar.length() < 1.25) {
          planar.setLength(1.25);
        }

        const bandLift = node.meta?.band === "5GHz" ? 0.08 : 0;
        targetVector.set(planar.x, 0.28 + bandLift, planar.y);
      }

      // Smooth position convergence
      node.mesh.position.lerp(targetVector, isNodes ? 0.16 : 0.08);

      // Gentle floating animation
      node.mesh.position.y =
        targetVector.y +
        Math.sin(time * 1.5 + targetVector.x * 3) * (isNodes ? 0.01 : 0.03);

      const baseScale = Math.max(node.targetScale || 0.9, 0.65);
      const modeScale = isNodes ? baseScale * 1.25 : baseScale;
      node.mesh.scale.lerp(
        new THREE.Vector3(modeScale, modeScale, modeScale),
        isNodes ? 0.2 : 0.12,
      );

      // Coverage sphere follows
      if (node.coverageMesh) {
        node.coverageMesh.position.copy(node.mesh.position);
        const uncertainty = 1 - (node.currentConfidence || 0);
        const breathe =
          1 +
          Math.sin(time * 2.2 + node.targetPos.x * 1.7) *
            0.02 *
            (0.6 + uncertainty);
        const targetScale = (node.coverageTargetScale || 1) * breathe;
        node.coverageMesh.scale.lerp(
          new THREE.Vector3(targetScale, targetScale, targetScale),
          0.12,
        );
      }

      if (node.haloRing) {
        const base = 1 + Math.sin(time * 2 + node.targetPos.z * 0.8) * 0.08;
        node.haloRing.scale.set(base, base, base);
        node.haloRing.position.set(
          node.mesh.position.x,
          0.03,
          node.mesh.position.z,
        );
      }

      // Label follows
      if (node.label) {
        node.label.position.set(
          node.mesh.position.x,
          node.mesh.position.y + 0.4,
          node.mesh.position.z,
        );
      }

      // Update connection line
      if (node.line) {
        const positions = node.line.geometry.attributes.position;
        if (positions) {
          positions.setXYZ(
            1,
            node.mesh.position.x,
            node.mesh.position.y,
            node.mesh.position.z,
          );
          positions.needsUpdate = true;
        }
      }

      // Glow pulse based on signal quality
      const quality = node.meta.signal_quality || 50;
      const glowIntensity = 0.4 + (quality / 100) * 0.4;
      node.mesh.material.emissiveIntensity =
        glowIntensity +
        Math.sin(time * 2 + node.targetPos.z * 5) * (isNodes ? 0.05 : 0.1);
    }

    this._updateGraphLinksPositions();
  }

  _animateScanRing(delta) {
    if (!this.scanRing || !this.scanRing._active) return;

    this.scanRing._progress += delta * 0.8;

    if (this.scanRing._progress >= 1) {
      this.scanRing._active = false;
      this.scanRing.material.opacity = 0;
      return;
    }

    const p = this.scanRing._progress;
    const scale = 1 + p * 15;
    this.scanRing.scale.set(scale, scale, scale);
    this.scanRing.material.opacity = 0.5 * (1 - p);
  }

  _updateLabels() {
    // Labels automatically face camera as sprites
  }

  _onResize() {
    if (!this.container) return;
    const { width, height } = this._getContainerSize();
    if (!width || !height) return;

    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  }

  refreshSize() {
    this._onResize();
  }

  // ─── Public API ───

  destroy() {
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
    }

    for (const bssid of Object.keys(this.apNodes)) {
      this._removeAPNode(bssid);
    }

    if (this.matrixRain) {
      this.scene.remove(this.matrixRain);
      this.matrixRain.geometry.dispose();
      this.matrixRain.material.dispose();
    }

    if (this.starfield) {
      this.scene.remove(this.starfield);
      this.starfield.geometry.dispose();
      this.starfield.material.dispose();
    }

    if (this.skyDome) {
      this.scene.remove(this.skyDome);
      this.skyDome.geometry.dispose();
      this.skyDome.material.dispose();
    }

    if (this.graphLinksGroup) {
      this._clearGraphLinks();
      this.scene.remove(this.graphLinksGroup);
      this.graphLinksGroup = null;
    }

    this.renderer.dispose();
    this.isInitialized = false;
  }

  resetCamera() {
    this._spherical = {
      theta: Math.atan2(8, 8),
      phi: Math.acos(4 / Math.sqrt(6 * 6 + 4 * 4 + 8 * 8)),
      radius: Math.sqrt(6 * 6 + 4 * 4 + 8 * 8),
    };
    this._target.set(0, 0.5, 0);
  }

  getStats() {
    return {
      apNodes: Object.keys(this.apNodes).length,
      fps: Math.round(1 / Math.max(this.clock.getDelta(), 0.001)),
    };
  }
}

// Export for use in other modules
window.RFScene3D = RFScene3D;
