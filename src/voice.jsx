import { useCallback, useEffect, useRef, useState } from 'react';

// ─── Voice input hook ──────────────────────────────────────────────────────────
//
// Manages: mic permission, AudioContext + AudioWorklet capture/downsampling,
// and the WebSocket connection to the backend's live-transcription endpoint.
//
// Two modes, selected via the `alwaysListening` option:
//
//   PUSH-TO-TALK (alwaysListening: false, the default -- unchanged from
//   before): startRecording() opens mic+socket, stopRecording() finalizes
//   the current utterance and tears everything down. One utterance per
//   startRecording()/stopRecording() cycle.
//
//   ALWAYS-LISTENING (alwaysListening: true): startRecording() opens mic+
//   socket ONCE and keeps both alive indefinitely. Utterance boundaries are
//   decided automatically by VAD (voice activity detection) running inside
//   the AudioWorklet, not by the caller -- speech-end sends the same 'stop'
//   signal push-to-talk sends manually, the backend resets its recognizer
//   and keeps the same connection open, and the client keeps listening for
//   the next utterance without reconnecting. stopRecording() in this mode
//   means "stop listening entirely" (tears down mic+socket), not "end this
//   utterance."
//
// Message envelope over the socket (JSON text frames from the server):
//   { type: 'partial', text }  -- live, not-yet-final transcript
//   { type: 'final',   text }  -- finalized transcript for this utterance
//   { type: 'error',   message }
//
// Binary frames from the server are reserved for a future speech-to-speech
// mode (server -> client synthesized audio to play back). They're routed to
// onAudioChunk if provided, and simply ignored otherwise.
//
// Binary frames TO the server are raw PCM16 mono 16kHz audio chunks, produced
// by audio-worklet-processor.js. That same worklet also posts VAD events
// (JSON, not binary) when alwaysListening is on.

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

export function useVoiceInput({ apiBase, onFinalTranscript, onAudioChunk, onSpeechStart, alwaysListening = false }) {
  // idle | requesting-permission | listening | recording | transcribing | error
  //   listening: (always-listening mode only) mic open, VAD watching, user not currently talking
  //   recording: actively capturing an utterance (push-to-talk while held, or always-listening while VAD sees speech)
  const [voiceState, setVoiceState] = useState('idle');
  const [partialText, setPartialText] = useState('');
  const [error, setError] = useState(null);

  const wsRef = useRef(null);
  const audioContextRef = useRef(null);
  const streamRef = useRef(null);
  const workletNodeRef = useRef(null);
  const sourceNodeRef = useRef(null);

  // Mode is captured per active session via a ref (not just the closure
  // argument) so callbacks created once by useCallback still see the
  // current value rather than whatever it was on first render.
  const alwaysListeningRef = useRef(alwaysListening);
  alwaysListeningRef.current = alwaysListening;

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
        if (alwaysListeningRef.current) {
          // Backend already reset its recognizer for the next utterance on
          // this same connection -- stay connected, go back to "watching."
          setVoiceState('listening');
        } else {
          setVoiceState('idle');
          closeSocket();
        }
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
          // PCM chunks arrive as transferred ArrayBuffers; VAD events arrive
          // as plain JSON objects -- these never collide since one is binary
          // and the other isn't.
          if (e.data instanceof ArrayBuffer) {
            if (ws.readyState === WebSocket.OPEN) ws.send(e.data);
            return;
          }
          if (e.data?.type === 'vad') {
            if (e.data.speaking) {
              setVoiceState('recording');
              onSpeechStart?.();
            } else {
              // Sustained quiet after speech -- automatically end this
              // utterance. The socket stays open; the backend will reset
              // its recognizer and keep listening for the next one.
              setVoiceState('transcribing');
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'stop' }));
              }
            }
          }
        };

        if (alwaysListeningRef.current) {
          workletNode.port.postMessage({ type: 'set-vad-enabled', enabled: true });
          setVoiceState('listening');
        } else {
          setVoiceState('recording');
        }
      };

      ws.onmessage = handleServerMessage;

      ws.onerror = () => {
        setError('Connection to the transcription server failed.');
        setVoiceState('error');
        teardownAudio();
      };

      ws.onclose = () => {
        // If the socket drops unexpectedly (not via our own stopRecording
        // flow, which already moved state elsewhere), don't leave the UI
        // stuck showing an active-sounding state.
        setVoiceState(prev => (prev === 'recording' || prev === 'listening' ? 'idle' : prev));
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
  }, [apiBase, handleServerMessage, teardownAudio, closeSocket, onSpeechStart]);

  const stopRecording = useCallback(() => {
    if (alwaysListeningRef.current) {
      // "Stop" in always-listening mode means exit the mode entirely, not
      // end the current utterance (VAD handles that automatically).
      teardownAudio();
      closeSocket();
      setVoiceState('idle');
      return;
    }

    // Push-to-talk: stop capturing immediately (mic indicator turns off
    // right away), but keep the socket open briefly so the server can send
    // back the final transcript for whatever audio it already received.
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
  // unmounts while active (e.g. user navigates away).
  useEffect(() => {
    return () => {
      teardownAudio();
      closeSocket();
    };
  }, [teardownAudio, closeSocket]);

  return {
    voiceState,
    partialText,       // live partial transcript for the CURRENT utterance, '' otherwise
    error,
    startRecording,
    stopRecording,
    supported: !!navigator.mediaDevices?.getUserMedia,
  };
}