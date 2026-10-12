/*
 * High-Res Spectrogram Generator
 * Copyright (C) 2026
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 */

/** UI wiring, parameter state, analysis cache and export. */
(() => {
    'use strict';

    const $ = (selector) => document.querySelector(selector);
    const $$ = (selector) => Array.from(document.querySelectorAll(selector));

    const MAX_DIMENSION = 32767;
    const MAX_PIXELS = 100 * 1000 * 1000;
    const CACHE_BUDGET_FLOATS = 12 * 1024 * 1024; // ~48 MB

    const state = {
        fftSize: 1024,
        window: 'hann',
        overlap: 75,
        freqScale: 1.0,
        freqMin: 20,
        freqMax: 20000,
        dbMin: -100,
        dbMax: 0,
        colormap: 'inferno',
        sizeMode: 'rate',
        rate: 150,
        heightRate: 1080,
        heightOnly: 1080,
        aspect: 1.777,
        widthCustom: 1920,
        heightCustom: 1080
    };

    let audio = null;
    let renderer = null;
    let resultCanvas = null;
    let generating = false;

    // Bounded FIFO cache of analysis tiles. Changing only the colormap,
    // the dB window or the frequency axis reuses these tiles entirely.
    const cache = new Map();
    let cacheFloats = 0;

    function clearCache() {
        cache.clear();
        cacheFloats = 0;
    }

    function getCachedFrames(analysis, start, count) {
        const key = start + ':' + count;
        if (cache.has(key)) return cache.get(key);

        const data = AudioProcessor.computeRange(
            audio.mono, analysis.plan, analysis.window, analysis.fft, start, count
        );

        cache.set(key, data);
        cacheFloats += data.length;

        while (cacheFloats > CACHE_BUDGET_FLOATS && cache.size > 1) {
            const oldest = cache.keys().next().value;
            cacheFloats -= cache.get(oldest).length;
            cache.delete(oldest);
        }

        return data;
    }

    function setStatus(message, isError = false) {
        const box = $('#status');
        box.textContent = message;
        box.style.color = isError ? '#ff7b72' : '#aaa';
    }

    // -------------------------------------------------------------------------
    // Waveform
    // -------------------------------------------------------------------------

    function drawWaveform() {
        const canvas = $('#waveformCanvas');
        const cssWidth = Math.max(320, canvas.clientWidth);
        const cssHeight = 120;
        const dpr = window.devicePixelRatio || 1;

        canvas.width = Math.round(cssWidth * dpr);
        canvas.height = Math.round(cssHeight * dpr);

        const ctx = canvas.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        ctx.fillStyle = '#141414';
        ctx.fillRect(0, 0, cssWidth, cssHeight);

        ctx.strokeStyle = '#2c2c2c';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, cssHeight / 2);
        ctx.lineTo(cssWidth, cssHeight / 2);
        ctx.stroke();

        if (!audio) return;

        const mono = audio.mono;
        let peak = 0;
        for (let i = 0; i < mono.length; i++) {
            const value = Math.abs(mono[i]);
            if (value > peak) peak = value;
        }
        if (peak < 1e-9) peak = 1;

        const amplitude = (cssHeight / 2 - 5) / peak;
        const gradient = ctx.createLinearGradient(0, 0, 0, cssHeight);
        gradient.addColorStop(0, '#7cc4ff');
        gradient.addColorStop(0.5, '#4a9eff');
        gradient.addColorStop(1, '#7cc4ff');

        ctx.strokeStyle = gradient;
        ctx.lineWidth = 1;
        ctx.beginPath();

        for (let x = 0; x < cssWidth; x++) {
            const start = Math.floor(x / cssWidth * mono.length);
            const end = Math.min(mono.length, Math.floor((x + 1) / cssWidth * mono.length));

            let minimum = 0;
            let maximum = 0;
            for (let i = start; i < end; i++) {
                if (mono[i] < minimum) minimum = mono[i];
                if (mono[i] > maximum) maximum = mono[i];
            }

            const yTop = cssHeight / 2 - maximum * amplitude;
            const yBottom = cssHeight / 2 - minimum * amplitude;

            ctx.moveTo(x + 0.5, yTop);
            ctx.lineTo(x + 0.5, Math.max(yTop + 0.5, yBottom));
        }

        ctx.stroke();
    }

    // -------------------------------------------------------------------------
    // Output sizing
    // -------------------------------------------------------------------------

    function computeOutputSize() {
        if (!audio) return null;

        let width;
        let height;

        switch (state.sizeMode) {
            case 'height':
                height = Math.round(Number(state.heightOnly));
                width = Math.round(height * Number(state.aspect));
                break;

            case 'custom':
                width = Math.round(Number(state.widthCustom));
                height = Math.round(Number(state.heightCustom));
                break;

            case 'rate':
            default:
                height = Math.round(Number(state.heightRate));
                width = Math.round(audio.duration * Number(state.rate));
                break;
        }

        return {
            width: Math.max(1, width || 1),
            height: Math.max(1, height || 1)
        };
    }

    function validateSize(size) {
        if (!size) return 'Load an audio file first.';
        if (size.width > MAX_DIMENSION || size.height > MAX_DIMENSION) {
            return `Width and height must be at most ${MAX_DIMENSION} px.`;
        }
        if (size.width * size.height > MAX_PIXELS) {
            return 'This image exceeds the 100-megapixel safety limit. ' +
                   'Reduce the height or the rate.';
        }
        return null;
    }

    function updateSizePreview() {
        const size = computeOutputSize();
        const box = $('#outputSize');

        if (!size) {
            box.textContent = 'Load an audio file to calculate dimensions.';
            return;
        }

        const error = validateSize(size);
        box.textContent = error
            ? error
            : `Final dimensions: ${size.width.toLocaleString()} × ` +
              `${size.height.toLocaleString()} px ` +
              `(${(size.width * size.height / 1e6).toFixed(1)} MP)`;

        box.style.color = error ? '#ff7b72' : '#aaa';
    }

    function updateSizeModeVisibility() {
        $('#rateControls').classList.toggle('hidden', state.sizeMode !== 'rate');
        $('#heightControls').classList.toggle('hidden', state.sizeMode !== 'height');
        $('#customControls').classList.toggle('hidden', state.sizeMode !== 'custom');
        updateSizePreview();
    }

    // -------------------------------------------------------------------------
    // Generation
    // -------------------------------------------------------------------------

    async function generate() {
        if (generating) return;

        if (!audio) {
            setStatus('Please load an audio file first.', true);
            return;
        }

        const size = computeOutputSize();
        const sizeError = validateSize(size);
        if (sizeError) {
            setStatus(sizeError, true);
            return;
        }

        if (state.freqMax <= state.freqMin) {
            setStatus('Max Hz must be greater than Min Hz.', true);
            return;
        }

        if (state.dbMax <= state.dbMin) {
            setStatus('Max dB must be greater than Min dB.', true);
            return;
        }

        generating = true;
        $('#generateBtn').disabled = true;
        $('#downloadBtn').disabled = true;

        try {
            if (!renderer) renderer = new WebGLRenderer.Renderer();

            const plan = AudioProcessor.createPlan(
                audio.sampleRate, audio.mono.length, state.fftSize, state.overlap
            );

            const analysis = {
                plan,
                window: AudioProcessor.createWindow(state.window, state.fftSize),
                fft: new AudioProcessor.FFT(state.fftSize)
            };

            setStatus(
                `Analyzing ${plan.numFrames.toLocaleString()} frames ` +
                `(${state.fftSize} pt, ${state.overlap}% overlap)...`
            );

            // Give the status text a chance to paint before heavy work.
            await new Promise(resolve => setTimeout(resolve, 30));

            const canvas = await renderer.render({
                plan,
                sampleRate: audio.sampleRate,
                duration: audio.duration,
                width: size.width,
                height: size.height,
                freqMin: state.freqMin,
                freqMax: state.freqMax,
                freqScale: state.freqScale,
                dbMin: state.dbMin,
                dbMax: state.dbMax,
                colormap: state.colormap,
                frameProvider: (start, count) => getCachedFrames(analysis, start, count),
                onProgress: (fraction) => {
                    setStatus(
                        `Rendering... ${Math.round(fraction * 100)}% ` +
                        `(${size.width.toLocaleString()} × ${size.height.toLocaleString()} px)`
                    );
                }
            });

            resultCanvas = canvas;

            const wrapper = $('.canvas-wrapper');
            wrapper.innerHTML = '';
            canvas.classList.add('spectrogram-output');
            wrapper.appendChild(canvas);

            $('#downloadBtn').disabled = false;
            setStatus(
                `Done. ${size.width.toLocaleString()} × ${size.height.toLocaleString()} px. ` +
                'Ready to download.'
            );
        } catch (error) {
            console.error(error);
            setStatus(error.message || String(error), true);
        } finally {
            generating = false;
            $('#generateBtn').disabled = false;
        }
    }

    // -------------------------------------------------------------------------
    // Export
    // -------------------------------------------------------------------------

    function download() {
        if (!resultCanvas) return;

        setStatus('Encoding PNG... this can take a moment at high resolution.');

        resultCanvas.toBlob((blob) => {
            if (!blob) {
                setStatus('PNG encoding failed. Try a smaller resolution.', true);
                return;
            }

            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            const base = (audio && audio.name ? audio.name : 'audio')
                .replace(/\.[^.]+$/, '')
                .replace(/[^a-z0-9_-]/gi, '_');

            link.href = url;
            link.download =
                `${base}_${resultCanvas.width}x${resultCanvas.height}_` +
                `fft${state.fftSize}_${state.colormap}.png`;

            document.body.appendChild(link);
            link.click();
            link.remove();

            setTimeout(() => URL.revokeObjectURL(url), 30000);
            setStatus(`PNG saved (${(blob.size / 1024 / 1024).toFixed(1)} MB).`);
        }, 'image/png');
    }

    // -------------------------------------------------------------------------
    // UI helpers
    // -------------------------------------------------------------------------

    function wireButtonGroup(selector, key, onChange) {
        const group = $(selector);
        group.addEventListener('click', (event) => {
            const button = event.target.closest('button[data-value]');
            if (!button) return;

            for (const sibling of group.querySelectorAll('button')) {
                sibling.classList.toggle('active', sibling === button);
            }

            const raw = button.dataset.value;
            state[key] = /^\d+$/.test(raw) ? Number(raw) : raw;

            if (onChange) onChange();
        });
    }

    function wireSlider(selector, labelSelector, key, transform, onChange) {
        const input = $(selector);
        const label = $(labelSelector);

        const apply = () => {
            const raw = Number(input.value);
            state[key] = transform ? transform(raw) : raw;
            label.textContent = String(state[key]);
            if (onChange) onChange();
        };

        input.addEventListener('input', apply);
        apply();
    }

    function wireNumber(selector, key, onChange) {
        const input = $(selector);
        const apply = () => {
            const value = Number(input.value);
            state[key] = Number.isFinite(value) ? value : 0;
            if (onChange) onChange();
        };
        input.addEventListener('input', apply);
        input.addEventListener('change', apply);
    }

    // -------------------------------------------------------------------------
    // Initialization
    // -------------------------------------------------------------------------

    function init() {
        wireButtonGroup('#fftSizeGroup', 'fftSize', clearCache);
        wireButtonGroup('#windowGroup', 'window', clearCache);
        wireButtonGroup('#colormapGroup', 'colormap');

        wireSlider('#overlap', '#overlapValue', 'overlap', null, clearCache);

        wireSlider('#freqScale', '#scaleValue', 'freqScale', (v) => v / 100);

        wireSlider('#rate', '#rateValue', 'rate', null, updateSizePreview);

        wireNumber('#freqMin', 'freqMin');
        wireNumber('#freqMax', 'freqMax');
        wireNumber('#dbMin', 'dbMin');
        wireNumber('#dbMax', 'dbMax');

        wireNumber('#heightRate', 'heightRate', updateSizePreview);
        wireNumber('#heightOnly', 'heightOnly', updateSizePreview);
        wireNumber('#widthCustom', 'widthCustom', updateSizePreview);
        wireNumber('#heightCustom', 'heightCustom', updateSizePreview);

        $('#aspectRatio').addEventListener('change', (event) => {
            state.aspect = Number(event.target.value);
            updateSizePreview();
        });

        $$('input[name="sizeMode"]').forEach((radio) => {
            radio.addEventListener('change', () => {
                state.sizeMode = radio.value;
                updateSizeModeVisibility();
            });
        });

        $$('.preset-buttons button').forEach((button) => {
            button.addEventListener('click', () => {
                const [width, height] = button.dataset.preset.split(',').map(Number);
                state.widthCustom = width;
                state.heightCustom = height;
                state.sizeMode = 'custom';

                $('#widthCustom').value = width;
                $('#heightCustom').value = height;
                $$('input[name="sizeMode"]').forEach((radio) => {
                    radio.checked = radio.value === 'custom';
                });

                updateSizeModeVisibility();
            });
        });

        $('#audioFile').addEventListener('change', async (event) => {
            const file = event.target.files[0];
            if (!file) return;

            setStatus('Decoding audio...');
            $('#generateBtn').disabled = true;

            try {
                audio = await AudioProcessor.decodeFile(file);
                clearCache();
                resultCanvas = null;
                $('#downloadBtn').disabled = true;
                $('.canvas-wrapper').innerHTML = '';

                drawWaveform();

                $('#audioInfo').textContent =
                    `${file.name} · ${audio.duration.toFixed(2)} s · ` +
                    `${audio.sampleRate.toLocaleString()} Hz · ` +
                    `${audio.channels} channel(s) → mono`;

                setStatus('Audio loaded. Adjust the parameters and generate.');
                updateSizePreview();
                $('#generateBtn').disabled = false;
            } catch (error) {
                audio = null;
                clearCache();
                drawWaveform();
                setStatus(error.message, true);
            }
        });

        $('#generateBtn').addEventListener('click', generate);
        $('#downloadBtn').addEventListener('click', download);

        window.addEventListener('resize', () => {
            if (audio) drawWaveform();
        });

        updateSizeModeVisibility();
        drawWaveform();
        setStatus('Load an audio file to begin.');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();