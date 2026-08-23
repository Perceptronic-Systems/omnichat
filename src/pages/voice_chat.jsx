import { useState, useEffect, useCallback, useRef } from 'react';
import { useVoiceInput } from '../voice.jsx';
import { generateResponse } from '../api.jsx';
import { parseMarkdown } from "../markdown.jsx";

// ─── Audio playback queue ───────────────────────────────────────────────────
//
// Plays synthesized sentence audio back-to-back as it arrives. Deliberately
// routes playback through a real <audio> element (via an Object URL) rather
// than straight to AudioContext.destination: browsers' built-in echo
// cancellation (the `echoCancellation: true` constraint used when opening
// the mic in voice.jsx) reliably references <audio>/<video> element
// playback, but Web Audio API output sent directly to
// AudioContext.destination isn't always included in that reference path.
// This is a mitigation, not a guarantee -- on some browsers/hardware the
// mic can still pick up speaker bleed. Headphones remain the fully-reliable
// fix if false interruptions from the bot's own voice turn out to be a
// problem in practice.
//
// The <audio> element's output is still routed through an AnalyserNode via
// MediaElementAudioSourceNode, so the Jarvis visualization keeps working.
function useAudioQueue() {
  const audioCtxRef = useRef(null);
  const analyserRef = useRef(null);
  const audioElRef = useRef(null);
  const sourceNodeRef = useRef(null);
  const queueRef = useRef([]);        // pending base64 WAV strings
  const currentUrlRef = useRef(null); // Object URL for whatever's playing now
  const playingRef = useRef(false);

  const getGraph = () => {
    if (!audioCtxRef.current) {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.8;

      const audioEl = new Audio();
      audioEl.autoplay = false;
      const sourceNode = ctx.createMediaElementSource(audioEl);
      sourceNode.connect(analyser);
      analyser.connect(ctx.destination);

      audioCtxRef.current = ctx;
      analyserRef.current = analyser;
      audioElRef.current = audioEl;
      sourceNodeRef.current = sourceNode;
    }
    return {
      ctx: audioCtxRef.current,
      analyser: analyserRef.current,
      audioEl: audioElRef.current,
    };
  };

  const releaseCurrentUrl = () => {
    if (currentUrlRef.current) {
      URL.revokeObjectURL(currentUrlRef.current);
      currentUrlRef.current = null;
    }
  };

  const playNext = useCallback(() => {
    if (playingRef.current) return;
    const next = queueRef.current.shift();
    if (!next) return;
    playingRef.current = true;

    const { ctx, audioEl } = getGraph();
    if (ctx.state === 'suspended') ctx.resume();

    try {
      const bytes = Uint8Array.from(atob(next), c => c.charCodeAt(0));
      const blob = new Blob([bytes], { type: 'audio/wav' });
      releaseCurrentUrl();
      const url = URL.createObjectURL(blob);
      currentUrlRef.current = url;

      audioEl.onended = () => {
        playingRef.current = false;
        playNext(); // chain to the next queued sentence
      };
      audioEl.onerror = (e) => {
        console.error('TTS playback failed:', e);
        playingRef.current = false;
        playNext();
      };
      audioEl.src = url;
      audioEl.play().catch(err => {
        console.error('audio.play() failed:', err);
        playingRef.current = false;
      });
    } catch (err) {
      console.error('Failed to queue audio chunk:', err);
      playingRef.current = false;
      playNext();
    }
  }, []);

  const enqueue = useCallback((base64Wav) => {
    queueRef.current.push(base64Wav);
    playNext();
  }, [playNext]);

  // Interruption support: stop whatever's playing right now and drop
  // everything still queued, immediately.
  const stopAll = useCallback(() => {
    queueRef.current = [];
    playingRef.current = false;
    const audioEl = audioElRef.current;
    if (audioEl) {
      audioEl.onended = null;
      audioEl.pause();
      audioEl.removeAttribute('src');
      audioEl.load();
    }
    releaseCurrentUrl();
  }, []);

  return { enqueue, stopAll, analyserRef, isPlaying: () => playingRef.current || queueRef.current.length > 0 };
}

function AudioVisualizer({ analyserRef }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    let animationFrameId;

    // Dynamically resize canvas to fill its parent element
    const handleResize = () => {
      const parent = canvas.parentElement;
      if (parent) {
        canvas.width = parent.clientWidth;
        canvas.height = parent.clientHeight;
      }
    };

    const resizeObserver = new ResizeObserver(() => handleResize());
    if (canvas.parentElement) resizeObserver.observe(canvas.parentElement);
    handleResize();

    let rotationAngle = 0;

    const render = () => {
      const width = canvas.width;
      const height = canvas.height;
      const centerX = width / 2;
      const centerY = height / 2;
      const baseRadius = Math.min(width, height) * 0.22;

      ctx.clearRect(0, 0, width, height);

      // Extract frequency data and isolate active voice frequencies (~80Hz - 4500Hz)
      let frequencyData = new Uint8Array(0);
      let audioLevel = 0;

      if (analyserRef.current) {
        const bufferLength = analyserRef.current.frequencyBinCount;
        const fullData = new Uint8Array(bufferLength);
        analyserRef.current.getByteFrequencyData(fullData);

        // Slice upper silent spectrum, keeping the lower active voice range
        const activeBinCount = Math.floor(bufferLength * 0.35); 
        frequencyData = fullData.slice(0, activeBinCount);

        const sum = frequencyData.reduce((acc, val) => acc + val, 0);
        audioLevel = sum / (frequencyData.length * 255); // Normalized 0.0 to 1.0
      }

      rotationAngle += 0.01 + audioLevel * 0.03; // Dynamic rotation based on audio volume

      // 1. Glowing Core Orb
      ctx.save();
      ctx.shadowBlur = 15 + audioLevel * 25;
      ctx.shadowColor = '#00f0ff';
      
      const gradient = ctx.createRadialGradient(centerX, centerY, 5, centerX, centerY, baseRadius);
      gradient.addColorStop(0, `rgba(0, 240, 255, ${0.8 + audioLevel * 0.2})`);
      gradient.addColorStop(0.5, `rgba(0, 150, 255, ${0.3 + audioLevel * 0.3})`);
      gradient.addColorStop(1, 'rgba(0, 20, 40, 0)');

      ctx.beginPath();
      ctx.arc(centerX, centerY, baseRadius * (0.85 + Math.sin(Date.now() * 0.003) * 0.03), 0, Math.PI * 2);
      ctx.fillStyle = gradient;
      ctx.fill();
      ctx.restore();

      // 2. Rotating Arc Rings (Jarvis HUD circles)
      const drawArcRing = (radius, speedMultiplier, arcs) => {
        ctx.save();
        ctx.translate(centerX, centerY);
        ctx.rotate(rotationAngle * speedMultiplier);
        ctx.strokeStyle = '#00f0ff';
        ctx.lineWidth = 2;
        ctx.shadowBlur = 8;
        ctx.shadowColor = '#00f0ff';

        arcs.forEach(([startAngle, length]) => {
          ctx.beginPath();
          ctx.arc(0, 0, radius, startAngle, startAngle + length);
          ctx.stroke();
        });
        ctx.restore();
      };

      drawArcRing(baseRadius * 0.6, 1, [[0, Math.PI * 0.6], [Math.PI, Math.PI * 0.5]]);
      drawArcRing(baseRadius * 0.75, -1.4, [[0.2, Math.PI * 0.3], [Math.PI * 0.8, Math.PI * 0.4], [Math.PI * 1.5, Math.PI * 0.2]]);

      // 3. Radial Equalizer Bars
      const numBars = 64;
      const equalizerRadius = baseRadius + 15;
      const maxBarHeight = baseRadius * 0.5;

      ctx.save();
      ctx.translate(centerX, centerY);
      
      for (let i = 0; i < numBars; i++) {
        const angle = (i / numBars) * Math.PI * 2;
        
        // Map bar across sliced voice data
        const dataIndex = Math.floor((i / numBars) * frequencyData.length);
        const rawAudio = frequencyData[dataIndex] || 0;
        
        const normalizedAudio = rawAudio / 255;
        // Idle ambient breathing animation when quiet
        const idleWave = (Math.sin(Date.now() * 0.004 + i * 0.2) + 1) * 0.15; 
        const barHeight = 4 + (normalizedAudio * maxBarHeight) + (idleWave * maxBarHeight * 0.3);

        const x1 = Math.cos(angle) * equalizerRadius;
        const y1 = Math.sin(angle) * equalizerRadius;
        const x2 = Math.cos(angle) * (equalizerRadius + barHeight);
        const y2 = Math.sin(angle) * (equalizerRadius + barHeight);

        ctx.strokeStyle = `rgba(0, 240, 255, ${0.4 + normalizedAudio * 0.6})`;
        ctx.lineWidth = 3;
        ctx.shadowBlur = normalizedAudio > 0.1 ? 10 : 2;
        ctx.shadowColor = '#00f0ff';

        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
      }
      ctx.restore();

      animationFrameId = requestAnimationFrame(render);
    };

    render();

    return () => {
      cancelAnimationFrame(animationFrameId);
      resizeObserver.disconnect();
    };
  }, [analyserRef]);

  return <canvas ref={canvasRef} style={{ display: 'block', width: '100%', height: '100%' }} />;
}

export default function VoiceChat({ apiBase, SESSION_ID, setMessages, setToolCalls }) {
  const { enqueue, stopAll, analyserRef, isPlaying } = useAudioQueue();
  const [alwaysListening, setAlwaysListening] = useState(false);

  // Tracks the AbortController for whatever generateResponse() call is
  // currently in flight, if any -- null when nothing's running. Used by
  // the interruption path below.
  const abortControllerRef = useRef(null);
  const respondingRef = useRef(false); // true from send until the response fully finishes

  const addMessage = useCallback((role, html, extra = {}) => {
    const id = Date.now() + Math.random();
    setMessages(prev => [...prev, { id, role, html, ...extra }]);
    return id;
  }, [setMessages]);

  const updateMessage = useCallback((id, patch) => {
    setMessages(prev => prev.map(m => m.id === id ? { ...m, ...patch } : m));
  }, [setMessages]);

  // Interruption: called the instant VAD detects the user has started
  // talking. If the bot is currently generating and/or its audio is still
  // playing, cancel both immediately. If nothing's happening, this is just
  // the normal start of the user's turn and is a no-op.
  const handleSpeechStart = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    if (isPlaying()) {
      stopAll();
    }
  }, [isPlaying, stopAll]);

  const { voiceState, partialText, error, startRecording, stopRecording } = useVoiceInput({
    apiBase,
    alwaysListening,
    onSpeechStart: handleSpeechStart,
    onFinalTranscript: async (text) => {
      addMessage('user', text);
      let generated = "";
      const botMessage = addMessage('bot', '');

      const controller = new AbortController();
      abortControllerRef.current = controller;
      respondingRef.current = true;

      try {
        for await (const { token, status, audio } of generateResponse(
          text, SESSION_ID, [], apiBase, [], null, true, controller.signal
        )) {
          if (token && status) {
            generated += token;
            updateMessage(botMessage, { html: parseMarkdown(generated), status, streaming: true });
          }
          if (audio) {
            enqueue(audio);
          }
        }
      } finally {
        updateMessage(botMessage, { streaming: false });
        respondingRef.current = false;
        if (abortControllerRef.current === controller) {
          abortControllerRef.current = null;
        }
      }
    }
  });

  const handleAction = () => {
    if (voiceState === 'idle' || voiceState === 'error') {
      startRecording();
    } else {
      stopRecording();
    }
  };

  const toggleAlwaysListening = () => {
    // Switching modes while active would leave the hook's internal mode
    // ref out of sync with an in-progress session -- stop first if needed.
    if (voiceState !== 'idle' && voiceState !== 'error') {
      stopRecording();
    }
    setAlwaysListening(v => !v);
  };

  const micLabel = {
    idle: 'Talk',
    'requesting-permission': 'Requesting mic…',
    listening: alwaysListening ? 'Listening…' : 'Talk',
    recording: 'Stop',
    transcribing: 'Transcribing…',
    error: 'Talk',
  }[voiceState] || 'Talk';

  return (
    <div className='column' style={{width: '100%', height: '100%'}}>
      <div className='section' style={{display: 'flex', flexGrow: '1', position: 'relative', overflow: 'hidden'}}>
        <AudioVisualizer analyserRef={analyserRef} />
      </div>
      <div className='section row' style={{width: '100%', margin: 0, alignItems: 'center', gap: '0.75rem'}}>
        <button onClick={handleAction} style={{backgroundColor: '#226089', color: "white", padding: '1rem'}}>
          {micLabel}
        </button>
        <label style={{display: 'flex', alignItems: 'center', gap: '0.4rem', padding: '0 0.5rem'}}>
          <input
            type="checkbox"
            checked={alwaysListening}
            onChange={toggleAlwaysListening}
            disabled={voiceState !== 'idle' && voiceState !== 'error'}
          />
          Always listening
        </label>
        {error && <p style={{color: 'red'}}>{error}</p>}
        <p style={{padding: '1rem'}}>{partialText}</p>
      </div>
    </div>
  );
}