// audio-worklet-processor.js
// Must be served as a static file at /audio-worklet-processor.js (place it
// in the frontend's public/ directory) -- it's loaded via
// audioContext.audioWorklet.addModule('/audio-worklet-processor.js') and
// runs on the dedicated audio rendering thread, not the main thread.
//
// Job: take mic input at whatever native sample rate the AudioContext is
// using (commonly 48000Hz), downsample it to 16000Hz mono (what Vosk
// expects), convert float32 samples to int16, and post fixed-size chunks
// back to the main thread. Doing the downsample + int16 conversion here
// rather than on the main thread keeps postMessage traffic small (raw
// int16 bytes, not float32) and keeps the UI thread free.
//
// Also does simple energy-based voice activity detection (VAD) for
// always-listening mode: posts {type:'vad', speaking:true/false} events.
// Both directions are debounced against brief transients -- speech-start
// requires sustained energy above threshold for VAD_MIN_SPEECH_MS (so a
// cough or click doesn't trigger a full interrupt), and speech-end
// requires sustained quiet for VAD_HANGOVER_MS (so a brief pause
// mid-sentence doesn't get treated as the end of the utterance). This is
// deliberately simple -- no ML model, just an RMS energy threshold -- and
// won't distinguish real speech from any other sustained loud sound. Good
// enough as a first pass; a proper VAD model would be the upgrade path if
// false triggers turn out to still be a problem (e.g. sustained background
// noise like a fan or TV, which duration-debouncing alone won't filter).

const TARGET_SAMPLE_RATE = 16000;
const CHUNK_SIZE = 4096; // samples at TARGET_SAMPLE_RATE per message (~256ms)

const VAD_THRESHOLD = 0.015;       // RMS energy above this counts as "speech"
const VAD_MIN_SPEECH_MS = 200;     // sustained energy for this long -> speech-start (debounces brief noise blips)
const VAD_HANGOVER_MS = 700;       // sustained quiet for this long -> speech-end

class DownsamplingProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = [];
    // `sampleRate` is a global in AudioWorkletGlobalScope -- the
    // AudioContext's native rate, not TARGET_SAMPLE_RATE.
    this._resampleRatio = sampleRate / TARGET_SAMPLE_RATE;
    this._resamplePos = 0;

    this._vadEnabled = false;
    this._speaking = false;
    this._maybeSpeakingSinceMs = null; // candidate speech-start, not yet confirmed
    this._quietSinceMs = null;
    this._elapsedMs = 0;

    this.port.onmessage = (e) => {
      if (e.data && e.data.type === 'set-vad-enabled') {
        this._vadEnabled = !!e.data.enabled;
        if (!this._vadEnabled) {
          this._speaking = false;
          this._quietSinceMs = null;
        }
      }
    };
  }

  _runVad(channelData, blockMs) {
    this._elapsedMs += blockMs;
    if (!this._vadEnabled) return;

    let sumSquares = 0;
    for (let i = 0; i < channelData.length; i++) sumSquares += channelData[i] * channelData[i];
    const rms = Math.sqrt(sumSquares / channelData.length);

    if (rms >= VAD_THRESHOLD) {
      this._quietSinceMs = null;
      if (!this._speaking) {
        // Don't declare speech on a single instant above threshold -- a
        // click, cough, or chair creak crosses this just as easily as real
        // speech does. Require it to actually be sustained first, same
        // reasoning as the hangover below but on the start side instead of
        // the end side.
        if (this._maybeSpeakingSinceMs === null) this._maybeSpeakingSinceMs = this._elapsedMs;
        if (this._elapsedMs - this._maybeSpeakingSinceMs >= VAD_MIN_SPEECH_MS) {
          this._speaking = true;
          this._maybeSpeakingSinceMs = null;
          this.port.postMessage({ type: 'vad', speaking: true });
        }
      }
    } else {
      // Any dip back below threshold means whatever was building toward a
      // confirmed speech-start wasn't sustained -- reset the candidate
      // timer so a fresh run of real speech has to earn it from scratch.
      this._maybeSpeakingSinceMs = null;
      if (this._speaking) {
        if (this._quietSinceMs === null) this._quietSinceMs = this._elapsedMs;
        if (this._elapsedMs - this._quietSinceMs >= VAD_HANGOVER_MS) {
          this._speaking = false;
          this._quietSinceMs = null;
          this.port.postMessage({ type: 'vad', speaking: false });
        }
      }
    }
  }

  process(inputs) {
    const input = inputs[0];
    const channelData = input && input[0]; // mono: first channel only
    if (!channelData || channelData.length === 0) return true;

    this._runVad(channelData, (channelData.length / sampleRate) * 1000);

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