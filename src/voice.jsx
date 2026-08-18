import { useCallback, useEffect, useRef, useState } from 'react';

// ─── Voice input hook ──────────────────────────────────────────────────────────
//
// Manages: mic permission, AudioContext + AudioWorklet capture/downsampling,
// and the WebSocket connection to the backend's live-transcription endpoint.
//
// Message envelope over the socket (JSON text frames from the server):
//   { type: 'partial', text }   -- live, not-yet-final transcript
//   { type: 'final',   text }  -- finalized transcript for this utterance
//   { type: 'error',   message }
//
// Binary frames from the server are reserved for a future speech-to-speech
// mode (server -> client synthesized audio to play back). They're routed to
// onAudioChunk if provided, and simply ignored otherwise -- adding real TTS
// playback later shouldn't require touching the message dispatch below.
//
// Binary frames TO the server are raw PCM16 mono 16kHz audio chunks, produced
// by audio-worklet-processor.js.

function toWsUrl(apiBase) {
  if (!apiBase || apiBase === 'browser') return null;
  // Deliberately built from the origin only, NOT from apiBase's full path.
  // apiBase typically points at an /api/ prefix (e.g. behind a reverse
  // proxy that rewrites /api/* -> the backend root), but the transcription
  // WebSocket is expected to live at root-level /ws/transcribe -- both on
  // the FastAPI app itself (which registers the route with no prefix) and,
  // in production, behind a *separate* nginx location block dedicated to
  // WebSocket upgrades (distinct from the HTTP-only /api/ block, which may
  // strip headers a WebSocket handshake needs). Reusing apiBase's path
  // verbatim would send the handshake into the wrong nginx location.
  try {
    const url = new URL(apiBase);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.pathname = '/ws/transcribe';
    url.search = '';
    return url.toString();
  } catch {
    return null;
  }
}

export function useVoiceInput({ apiBase, onFinalTranscript, onAudioChunk }) {
  const [voiceState, setVoiceState] = useState('idle'); // idle | requesting-permission | recording | transcribing | error
  const [partialText, setPartialText] = useState('');
  const [error, setError] = useState(null);

  const wsRef = useRef(null);
  const audioContextRef = useRef(null);
  const streamRef = useRef(null);
  const workletNodeRef = useRef(null);
  const sourceNodeRef = useRef(null);

  const teardownAudio = useCallback(() => {
    workletNodeRef.current?.port.close();
    workletNodeRef.current?.disconnect();
    workletNodeRef.current = null;

    sourceNodeRef.current?.disconnect();
    sourceNodeRef.current = null;

    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;

    if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
      audioContextRef.current.close();
    }
    audioContextRef.current = null;
  }, []);

  const closeSocket = useCallback(() => {
    if (wsRef.current && wsRef.current.readyState <= WebSocket.OPEN) {
      wsRef.current.close();
    }
    wsRef.current = null;
  }, []);

  const handleServerMessage = useCallback((event) => {
    if (typeof event.data !== 'string') {
      // Binary frame -- reserved for future TTS audio playback.
      onAudioChunk?.(event.data);
      return;
    }
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return; // malformed frame; ignore
    }
    switch (msg.type) {
      case 'partial':
        setPartialText(msg.text || '');
        break;
      case 'final':
        setPartialText('');
        setVoiceState('idle');
        closeSocket();
        if (msg.text && msg.text.trim()) {
          onFinalTranscript?.(msg.text.trim());
        }
        break;
      case 'error':
        setError(msg.message || 'Transcription error');
        setVoiceState('error');
        teardownAudio();
        closeSocket();
        break;
      default:
        break;
    }
  }, [onAudioChunk, onFinalTranscript, closeSocket, teardownAudio]);

  const startRecording = useCallback(async () => {
    setError(null);

    const wsUrl = toWsUrl(apiBase);
    if (!wsUrl) {
      setError('Voice input requires a server connection (not available in local browser mode).');
      setVoiceState('error');
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setError('Microphone access is not supported in this browser.');
      setVoiceState('error');
      return;
    }

    setVoiceState('requesting-permission');

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }
      });
      streamRef.current = stream;

      const audioContext = new AudioContext();
      audioContextRef.current = audioContext;
      try {
        await audioContext.audioWorklet.addModule('audio-worklet-processor.js');
      } catch (workletErr) {
        // Chrome collapses almost any addModule failure (404, wrong path,
        // syntax error in the file) into a generic
        // "AbortError: The operation was aborted." -- surface something
        // actually actionable instead.
        throw new Error(
          'Failed to load audio-worklet-processor.js. Check that the file ' +
          'is served as a static asset (e.g. in your public/ folder) and ' +
          `check the Network tab for the real error. (${workletErr.name}: ${workletErr.message})`
        );
      }

      const source = audioContext.createMediaStreamSource(stream);
      sourceNodeRef.current = source;

      const workletNode = new AudioWorkletNode(audioContext, 'downsampling-processor');
      workletNodeRef.current = workletNode;

      const ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;

      ws.onopen = () => {
        source.connect(workletNode);
        // Intentionally not connecting workletNode -> audioContext.destination;
        // we don't want to play the mic input back out loud.
        workletNode.port.onmessage = (e) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(e.data);
        };
        setVoiceState('recording');
      };

      ws.onmessage = handleServerMessage;

      ws.onerror = () => {
        setError('Connection to the transcription server failed.');
        setVoiceState('error');
        teardownAudio();
      };

      ws.onclose = () => {
        // If the socket drops unexpectedly mid-recording (not via our own
        // stopRecording flow, which already moved state to 'transcribing'),
        // don't leave the UI stuck.
        setVoiceState(prev => (prev === 'recording' ? 'idle' : prev));
        teardownAudio();
      };
    } catch (err) {
      setError(err.name === 'NotAllowedError'
        ? 'Microphone permission was denied.'
        : `Could not start recording: ${err.message}`);
      setVoiceState('error');
      teardownAudio();
      closeSocket();
    }
  }, [apiBase, handleServerMessage, teardownAudio, closeSocket]);

  const stopRecording = useCallback(() => {
    // Stop capturing immediately (mic indicator turns off right away), but
    // keep the socket open briefly so the server can send back the final
    // transcript for whatever audio it already received.
    teardownAudio();
    setVoiceState('transcribing');

    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'stop' }));
    } else {
      setVoiceState('idle');
      closeSocket();
    }
  }, [teardownAudio, closeSocket]);

  // Safety net: never leave mic/socket resources open if the component
  // unmounts mid-recording (e.g. user navigates away).
  useEffect(() => {
    return () => {
      teardownAudio();
      closeSocket();
    };
  }, [teardownAudio, closeSocket]);

  return {
    voiceState,       // 'idle' | 'requesting-permission' | 'recording' | 'transcribing' | 'error'
    partialText,       // live partial transcript while recording, '' otherwise
    error,
    startRecording,
    stopRecording,
    supported: !!navigator.mediaDevices?.getUserMedia,
  };
}