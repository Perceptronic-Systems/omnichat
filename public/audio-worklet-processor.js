// audio-worklet-processor.js
// Must be served as a static file at audio-worklet-processor.js (place it
// in the frontend's public/ directory) -- it's loaded via
// audioContext.audioWorklet.addModule('audio-worklet-processor.js') and
// runs on the dedicated audio rendering thread, not the main thread.
//
// Job: take mic input at whatever native sample rate the AudioContext is
// using (commonly 48000Hz), downsample it to 16000Hz mono (what Vosk
// expects), convert float32 samples to int16, and post fixed-size chunks
// back to the main thread. Doing the downsample + int16 conversion here
// rather than on the main thread keeps postMessage traffic small (raw
// int16 bytes, not float32) and keeps the UI thread free.

const TARGET_SAMPLE_RATE = 16000;
const CHUNK_SIZE = 4096; // samples at TARGET_SAMPLE_RATE per message (~256ms)

class DownsamplingProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = [];
    // `sampleRate` is a global in AudioWorkletGlobalScope -- the
    // AudioContext's native rate, not TARGET_SAMPLE_RATE.
    this._resampleRatio = sampleRate / TARGET_SAMPLE_RATE;
    this._resamplePos = 0;
  }

  process(inputs) {
    const input = inputs[0];
    const channelData = input && input[0]; // mono: first channel only
    if (!channelData || channelData.length === 0) return true;

    // Linear-interpolation downsample from native rate -> 16kHz.
    for (; this._resamplePos < channelData.length; this._resamplePos += this._resampleRatio) {
      const idx = Math.floor(this._resamplePos);
      const frac = this._resamplePos - idx;
      const s0 = channelData[idx] || 0;
      const s1 = channelData[idx + 1] !== undefined ? channelData[idx + 1] : s0;
      this._buffer.push(s0 + (s1 - s0) * frac);
    }
    this._resamplePos -= channelData.length;

    while (this._buffer.length >= CHUNK_SIZE) {
      const chunk = this._buffer.splice(0, CHUNK_SIZE);
      const pcm16 = new Int16Array(chunk.length);
      for (let i = 0; i < chunk.length; i++) {
        const s = Math.max(-1, Math.min(1, chunk[i]));
        pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      // Transfer the underlying buffer instead of copying it.
      this.port.postMessage(pcm16.buffer, [pcm16.buffer]);
    }
    return true;
  }
}

registerProcessor('downsampling-processor', DownsamplingProcessor);
