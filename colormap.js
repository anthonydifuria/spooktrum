/*
 * High-Res Spectrogram Generator
 * Copyright (C) 2026
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

window.Colormap = (() => {
    'use strict';

    function buildLUT(controlPoints) {
        const lut = new Float32Array(256 * 3);
        const n = controlPoints.length;
        for (let i = 0; i < 256; i++) {
            const t = i / 255;
            let seg = 0;
            for (let k = 0; k < n - 1; k++) {
                if (t >= controlPoints[k][0] && t <= controlPoints[k + 1][0]) {
                    seg = k;
                    break;
                }
            }
            const t0 = controlPoints[seg][0];
            const t1 = controlPoints[seg + 1][0];
            const localT = (t - t0) / (t1 - t0);
            const s = localT * localT * (3 - 2 * localT);
            for (let c = 0; c < 3; c++) {
                const v0 = controlPoints[seg][1 + c];
                const v1 = controlPoints[seg + 1][1 + c];
                lut[i * 3 + c] = v0 + (v1 - v0) * s;
            }
        }
        return lut;
    }

    const grayscaleControl = [
        [0.0, 0.0, 0.0, 0.0],
        [1.0, 1.0, 1.0, 1.0]
    ];

    const viridisControl = [
        [0.00, 0.267, 0.004, 0.329],
        [0.15, 0.282, 0.140, 0.458],
        [0.30, 0.253, 0.265, 0.530],
        [0.45, 0.207, 0.372, 0.553],
        [0.60, 0.163, 0.471, 0.558],
        [0.75, 0.128, 0.567, 0.551],
        [0.85, 0.268, 0.683, 0.482],
        [0.95, 0.544, 0.774, 0.247],
        [1.00, 0.993, 0.906, 0.144]
    ];

    const infernoControl = [
        [0.00, 0.001, 0.000, 0.014],
        [0.10, 0.087, 0.044, 0.214],
        [0.25, 0.232, 0.060, 0.438],
        [0.40, 0.407, 0.059, 0.467],
        [0.55, 0.576, 0.143, 0.404],
        [0.70, 0.735, 0.215, 0.330],
        [0.85, 0.881, 0.369, 0.191],
        [0.95, 0.965, 0.602, 0.059],
        [1.00, 0.988, 0.998, 0.645]
    ];

    const magmaControl = [
        [0.00, 0.001, 0.000, 0.014],
        [0.12, 0.078, 0.051, 0.206],
        [0.25, 0.232, 0.059, 0.438],
        [0.40, 0.443, 0.105, 0.525],
        [0.55, 0.631, 0.188, 0.529],
        [0.70, 0.802, 0.298, 0.484],
        [0.85, 0.937, 0.479, 0.545],
        [0.95, 0.988, 0.718, 0.694],
        [1.00, 0.987, 0.991, 0.750]
    ];

    const plasmaControl = [
        [0.00, 0.050, 0.030, 0.528],
        [0.15, 0.254, 0.028, 0.614],
        [0.30, 0.417, 0.025, 0.625],
        [0.45, 0.562, 0.084, 0.543],
        [0.60, 0.696, 0.168, 0.426],
        [0.75, 0.829, 0.267, 0.298],
        [0.85, 0.924, 0.399, 0.208],
        [0.95, 0.975, 0.598, 0.152],
        [1.00, 0.940, 0.975, 0.131]
    ];

    const maps = {
        grayscale: buildLUT(grayscaleControl),
        viridis: buildLUT(viridisControl),
        inferno: buildLUT(infernoControl),
        magma: buildLUT(magmaControl),
        plasma: buildLUT(plasmaControl)
    };

    function get(name) {
        if (!maps[name]) {
            console.warn(`Unknown colormap: ${name}, falling back to inferno`);
            return maps.inferno;
        }
        return maps[name];
    }

    function toRGBA(name) {
        const lut = get(name);
        const rgba = new Uint8Array(256 * 4);
        for (let i = 0; i < 256; i++) {
            rgba[i * 4 + 0] = Math.round(lut[i * 3 + 0] * 255);
            rgba[i * 4 + 1] = Math.round(lut[i * 3 + 1] * 255);
            rgba[i * 4 + 2] = Math.round(lut[i * 3 + 2] * 255);
            rgba[i * 4 + 3] = 255;
        }
        return rgba;
    }

    function list() {
        return Object.keys(maps);
    }

    return { get, toRGBA, list };
})();