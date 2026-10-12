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

/**
 * Audio decoding, window functions, radix-2 FFT and STFT.
 * No external dependencies.
 */
const AudioProcessor = (() => {
    'use strict';

    let sharedContext = null;

    function getContext() {
        if (!sharedContext) {
            const Ctor = window.AudioContext || window.webkitAudioContext;
            if (!Ctor) {
                throw new Error('Web Audio API is not supported by this browser.');
            }
            sharedContext = new Ctor();
        }
        return sharedContext;
    }

    /**
     * Decode any browser-supported audio file and downmix to mono.
     * Stereo becomes (L + R) / 2. Multi-channel becomes the channel mean.
     */
    async function decodeFile(file) {
        const arrayBuffer = await file.arrayBuffer();
        const ctx = getContext();

        let buffer;
        try {
            buffer = await ctx.decodeAudioData(arrayBuffer);
        } catch (err) {
            throw new Error(
                'Could not decode this file. Your browser may not support this ' +
                'codec. Try converting it to WAV or MP3 first.'
            );
        }

        const length = buffer.length;
        const channels = buffer.numberOfChannels;
        const sampleRate = buffer.sampleRate;
        const mono = new Float32Array(length);

        for (let c = 0; c < channels; c++) {
            const data = buffer.getChannelData(c);
            for (let i = 0; i < length; i++) {
                mono[i] += data[i] / channels;
            }
        }

        return {
            mono,
            sampleRate,
            channels,
            duration: length / sampleRate,
            name: file.name
        };
    }

    /** Modified Bessel function of the first kind, order zero. */
    function besselI0(x) {
        const halfSquared = (x * 0.5) * (x * 0.5);
        let term = 1.0;
        let sum = 1.0;
        for (let k = 1; k <= 40; k++) {
            term *= halfSquared / (k * k);
            sum += term;
            if (term < sum * 1e-14) break;
        }
        return sum;
    }

    /**
     * Build a symmetric analysis window.
     * @param {'hann'|'hamming'|'blackman'|'kaiser'|'rectangular'} type
     * @param {number} size
     */
    function createWindow(type, size) {
        const win = new Float64Array(size);
        const denom = Math.max(1, size - 1);
        const beta = 8.6;
        const i0Beta = besselI0(beta);
        const center = (size - 1) * 0.5;
        const radius = Math.max(0.5, center);

        for (let i = 0; i < size; i++) {
            const x = i / denom;
            const c1 = Math.cos(2.0 * Math.PI * x);
            const c2 = Math.cos(4.0 * Math.PI * x);

            switch (type) {
                case 'hamming':
                    win[i] = 0.54 - 0.46 * c1;
                    break;
                case 'blackman':
                    win[i] = 0.42 - 0.5 * c1 + 0.08 * c2;
                    break;
                case 'kaiser': {
                    const normalized = (i - center) / radius;
                    const inside = Math.max(0.0, 1.0 - normalized * normalized);
                    win[i] = besselI0(beta * Math.sqrt(inside)) / i0Beta;
                    break;
                }
                case 'rectangular':
                    win[i] = 1.0;
                    break;
                case 'hann':
                default:
                    win[i] = 0.5 - 0.5 * c1;
                    break;
            }
        }
        return win;
    }

    /** In-place iterative radix-2 Cooley-Tukey FFT. */
    class FFT {
        constructor(size) {
            if (size < 2 || (size & (size - 1)) !== 0) {
                throw new Error('FFT size must be a power of two.');
            }
            this.size = size;
            const bits = Math.round(Math.log2(size));

            this.reverse = new Uint32Array(size);
            for (let i = 0; i < size; i++) {
                let value = i;
                let reversed = 0;
                for (let b = 0; b < bits; b++) {
                    reversed = (reversed << 1) | (value & 1);
                    value >>= 1;
                }
                this.reverse[i] = reversed;
            }

            const half = size >> 1;
            this.cosTable = new Float64Array(half);
            this.sinTable = new Float64Array(half);
            for (let k = 0; k < half; k++) {
                const angle = -2.0 * Math.PI * k / size;
                this.cosTable[k] = Math.cos(angle);
                this.sinTable[k] = Math.sin(angle);
            }
        }

        /** Transform real/imaginary buffers in place. */
        transform(re, im) {
            const n = this.size;
            const reverse = this.reverse;

            for (let i = 0; i < n; i++) {
                const j = reverse[i];
                if (i < j) {
                    const tr = re[i]; re[i] = re[j]; re[j] = tr;
                    const ti = im[i]; im[i] = im[j]; im[j] = ti;
                }
            }

            const cosTable = this.cosTable;
            const sinTable = this.sinTable;

            for (let len = 2; len <= n; len <<= 1) {
                const half = len >> 1;
                const stride = n / len;

                for (let base = 0; base < n; base += len) {
                    for (let j = 0; j < half; j++) {
                        const tw = j * stride;
                        const wr = cosTable[tw];
                        const wi = sinTable[tw];

                        const a = base + j;
                        const b = a + half;

                        const br = re[b];
                        const bi = im[b];

                        const tr = br * wr - bi * wi;
                        const ti = br * wi + bi * wr;

                        re[b] = re[a] - tr;
                        im[b] = im[a] - ti;
                        re[a] += tr;
                        im[a] += ti;
                    }
                }
            }
        }
    }

    /**
     * Describe an STFT configuration.
     * Frame f is assigned to the time of its window START (f * hop / sampleRate).
     */
    function createPlan(sampleRate, length, fftSize, overlapPercent) {
        const hop = Math.max(1, Math.round(fftSize * (1.0 - overlapPercent / 100.0)));
        const numFrames = Math.max(1, Math.floor((length - fftSize) / hop) + 1);
        return {
            sampleRate,
            length,
            fftSize,
            hop,
            numFrames,
            bins: fftSize / 2 + 1
        };
    }

    /**
     * Compute a range of STFT frames, returned in bin-major layout:
     *   data[bin * count + localFrame] = magnitude in dB
     *
     * Bin-major layout matters: it makes each texture row contiguous in memory,
     * so uploading to WebGL needs no transpose.
     *
     * @param {Float32Array} mono
     * @param {object} plan
     * @param {Float64Array} window
     * @param {FFT} fft
     * @param {number} startFrame
     * @param {number} count
     * @returns {Float32Array}
     */
    function computeRange(mono, plan, window, fft, startFrame, count) {
        const n = plan.fftSize;
        const hop = plan.hop;
        const bins = plan.bins;
        const length = mono.length;

        let windowSum = 0.0;
        for (let i = 0; i < n; i++) windowSum += window[i];
        const gain = windowSum > 0 ? 2.0 / windowSum : 1.0;

        const out = new Float32Array(bins * count);
        const re = new Float64Array(n);
        const im = new Float64Array(n);

        for (let f = 0; f < count; f++) {
            const offset = (startFrame + f) * hop;

            re.fill(0.0);
            im.fill(0.0);

            const available = Math.min(n, Math.max(0, length - offset));
            for (let i = 0; i < available; i++) {
                re[i] = mono[offset + i] * window[i];
            }

            fft.transform(re, im);

            for (let bin = 0; bin < bins; bin++) {
                const real = re[bin];
                const imag = im[bin];
                let magnitude = Math.sqrt(real * real + imag * imag) * gain;

                // DC and Nyquist have no mirrored counterpart.
                if (bin === 0 || bin === n / 2) magnitude *= 0.5;

                const db = 20.0 * Math.log10(Math.max(magnitude, 1e-12));
                out[bin * count + f] = db;
            }
        }

        return out;
    }

    return { decodeFile, createWindow, createPlan, computeRange, FFT };
})();