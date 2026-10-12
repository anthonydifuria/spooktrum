/*
 * High-Res Spectrogram Generator
 * Copyright (C) 2026
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

const WebGLRenderer = (() => {
    'use strict';

    const ENCODE_MIN = -180.0;
    const ENCODE_MAX = 10.0;

    const VERTEX_SOURCE = `#version 300 es
precision highp float;

in vec2 a_position;
out vec2 v_uv;

void main() {
    v_uv = a_position * 0.5 + 0.5;
    gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

    const FRAGMENT_SOURCE = `#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 out_color;

uniform sampler2D u_spectrum;
uniform sampler2D u_palette;

uniform float u_encodeMin;
uniform float u_encodeMax;
uniform float u_dbMin;
uniform float u_dbMax;

uniform float u_freqMin;
uniform float u_freqMax;
uniform float u_freqScale;

uniform float u_sampleRate;
uniform float u_fftSize;
uniform float u_bins;
uniform float u_hop;
uniform float u_duration;

uniform float u_totalWidth;
uniform float u_totalHeight;
uniform float u_tileOffsetX;
uniform float u_tileOffsetY;

uniform float u_frameStart;
uniform float u_frameCount;

float frequencyAt(float p) {
    // p va da 0.0 (basso) a 1.0 (alto)
    
    // Preveniamo il disastro del log(0) forzando un minimo di 10 Hz per i calcoli
    float minF = max(u_freqMin, 10.0);
    float maxF = max(u_freqMax, minF + 10.0);

    // 1. Mappatura puramente lineare
    float fLin = u_freqMin + p * (u_freqMax - u_freqMin);

    // 2. Mappatura puramente logaritmica (esponenziale)
    float ratio = maxF / minF;
    float fLog = minF * pow(ratio, p);

    // 3. Interpolazione fluida tra le due curve
    float mixedFreq = mix(fLin, fLog, u_freqScale);

    // Sicurezza finale: nessuna frequenza visualizzata scenda sotto i 10 Hz
    return max(mixedFreq, 10.0);
}

void main() {
    float outputX = u_tileOffsetX + gl_FragCoord.x;
    float time = outputX / u_totalWidth * u_duration;
    float framePosition = time * u_sampleRate / u_hop;
    float u = (framePosition - u_frameStart + 0.5) / u_frameCount;

    float p = (u_tileOffsetY + gl_FragCoord.y - 0.5) / u_totalHeight;
    float frequency = frequencyAt(clamp(p, 0.0, 1.0));
    float binPosition = frequency * u_fftSize / u_sampleRate;
    float v = (binPosition + 0.5) / u_bins;

    vec2 encoded = texture(u_spectrum, vec2(u, v)).rg;
    float normalized = (encoded.r * 255.0 * 256.0 + encoded.g * 255.0) / 65535.0;
    float db = mix(u_encodeMin, u_encodeMax, normalized);

    float level = clamp((db - u_dbMin) / max(1.0, u_dbMax - u_dbMin), 0.0, 1.0);
    float lutU = (level * 255.0 + 0.5) / 256.0;
    vec3 color = texture(u_palette, vec2(lutU, 0.5)).rgb;

    float noise = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
    color += (noise - 0.5) / 255.0;

    out_color = vec4(clamp(color, 0.0, 1.0), 1.0);
}
`;

    function compileShader(gl, type, source) {
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            const log = gl.getShaderInfoLog(shader);
            gl.deleteShader(shader);
            throw new Error('Shader compilation failed: ' + log);
        }
        return shader;
    }

    class Renderer {
        constructor() {
            this.canvas = document.createElement('canvas');
            const gl = this.canvas.getContext('webgl2', {
                alpha: false,
                antialias: false,
                depth: false,
                stencil: false,
                preserveDrawingBuffer: false,
                powerPreference: 'high-performance'
            });

            if (!gl) {
                throw new Error('WebGL 2 is not available.');
            }
            this.gl = gl;
            this.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);

            this._buildProgram();
            this._buildQuad();
            this._buildSpectrumTexture();
            this._buildPaletteTexture();

            this.targetTexture = null;
            this.targetFramebuffer = null;
            this.targetWidth = 0;
            this.targetHeight = 0;
        }

        _buildProgram() {
            const gl = this.gl;
            const vertex = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SOURCE);
            const fragment = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SOURCE);

            this.program = gl.createProgram();
            gl.attachShader(this.program, vertex);
            gl.attachShader(this.program, fragment);
            gl.linkProgram(this.program);

            if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) {
                throw new Error('Shader link failed: ' + gl.getProgramInfoLog(this.program));
            }

            gl.deleteShader(vertex);
            gl.deleteShader(fragment);

            this.attributes = {
                position: gl.getAttribLocation(this.program, 'a_position')
            };

            const uniformNames = [
                'u_spectrum', 'u_palette',
                'u_encodeMin', 'u_encodeMax', 'u_dbMin', 'u_dbMax',
                'u_freqMin', 'u_freqMax', 'u_freqScale',
                'u_sampleRate', 'u_fftSize', 'u_bins', 'u_hop', 'u_duration',
                'u_totalWidth', 'u_totalHeight', 'u_tileOffsetX', 'u_tileOffsetY',
                'u_frameStart', 'u_frameCount'
            ];

            this.uniforms = {};
            for (const name of uniformNames) {
                this.uniforms[name] = gl.getUniformLocation(this.program, name);
            }
        }

        _buildQuad() {
            const gl = this.gl;
            this.vao = gl.createVertexArray();
            gl.bindVertexArray(this.vao);

            const buffer = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
            gl.bufferData(
                gl.ARRAY_BUFFER,
                new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
                gl.STATIC_DRAW
            );

            const location = this.attributes.position;
            gl.enableVertexAttribArray(location);
            gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);

            gl.bindVertexArray(null);
        }

        _buildSpectrumTexture() {
            const gl = this.gl;
            this.spectrumTexture = gl.createTexture();
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, this.spectrumTexture);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        }

        _buildPaletteTexture() {
            const gl = this.gl;
            this.paletteTexture = gl.createTexture();
            gl.activeTexture(gl.TEXTURE1);
            gl.bindTexture(gl.TEXTURE_2D, this.paletteTexture);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            this.setColormap('inferno');
        }

        setColormap(name) {
            const gl = this.gl;
            const rgba = Colormap.toRGBA(name);
            gl.activeTexture(gl.TEXTURE1);
            gl.bindTexture(gl.TEXTURE_2D, this.paletteTexture);
            gl.texImage2D(
                gl.TEXTURE_2D, 0, gl.RGBA8, 256, 1, 0,
                gl.RGBA, gl.UNSIGNED_BYTE, rgba
            );
            gl.activeTexture(gl.TEXTURE0);
        }

        _ensureTarget(width, height) {
            if (this.targetWidth === width && this.targetHeight === height) return;

            const gl = this.gl;

            if (this.targetTexture) gl.deleteTexture(this.targetTexture);
            if (this.targetFramebuffer) gl.deleteFramebuffer(this.targetFramebuffer);

            // 1. CREA la texture prima di fare qualsiasi cosa!
            this.targetTexture = gl.createTexture();
            
            // 2. Ora possiamo farne il bind sull'unità 2 in sicurezza
            gl.activeTexture(gl.TEXTURE2);
            gl.bindTexture(gl.TEXTURE_2D, this.targetTexture);
            
            // 3. Alloca la memoria
            gl.texImage2D(
                gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0,
                gl.RGBA, gl.UNSIGNED_BYTE, null
            );
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

            // 4. Collega la texture al framebuffer
            this.targetFramebuffer = gl.createFramebuffer();
            gl.bindFramebuffer(gl.FRAMEBUFFER, this.targetFramebuffer);
            gl.framebufferTexture2D(
                gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0,
                gl.TEXTURE_2D, this.targetTexture, 0
            );

            // 5. Verifica che sia tutto corretto
            const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
            if (status !== gl.FRAMEBUFFER_COMPLETE) {
                throw new Error('Framebuffer incomplete (0x' + status.toString(16) + '). Try a smaller resolution.');
            }

            // 6. Ripristina l'unità 0 come predefinita
            gl.activeTexture(gl.TEXTURE0);

            this.targetWidth = width;
            this.targetHeight = height;
        }

        // CORREZIONE: ri-assegna esplicitamente le unità dopo _ensureTarget
        _bindSamplers() {
            const gl = this.gl;
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, this.spectrumTexture);
            gl.activeTexture(gl.TEXTURE1);
            gl.bindTexture(gl.TEXTURE_2D, this.paletteTexture);
            gl.activeTexture(gl.TEXTURE0);
        }

        _encode(raw, frameCount, bins) {
            const encoded = new Uint8Array(frameCount * bins * 2);
            const span = ENCODE_MAX - ENCODE_MIN;
            const total = frameCount * bins;

            for (let i = 0; i < total; i++) {
                let t = (raw[i] - ENCODE_MIN) / span;
                if (t < 0.0) t = 0.0;
                if (t > 1.0) t = 1.0;
                const value = Math.round(t * 65535.0);
                encoded[i * 2] = value >> 8;
                encoded[i * 2 + 1] = value & 255;
            }
            return encoded;
        }

        async render(options) {
            const {
                plan, sampleRate, duration, width, height,
                freqMin, freqMax, freqScale, dbMin, dbMax,
                colormap, frameProvider, onProgress
            } = options;

            const gl = this.gl;
            const u = this.uniforms;

            this.setColormap(colormap);

            const output = document.createElement('canvas');
            output.width = width;
            output.height = height;
            const ctx = output.getContext('2d');

            // Limiti conservativi per compatibilità
            const MAX_TILE_WIDTH = 2048;
            const MAX_TILE_HEIGHT = 2048;
            const memoryBudgetBytes = 16 * 1024 * 1024;
            
            const framesByMemory = Math.floor(memoryBudgetBytes / (plan.bins * 4));
            const effectiveRate = width / duration;
            const pixelsPerFrame = plan.hop / sampleRate * effectiveRate;
            
            const framesByPixels = Math.max(
                1, Math.floor(MAX_TILE_WIDTH / Math.max(pixelsPerFrame, 1e-9))
            );

            const framesPerTile = Math.max(1, Math.min(
                plan.numFrames,
                Math.max(1, framesByMemory),
                framesByPixels
            ));

            const maxTileHeight = Math.max(
                1, Math.min(height, MAX_TILE_HEIGHT)
            );

            const frameTiles = Math.ceil(plan.numFrames / framesPerTile);
            const rowTiles = Math.ceil(height / maxTileHeight);
            const totalSteps = frameTiles * rowTiles;
            let completed = 0;

            gl.useProgram(this.program);
            gl.bindVertexArray(this.vao);
            gl.disable(gl.DEPTH_TEST);
            gl.disable(gl.BLEND);

            for (let ft = 0; ft < frameTiles; ft++) {
                const start = ft * framesPerTile;
                const count = Math.min(framesPerTile, plan.numFrames - start);

                const rawStart = Math.max(0, start - 1);
                const rawEnd = Math.min(plan.numFrames, start + count + 1);
                const rawCount = rawEnd - rawStart;

                const raw = frameProvider(rawStart, rawCount);
                const encoded = this._encode(raw, rawCount, plan.bins);

                gl.activeTexture(gl.TEXTURE0);
                gl.bindTexture(gl.TEXTURE_2D, this.spectrumTexture);
                gl.texImage2D(
                    gl.TEXTURE_2D, 0, gl.RG8, rawCount, plan.bins, 0,
                    gl.RG, gl.UNSIGNED_BYTE, encoded
                );

                gl.activeTexture(gl.TEXTURE1);
                gl.bindTexture(gl.TEXTURE_2D, this.paletteTexture);

                const timeStart = (start * plan.hop) / sampleRate;
                const timeEnd = ((start + count) * plan.hop) / sampleRate;

                let x0 = Math.round((timeStart / duration) * width);
                let x1 = (ft === frameTiles - 1)
                    ? width
                    : Math.round((timeEnd / duration) * width);

                x0 = Math.max(0, Math.min(width - 1, x0));
                x1 = Math.max(x0 + 1, Math.min(width, x1));
                const tileWidth = x1 - x0;

                gl.uniform1i(u.u_spectrum, 0);
                gl.uniform1i(u.u_palette, 1);
                gl.uniform1f(u.u_encodeMin, ENCODE_MIN);
                gl.uniform1f(u.u_encodeMax, ENCODE_MAX);
                gl.uniform1f(u.u_dbMin, dbMin);
                gl.uniform1f(u.u_dbMax, dbMax);
                gl.uniform1f(u.u_freqMin, freqMin);
                gl.uniform1f(u.u_freqMax, Math.max(freqMax, freqMin + 1));
                gl.uniform1f(u.u_freqScale, freqScale);
                gl.uniform1f(u.u_sampleRate, sampleRate);
                gl.uniform1f(u.u_fftSize, plan.fftSize);
                gl.uniform1f(u.u_bins, plan.bins);
                gl.uniform1f(u.u_hop, plan.hop);
                gl.uniform1f(u.u_duration, duration);
                gl.uniform1f(u.u_totalWidth, width);
                gl.uniform1f(u.u_totalHeight, height);
                gl.uniform1f(u.u_tileOffsetX, x0);
                gl.uniform1f(u.u_frameStart, rawStart);
                gl.uniform1f(u.u_frameCount, rawCount);

                for (let vt = 0; vt < rowTiles; vt++) {
                    const rowOffset = vt * maxTileHeight;
                    const tileHeight = Math.min(maxTileHeight, height - rowOffset);

                    this._ensureTarget(tileWidth, tileHeight);
                    
                    // CORREZIONE: ri-assegna i sampler dopo _ensureTarget
                    this._bindSamplers();

                    gl.bindFramebuffer(gl.FRAMEBUFFER, this.targetFramebuffer);
                    gl.viewport(0, 0, tileWidth, tileHeight);

                    gl.uniform1f(u.u_tileOffsetY, rowOffset);
                    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

                    const pixels = new Uint8Array(tileWidth * tileHeight * 4);
                    gl.readPixels(
                        0, 0, tileWidth, tileHeight,
                        gl.RGBA, gl.UNSIGNED_BYTE, pixels
                    );

                    const image = ctx.createImageData(tileWidth, tileHeight);
                    const rowBytes = tileWidth * 4;

                    for (let y = 0; y < tileHeight; y++) {
                        const sourceRow = (tileHeight - 1 - y) * rowBytes;
                        image.data.set(
                            pixels.subarray(sourceRow, sourceRow + rowBytes),
                            y * rowBytes
                        );
                    }

                    ctx.putImageData(image, x0, height - rowOffset - tileHeight);

                    completed++;
                    if (onProgress) onProgress(completed / totalSteps);
                }

                await new Promise(resolve => setTimeout(resolve, 0));
            }

            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            gl.bindVertexArray(null);

            return output;
        }
    }

    return { Renderer, ENCODE_MIN, ENCODE_MAX };
})();