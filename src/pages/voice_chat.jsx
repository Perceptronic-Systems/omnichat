import { useState, useEffect, useCallback, useRef } from 'react';
import { useVoiceInput } from '../voice.jsx';
import { generateResponse } from '../api.jsx';


function useAudioQueue() {
  const audioCtxRef = useRef(null);
  const queueRef = useRef([]);       // pending base64 WAV strings
  const playingRef = useRef(false);

  const getCtx = () => {
    if (!audioCtxRef.current) audioCtxRef.current = new AudioContext();
    return audioCtxRef.current;
  };

  const playNext = useCallback(async () => {
    if (playingRef.current) return;
    const next = queueRef.current.shift();
    if (!next) return;
    playingRef.current = true;

    const ctx = getCtx();
    console.log('AudioContext state:', ctx.state);
    const bytes = Uint8Array.from(atob(next), c => c.charCodeAt(0));
    try {
      const audioBuffer = await ctx.decodeAudioData(bytes.buffer);
      
      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(ctx.destination);
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

  return { enqueue };
}

export default function VoiceChat({ apiBase, SESSION_ID, setMessages, setToolCalls }) {
  const { enqueue } = useAudioQueue();
  const { voiceState, partialText, error, startRecording, stopRecording } = useVoiceInput({
    apiBase,
    onFinalTranscript: async (text) => {
      console.log('User said:', text);
      for await (const { token, status, audio } of generateResponse(
        text, SESSION_ID, [], apiBase, [], null, true
      )) {
        if (token) {
          console.log('bot: ', token)
        }
        if (audio) {
          enqueue(audio);
          console.log('audio');
        }
      }
    }
  });

  const handleAction = () => {
    if (voiceState === 'recording')
    {
      stopRecording();
    } else {
      startRecording();
    }
  }

  return (
    <div className='column' style={{width: '100%', height: '100%'}}>
      <div className='section' style={{display: 'flex', flexGrow: '1'}}>
        <p>Hello World</p>
      </div>
      <div className='section' style={{width: '100%', margin: 0}}>
        <button onClick={handleAction}>
          {voiceState === 'recording' ? 'Stop' : 'Talk'}
          {error && <p style={{color: 'red'}}>{error}</p>}
        </button>
      </div>
    </div>
  );
}