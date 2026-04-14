"""
Position Estimator Module
Estimates 3D positions of WiFi access points from RSSI measurements
using a single stationary receiver.

Methodology:
1. RSSI → Distance via Log-Distance Path Loss Model
2. Initial angular placement using deterministic BSSID hash
3. Temporal correlation clustering (APs with correlated signal variation are nearby)
4. Force-directed refinement respecting distance constraints
5. Convergence animation with decreasing uncertainty
"""

import math
import hashlib
import threading
import time
from typing import List, Dict, Optional, Any, Tuple
from dataclasses import dataclass
from datetime import datetime
import json


@dataclass
class Position3D:
    """3D position with uncertainty."""
    x: float = 0.0
    y: float = 0.0
    z: float = 0.0
    uncertainty: float = 1.0  # 0 = confident, 1 = max uncertainty
    confidence: float = 0.0   # 0-1, increases with samples

    def to_dict(self) -> Dict[str, float]:
        return {"x": self.x, "y": self.y, "z": self.z,
                "uncertainty": self.uncertainty, "confidence": self.confidence}

    def distance_to(self, other: 'Position3D') -> float:
        return math.sqrt(
            (self.x - other.x)**2 +
            (self.y - other.y)**2 +
            (self.z - other.z)**2
        )

    def lerp_to(self, target: 'Position3D', t: float) -> 'Position3D':
        """Linearly interpolate towards target position."""
        return Position3D(
            x=self.x + (target.x - self.x) * t,
            y=self.y + (target.y - self.y) * t,
            z=self.z + (target.z - self.z) * t,
            uncertainty=self.uncertainty + (target.uncertainty - self.uncertainty) * t,
            confidence=self.confidence + (target.confidence - self.confidence) * t,
        )


class PositionEstimator:
    """
    Estimates 3D positions of APs from a single stationary receiver.

    Since we have only one receiver, true triangulation is impossible.
    Instead, we use:
    - Distance from RSSI (radial constraint)
    - Deterministic angular placement from BSSID hash (reproducible)
    - Temporal correlation of RSSI variance (co-location hints)
    - Force-directed layout refinement
    """

    # Scale factor: meters to 3D scene units
    SCALE = 0.3

    # Minimum distance between AP nodes in scene units
    MIN_NODE_SEPARATION = 0.8

    # Origin position (the receiver/user)
    ORIGIN = Position3D(0, 0, 0, 0, 1.0)

    def __init__(self):
        self._lock = threading.Lock()
        self.positions: Dict[str, Position3D] = {}       # Current positions
        self.target_positions: Dict[str, Position3D] = {} # Convergence targets
        self._correlation_matrix: Dict[Tuple[str, str], float] = {}
        self._update_callbacks: List[Any] = []
        self._refining = False
        self._refine_thread: Optional[threading.Thread] = None
        self.iteration = 0

    def on_position_update(self, callback):
        """Register callback for position updates."""
        self._update_callbacks.append(callback)

    def _bssid_to_angles(self, bssid_hash: str) -> Tuple[float, float]:
        """
        Convert BSSID hash to deterministic spherical coordinates (theta, phi).
        This gives each AP a unique, reproducible direction from the origin.
        """
        # Use first 8 bytes of hash for theta, next 8 for phi
        h = bssid_hash
        theta_seed = int(h[:8], 16) / 0xFFFFFFFF
        phi_seed = int(h[8:16], 16) / 0xFFFFFFFF

        # theta: 0 to 2*pi (azimuthal angle in XZ plane)
        theta = theta_seed * 2.0 * math.pi

        # phi: -pi/3 to pi/3 (elevation - keep APs roughly at human height)
        # Most APs are at similar height, so restrict vertical spread
        phi = (phi_seed - 0.5) * (math.pi / 2.5)

        return theta, phi

    def _polar_to_cartesian(self, distance: float, theta: float, phi: float) -> Position3D:
        """Convert spherical coordinates to cartesian."""
        x = distance * math.cos(phi) * math.cos(theta)
        y = distance * math.sin(phi)
        z = distance * math.cos(phi) * math.sin(theta)
        return Position3D(x=x, y=y, z=z)

    def compute_correlation(self, ap_list: List[Any]) -> Dict[Tuple[str, str], float]:
        """
        Compute Pearson correlation between RSSI time series of AP pairs.
        APs with highly correlated signal variation are likely:
        - In the same direction from the receiver
        - Behind the same obstacles
        - Part of the same physical infrastructure
        """
        correlations = {}
        n_aps = len(ap_list)

        for i in range(n_aps):
            for j in range(i + 1, n_aps):
                ap_a = ap_list[i]
                ap_b = ap_list[j]

                # Need at least 5 common samples
                min_len = min(len(ap_a.rssi_history), len(ap_b.rssi_history))
                if min_len < 5:
                    correlations[(ap_a.bssid, ap_b.bssid)] = 0.0
                    continue

                # Use the last min_len samples
                a_series = ap_a.rssi_history[-min_len:]
                b_series = ap_b.rssi_history[-min_len:]

                # Pearson correlation
                mean_a = sum(a_series) / min_len
                mean_b = sum(b_series) / min_len

                cov = sum((a - mean_a) * (b - mean_b)
                          for a, b in zip(a_series, b_series))
                var_a = sum((a - mean_a)**2 for a in a_series)
                var_b = sum((b - mean_b)**2 for b in b_series)

                if var_a > 0 and var_b > 0:
                    corr = cov / (math.sqrt(var_a) * math.sqrt(var_b))
                    # Clamp to [-1, 1]
                    corr = max(-1.0, min(1.0, corr))
                else:
                    corr = 0.0

                correlations[(ap_a.bssid, ap_b.bssid)] = corr

        return correlations

    def estimate_positions(self, ap_list: List[Any]) -> Dict[str, Position3D]:
        """
        Compute estimated 3D positions for all access points.
        Called after each scan to refine positions.
        """
        if not ap_list:
            return {}

        with self._lock:
            # Step 1: Update correlation matrix
            if self.iteration % 5 == 0 and len(ap_list) > 1:
                self._correlation_matrix = self.compute_correlation(ap_list)

            # Step 2: Compute initial positions from RSSI + BSSID hash
            new_targets: Dict[str, Position3D] = {}

            for ap in ap_list:
                distance_m = ap.distance_estimate
                distance_scene = distance_m * self.SCALE

                # Get deterministic angles from BSSID
                theta, phi = self._bssid_to_angles(ap.bssid_hash)

                # If we have correlation data, adjust angles for correlated APs
                # Correlated APs should be placed closer together
                if self._correlation_matrix and ap.sample_count > 5:
                    theta, phi = self._adjust_for_correlation(
                        ap.bssid, theta, phi, ap_list
                    )

                pos = self._polar_to_cartesian(distance_scene, theta, phi)

                # Compute confidence based on sample count and RSSI stability
                max_confidence = min(ap.sample_count / 15.0, 1.0)
                # Lower uncertainty for stable signals
                if ap.rssi_std < 2:
                    stability_bonus = 0.2
                elif ap.rssi_std < 5:
                    stability_bonus = 0.1
                else:
                    stability_bonus = 0.0

                pos.confidence = min(max_confidence + stability_bonus, 1.0)
                pos.uncertainty = 1.0 - pos.confidence

                new_targets[ap.bssid] = pos

            # Step 3: Force-directed refinement to reduce overlap
            new_targets = self._force_directed_refinement(new_targets)

            # Step 4: Update targets (for smooth convergence)
            for bssid, new_pos in new_targets.items():
                if bssid in self.positions:
                    # Smooth transition: current position lerps toward target
                    current = self.positions[bssid]
                    self.target_positions[bssid] = new_pos
                    # Lerp factor depends on confidence
                    lerp_t = 0.15 + (0.35 * new_pos.confidence)
                    self.positions[bssid] = current.lerp_to(new_pos, lerp_t)
                else:
                    # New AP: start at origin and expand outward
                    self.positions[bssid] = Position3D(0, 0, 0, 1.0, 0.0)
                    self.target_positions[bssid] = new_pos

            self.iteration += 1

        # Fire callbacks
        for cb in self._update_callbacks:
            try:
                cb(self.positions)
            except Exception as e:
                print(f"[position_estimator] Callback error: {e}")

        return self.positions

    def _adjust_for_correlation(self, bssid: str, theta: float, phi: float,
                                 ap_list: List[Any]) -> Tuple[float, float]:
        """
        Adjust angular position based on correlation with other APs.
        Highly correlated APs are pulled closer in angle.
        """
        # Find the AP this one is most correlated with
        max_corr = 0.0
        correlated_bssid = None

        for (a, b), corr in self._correlation_matrix.items():
            if a == bssid and abs(corr) > max_corr:
                max_corr = abs(corr)
                correlated_bssid = b
            elif b == bssid and abs(corr) > max_corr:
                max_corr = abs(corr)
                correlated_bssid = a

        if correlated_bssid and correlated_bssid in self.positions and max_corr > 0.5:
            # Pull this AP's angle slightly toward the correlated AP
            corr_pos = self.positions[correlated_bssid]
            if corr_pos.x != 0 or corr_pos.z != 0:
                corr_theta = math.atan2(corr_pos.z, corr_pos.x)
                corr_phi = math.asin(corr_pos.y / max(
                    math.sqrt(corr_pos.x**2 + corr_pos.y**2 + corr_pos.z**2), 0.01
                ))

                # Blend: stronger correlation = more pull
                blend = max_corr * 0.3  # Max 30% pull
                theta = theta + (corr_theta - theta) * blend
                phi = phi + (corr_phi - phi) * blend

        return theta, phi

    def _force_directed_refinement(self, positions: Dict[str, Position3D],
                                    iterations: int = 20) -> Dict[str, Position3D]:
        """
        Apply force-directed layout to reduce node overlap while
        maintaining distance constraints from the origin.
        """
        if len(positions) < 2:
            return positions

        bssids = list(positions.keys())
        pos_array = {b: Position3D(
            positions[b].x, positions[b].y, positions[b].z,
            positions[b].uncertainty, positions[b].confidence
        ) for b in bssids}

        for _ in range(iterations):
            forces = {b: [0.0, 0.0, 0.0] for b in bssids}

            # Repulsion between all pairs (prevent overlap)
            for i in range(len(bssids)):
                for j in range(i + 1, len(bssids)):
                    a, b = bssids[i], bssids[j]
                    dx = pos_array[a].x - pos_array[b].x
                    dy = pos_array[a].y - pos_array[b].y
                    dz = pos_array[a].z - pos_array[b].z
                    dist = math.sqrt(dx*dx + dy*dy + dz*dz) + 0.01

                    if dist < self.MIN_NODE_SEPARATION * 3:
                        # Repulsion force inversely proportional to distance
                        force = (self.MIN_NODE_SEPARATION ** 2) / (dist ** 2)
                        fx = (dx / dist) * force
                        fy = (dy / dist) * force
                        fz = (dz / dist) * force

                        forces[a][0] += fx
                        forces[a][1] += fy
                        forces[a][2] += fz
                        forces[b][0] -= fx
                        forces[b][1] -= fy
                        forces[b][2] -= fz

            # Attraction toward original distance from origin (radial constraint)
            for b in bssids:
                dist_from_origin = math.sqrt(
                    pos_array[b].x**2 + pos_array[b].y**2 + pos_array[b].z**2
                ) + 0.01

                # Target distance from positions dict (original estimate)
                original_dist = math.sqrt(
                    positions[b].x**2 + positions[b].y**2 + positions[b].z**2
                )

                if dist_from_origin > 0.01:
                    # Pull toward correct radial distance
                    diff = original_dist - dist_from_origin
                    force = diff * 0.5  # Spring constant
                    fx = (pos_array[b].x / dist_from_origin) * force
                    fy = (pos_array[b].y / dist_from_origin) * force
                    fz = (pos_array[b].z / dist_from_origin) * force

                    forces[b][0] += fx
                    forces[b][1] += fy
                    forces[b][2] += fz

            # Apply forces with damping
            damping = 0.1
            for b in bssids:
                pos_array[b].x += forces[b][0] * damping
                pos_array[b].y += forces[b][1] * damping
                pos_array[b].z += forces[b][2] * damping

        return pos_array

    def get_positions(self) -> Dict[str, Position3D]:
        """Get current estimated positions."""
        with self._lock:
            return dict(self.positions)

    def get_positions_json(self) -> str:
        """Get positions as JSON."""
        with self._lock:
            result = {}
            for bssid, pos in self.positions.items():
                result[bssid] = pos.to_dict()
            return json.dumps(result)

    def get_coverage_radius(self, ap: Any) -> float:
        """
        Estimate coverage radius for an AP based on signal strength.
        Stronger signal = larger estimated coverage area.
        """
        # Typical indoor WiFi range: 15-45 meters
        # Strong signal = closer = we're inside coverage
        # Use inverse of distance as coverage indicator
        base_radius = 15.0  # meters

        # Adjust based on band (5GHz has shorter range)
        if ap.band == "5GHz":
            base_radius = 10.0

        # Adjust based on signal quality
        quality_factor = ap.signal_quality / 100.0
        coverage = base_radius * (0.5 + quality_factor)

        return coverage * self.SCALE

    def reset(self):
        """Reset all position estimates."""
        with self._lock:
            self.positions.clear()
            self.target_positions.clear()
            self._correlation_matrix.clear()
            self.iteration = 0