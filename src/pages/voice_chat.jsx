import { useState, useEffect, useCallback, useRef } from 'react';
import { useVoiceInput } from '../voice.jsx';
import { generateResponse } from '../api.jsx';
import { parseMarkdown } from "../markdown.jsx";

function useAudioQueue() {
  const audioCtxRef = useRef(null);
  const analyserRef = useRef(null);
  const queueRef = useRef([]);       // pending base64 WAV strings
  const playingRef = useRef(false);

  const getCtx = () => {
    if (!audioCtxRef.current) {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256; // Provides 128 frequency bins
      analyser.smoothingTimeConstant = 0.8;
      
      audioCtxRef.current = ctx;
      analyserRef.current = analyser;
    }
    return { ctx: audioCtxRef.current, analyser: analyserRef.current };
  };

  const playNext = useCallback(async () => {
    if (playingRef.current) return;
    const next = queueRef.current.shift();
    if (!next) return;
    playingRef.current = true;

    const { ctx, analyser } = getCtx();
    const bytes = Uint8Array.from(atob(next), c => c.charCodeAt(0));
    try {
      const audioBuffer = await ctx.decodeAudioData(bytes.buffer);
      
      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      
      // Route audio through AnalyserNode before playing through speakers
      source.connect(analyser);
      analyser.connect(ctx.destination);

      source.onended = () => {
        playingRef.current = false;
        playNext(); // chain to the next queued sentence
      };
      source.start();
    } catch (err) {
      console.error('decodeAudioData failed:', err);
      playingRef.current = false; // don't get stuck if this sentence fails
    }
  }, []);

  const enqueue = useCallback((base64Wav) => {
    queueRef.current.push(base64Wav);
    playNext();
  }, [playNext]);

  return { enqueue, analyserRef };
}

function JarvisCanvas({ analyserRef }) {
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
  const { enqueue, analyserRef } = useAudioQueue();

  const addMessage = useCallback((role, html, extra = {}) => {
    const id = Date.now() + Math.random();
    setMessages(prev => [...prev, { id, role, html, ...extra }]);
    return id;
  }, [setMessages]);

  const updateMessage = useCallback((id, patch) => {
    setMessages(prev => prev.map(m => m.id === id ? { ...m, ...patch } : m));
  }, [setMessages]);

  const { voiceState, partialText, error, startRecording, stopRecording } = useVoiceInput({
    apiBase,
    onFinalTranscript: async (text) => {
      addMessage('user', text);
      let generated = "";
      const botMessage = addMessage('bot', '');
      for await (const { token, status, audio } of generateResponse(
        text, SESSION_ID, [], apiBase, [], null, true
      )) {
        if (token && status) {
          generated += token;
          updateMessage(botMessage, { html: parseMarkdown(generated), status, streaming: true });
        }
        if (audio) {
          console.log('audio');
          enqueue(audio);
        }
      }
      updateMessage(botMessage, { streaming: false });
    }
  });

  const handleAction = () => {
    if (voiceState === 'recording')
    {
      stopRecording();
    } else {
      startRecording();
    }
  };

  return (
    <div className='column' style={{width: '100%', height: '100%'}}>
      <div className='section' style={{display: 'flex', flexGrow: '1', position: 'relative', overflow: 'hidden'}}>
        <JarvisCanvas analyserRef={analyserRef} />
      </div>
      <div className='section row' style={{width: '100%', margin: 0}}>
        <button onClick={handleAction} style={{backgroundColor: '#226089', color: "white", padding: '1rem'}}>
          {voiceState === 'recording' ? 'Stop' : 'Talk'}
          {error && <p style={{color: 'red'}}>{error}</p>}
        </button>
        <p style={{padding: '1rem'}}>{partialText}</p>
      </div>
    </div>
  );
}