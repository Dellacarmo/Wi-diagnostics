/**
 * RF Space Observatory — 3D Scene Manager
 * Three.js-based real-time WiFi space visualization
 * with bloom glow, coverage spheres, matrix rain, and convergence animation.
 */

class RFScene3D {
    constructor(containerId) {
        this.container = document.getElementById(containerId);
        if (!this.container) {
            console.error('[scene3d] Container not found:', containerId);
            return;
        }

        // State
        this.apNodes = {};          // bssid → { mesh, sphere, label, line, targetPos }
        this.originNode = null;
        this.particles = null;
        this.matrixRain = null;
        this.clock = new THREE.Clock();
        this.animationId = null;
        this.isInitialized = false;

        // Colors
        this.colors = {
            cyan: new THREE.Color(0x00FFCC),
            magenta: new THREE.Color(0xFF00AA),
            amber: new THREE.Color(0xFFB800),
            grid: new THREE.Color(0x0A1628),
            gridBright: new THREE.Color(0x00FFCC),
            bg: new THREE.Color(0x060A12),
        };

        this._init();
    }

    _init() {
        const width = this.container.clientWidth;
        const height = this.container.clientHeight;

        // Scene
        this.scene = new THREE.Scene();
        this.scene.fog = new THREE.FogExp2(0x060A12, 0.08);

        // Camera
        this.camera = new THREE.PerspectiveCamera(60, width / height, 0.1, 1000);
        this.camera.position.set(6, 4, 8);
        this.camera.lookAt(0, 0, 0);

        // Renderer
        this.renderer = new THREE.WebGLRenderer({
            antialias: true,
            alpha: false,
            powerPreference: 'high-performance',
        });
        this.renderer.setSize(width, height);
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this.renderer.setClearColor(0x060A12);
        this.renderer.shadowMap.enabled = false;
        this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
        this.renderer.toneMappingExposure = 1.2;
        this.container.appendChild(this.renderer.domElement);

        // Lights
        this._setupLights();

        // Grid floor
        this._createGrid();

        // Origin marker
        this._createOriginMarker();

        // Matrix rain particles
        this._createMatrixRain();

        // Scan ring effect
        this._createScanRing();

        // Controls (manual orbit)
        this._setupControls();

        // Resize handler
        window.addEventListener('resize', () => this._onResize());

        // Start render loop
        this.isInitialized = true;
        this._animate();

        console.log('[scene3d] ✅ 3D scene initialized');
    }

    _setupLights() {
        // Ambient
        const ambient = new THREE.AmbientLight(0x1a2235, 0.8);
        this.scene.add(ambient);

        // Main directional (from above)
        const dirLight = new THREE.DirectionalLight(0x00FFCC, 0.3);
        dirLight.position.set(5, 10, 5);
        this.scene.add(dirLight);

        // Point light at origin
        const pointLight = new THREE.PointLight(0xFFB800, 1, 20);
        pointLight.position.set(0, 1, 0);
        this.scene.add(pointLight);
        this.originLight = pointLight;

        // Hemisphere
        const hemiLight = new THREE.HemisphereLight(0x0A0E17, 0x00FFCC, 0.15);
        this.scene.add(hemiLight);
    }

    _createGrid() {
        // Custom grid with glow
        const gridSize = 30;
        const gridDivisions = 30;
        const grid = new THREE.GridHelper(gridSize, gridDivisions, 0x00FFCC, 0x0A1628);
        grid.material.opacity = 0.15;
        grid.material.transparent = true;
        grid.position.y = -0.01;
        this.scene.add(grid);

        // Inner bright grid
        const innerGrid = new THREE.GridHelper(10, 10, 0x00FFCC, 0x00FFCC);
        innerGrid.material.opacity = 0.05;
        innerGrid.material.transparent = true;
        innerGrid.position.y = 0;
        this.scene.add(innerGrid);

        // Axes helper (subtle)
        const axisLen = 2;
        const axisMat = (color) => new THREE.LineBasicMaterial({ color, opacity: 0.3, transparent: true });
        
        const xGeo = new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(0,0,0), new THREE.Vector3(axisLen,0,0)
        ]);
        const yGeo = new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(0,0,0), new THREE.Vector3(0,axisLen,0)
        ]);
        const zGeo = new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(0,0,0), new THREE.Vector3(0,0,axisLen)
        ]);

        this.scene.add(new THREE.Line(xGeo, axisMat(0xFF4444)));
        this.scene.add(new THREE.Line(yGeo, axisMat(0x44FF44)));
        this.scene.add(new THREE.Line(zGeo, axisMat(0x4444FF)));
    }

    _createOriginMarker() {
        // Diamond shape for user position
        const geo = new THREE.OctahedronGeometry(0.2, 0);
        const mat = new THREE.MeshPhongMaterial({
            color: 0xFFB800,
            emissive: 0xFFB800,
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
            color: 0xFFB800,
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
            color: 0xFFB800,
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

        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1));

        const material = new THREE.PointsMaterial({
            color: 0x00FFCC,
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
            color: 0x00FFCC,
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
        this._spherical = { theta: Math.atan2(this.camera.position.x, this.camera.position.z), phi: Math.acos(this.camera.position.y / this.camera.position.length()), radius: this.camera.position.length() };
        this._target = new THREE.Vector3(0, 0.5, 0);

        const canvas = this.renderer.domElement;

        canvas.addEventListener('mousedown', (e) => {
            if (e.button === 0) this._isDragging = true;
            if (e.button === 2) this._isPanning = true;
            this._prevMouse = { x: e.clientX, y: e.clientY };
        });

        canvas.addEventListener('mousemove', (e) => {
            const dx = e.clientX - this._prevMouse.x;
            const dy = e.clientY - this._prevMouse.y;
            this._prevMouse = { x: e.clientX, y: e.clientY };

            if (this._isDragging) {
                this._spherical.theta -= dx * 0.005;
                this._spherical.phi = Math.max(0.1, Math.min(Math.PI - 0.1, this._spherical.phi + dy * 0.005));
            }

            if (this._isPanning) {
                const panSpeed = 0.01;
                const right = new THREE.Vector3();
                const up = new THREE.Vector3(0, 1, 0);
                right.crossVectors(this.camera.getWorldDirection(new THREE.Vector3()), up).normalize();
                this._target.add(right.multiplyScalar(-dx * panSpeed));
                this._target.y += dy * panSpeed;
            }
        });

        canvas.addEventListener('mouseup', () => {
            this._isDragging = false;
            this._isPanning = false;
        });

        canvas.addEventListener('mouseleave', () => {
            this._isDragging = false;
            this._isPanning = false;
        });

        canvas.addEventListener('wheel', (e) => {
            e.preventDefault();
            this._spherical.radius += e.deltaY * 0.005;
            this._spherical.radius = Math.max(2, Math.min(30, this._spherical.radius));
        }, { passive: false });

        canvas.addEventListener('contextmenu', (e) => e.preventDefault());

        // Touch controls
        let touchStart = null;
        let touchDist = null;

        canvas.addEventListener('touchstart', (e) => {
            if (e.touches.length === 1) {
                touchStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
            } else if (e.touches.length === 2) {
                const dx = e.touches[0].clientX - e.touches[1].clientX;
                const dy = e.touches[0].clientY - e.touches[1].clientY;
                touchDist = Math.sqrt(dx * dx + dy * dy);
            }
        });

        canvas.addEventListener('touchmove', (e) => {
            e.preventDefault();
            if (e.touches.length === 1 && touchStart) {
                const dx = e.touches[0].clientX - touchStart.x;
                const dy = e.touches[0].clientY - touchStart.y;
                this._spherical.theta -= dx * 0.005;
                this._spherical.phi = Math.max(0.1, Math.min(Math.PI - 0.1, this._spherical.phi + dy * 0.005));
                touchStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
            } else if (e.touches.length === 2 && touchDist) {
                const dx = e.touches[0].clientX - e.touches[1].clientX;
                const dy = e.touches[0].clientY - e.touches[1].clientY;
                const newDist = Math.sqrt(dx * dx + dy * dy);
                this._spherical.radius *= touchDist / newDist;
                this._spherical.radius = Math.max(2, Math.min(30, this._spherical.radius));
                touchDist = newDist;
            }
        }, { passive: false });
    }

    _updateCamera() {
        const r = this._spherical.radius;
        const theta = this._spherical.theta;
        const phi = this._spherical.phi;

        this.camera.position.set(
            this._target.x + r * Math.sin(phi) * Math.sin(theta),
            this._target.y + r * Math.cos(phi),
            this._target.z + r * Math.sin(phi) * Math.cos(theta)
        );
        this.camera.lookAt(this._target);
    }

    // ─── AP Node Management ───

    updateAccessPoints(positions, apMetadata) {
        if (!this.isInitialized) return;

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
        }

        // Remove nodes that are no longer visible
        for (const bssid of Object.keys(this.apNodes)) {
            if (!activeBssids.has(bssid)) {
                this._removeAPNode(bssid);
            }
        }
    }

    _createAPNode(bssid, pos, meta) {
        const band = meta.band || '2.4GHz';
        const color = band === '5GHz' ? this.colors.magenta : this.colors.cyan;
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
        const label = this._createLabel(meta.ssid_label || 'Unknown', band);

        // Store reference
        this.apNodes[bssid] = {
            mesh,
            glowMesh,
            coverageMesh,
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

        const band = meta.band || node.meta.band || '2.4GHz';
        const color = band === '5GHz' ? this.colors.magenta : this.colors.cyan;
        const signalQuality = meta.signal_quality || 50;
        const uncertainty = pos.uncertainty || 1;
        const confidence = pos.confidence || 0;

        // Update target position (smooth convergence)
        node.targetPos.set(pos.x || 0, (pos.y || 0) + 0.5, pos.z || 0);
        node.currentConfidence = confidence;

        // Update node size based on signal
        const nodeSize = 0.08 + (signalQuality / 100) * 0.2;
        const targetScale = nodeSize / 0.15; // Normalize to base size
        node.mesh.scale.lerp(new THREE.Vector3(targetScale, targetScale, targetScale), 0.1);

        // Update emissive intensity based on confidence
        node.mesh.material.emissiveIntensity = 0.4 + confidence * 0.6;

        // Update coverage sphere opacity (uncertainty visualization)
        if (node.coverageMesh) {
            node.coverageMesh.material.opacity = 0.04 * (1 - uncertainty * 0.7);
            
            // Update coverage radius
            const newRadius = this._estimateCoverageRadius(signalQuality, band);
            node.coverageMesh.scale.lerp(
                new THREE.Vector3(newRadius / (node.coverageMesh.geometry.parameters.radius || 1),
                                   newRadius / (node.coverageMesh.geometry.parameters.radius || 1),
                                   newRadius / (node.coverageMesh.geometry.parameters.radius || 1)),
                0.05
            );
        }

        // Update line
        if (node.line) {
            const positions = node.line.geometry.attributes.position;
            if (positions) {
                positions.setXYZ(1, node.mesh.position.x, node.mesh.position.y, node.mesh.position.z);
                positions.needsUpdate = true;
            }
        }

        node.meta = { ...node.meta, ...meta };
    }

    _removeAPNode(bssid) {
        const node = this.apNodes[bssid];
        if (!node) return;

        this.scene.remove(node.mesh);
        this.scene.remove(node.coverageMesh);
        this.scene.remove(node.line);
        if (node.label && node.label.parentNode) {
            node.label.parentNode.removeChild(node.label);
        }

        // Dispose geometries and materials
        node.mesh.geometry.dispose();
        node.mesh.material.dispose();
        node.coverageMesh.geometry.dispose();
        node.coverageMesh.material.dispose();
        node.line.geometry.dispose();
        node.line.material.dispose();

        delete this.apNodes[bssid];
    }

    _createLabel(text, band) {
        // Create a simple sprite label
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        canvas.width = 256;
        canvas.height = 64;

        ctx.fillStyle = 'rgba(10, 14, 23, 0.85)';
        ctx.roundRect(0, 0, 256, 64, 8);
        ctx.fill();

        ctx.strokeStyle = band === '5GHz' ? 'rgba(255, 0, 170, 0.4)' : 'rgba(0, 255, 204, 0.4)';
        ctx.lineWidth = 2;
        ctx.roundRect(0, 0, 256, 64, 8);
        ctx.stroke();

        ctx.fillStyle = band === '5GHz' ? '#FF00AA' : '#00FFCC';
        ctx.font = 'bold 22px monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(text.toUpperCase(), 128, 32);

        const texture = new THREE.CanvasTexture(canvas);
        texture.needsUpdate = true;

        const spriteMat = new THREE.SpriteMaterial({
            map: texture,
            transparent: true,
            depthWrite: false,
        });
        const sprite = new THREE.Sprite(spriteMat);
        sprite.scale.set(1.2, 0.3, 1);
        this.scene.add(sprite);

        return sprite;
    }

    _estimateCoverageRadius(quality, band) {
        const base = band === '5GHz' ? 1.5 : 2.5;
        return base * (0.5 + quality / 100);
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
        this.matrixRain.material.opacity = 0.2 + Math.sin(this.clock.getElapsedTime() * 0.5) * 0.1;
    }

    _animateOrigin(time) {
        if (!this.originNode) return;

        // Gentle bob
        this.originNode.mesh.position.y = 0.2 + Math.sin(time * 2) * 0.05;
        this.originNode.mesh.rotation.y = time * 0.5;

        // Pulse ring
        const pulseScale = 1 + Math.sin(time * 3) * 0.2;
        this.originNode.pulseRing.scale.set(pulseScale, pulseScale, pulseScale);
        this.originNode.pulseRing.material.opacity = 0.2 * (1 - (pulseScale - 1) * 2);

        // Origin light pulse
        this.originLight.intensity = 0.8 + Math.sin(time * 2) * 0.3;
    }

    _animateAPNodes(delta, time) {
        for (const [bssid, node] of Object.entries(this.apNodes)) {
            // Smooth position convergence
            node.mesh.position.lerp(node.targetPos, 0.08);

            // Gentle floating animation
            node.mesh.position.y = node.targetPos.y + Math.sin(time * 1.5 + node.targetPos.x * 3) * 0.03;

            // Scale-in animation for new nodes
            if (node.mesh.scale.x < 0.95) {
                const s = node.mesh.scale.x + delta * 2;
                node.mesh.scale.set(s, s, s);
            }

            // Coverage sphere follows
            if (node.coverageMesh) {
                node.coverageMesh.position.copy(node.mesh.position);
            }

            // Label follows
            if (node.label) {
                node.label.position.set(
                    node.mesh.position.x,
                    node.mesh.position.y + 0.4,
                    node.mesh.position.z
                );
            }

            // Update connection line
            if (node.line) {
                const positions = node.line.geometry.attributes.position;
                if (positions) {
                    positions.setXYZ(1, node.mesh.position.x, node.mesh.position.y, node.mesh.position.z);
                    positions.needsUpdate = true;
                }
            }

            // Glow pulse based on signal quality
            const quality = node.meta.signal_quality || 50;
            const glowIntensity = 0.4 + (quality / 100) * 0.4;
            node.mesh.material.emissiveIntensity = glowIntensity + Math.sin(time * 2 + node.targetPos.z * 5) * 0.1;
        }
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
        const width = this.container.clientWidth;
        const height = this.container.clientHeight;

        this.camera.aspect = width / height;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(width, height);
    }

    // ─── Public API ───

    destroy() {
        if (this.animationId) {
            cancelAnimationFrame(this.animationId);
        }

        for (const bssid of Object.keys(this.apNodes)) {
            this._removeAPNode(bssid);
        }

        this.renderer.dispose();
        this.isInitialized = false;
    }

    resetCamera() {
        this._spherical = {
            theta: Math.atan2(8, 8),
            phi: Math.acos(4 / Math.sqrt(6*6 + 4*4 + 8*8)),
            radius: Math.sqrt(6*6 + 4*4 + 8*8),
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