import React, { useEffect, useRef, useState } from 'react';
import { Mic } from 'lucide-react';
import { api, UserStt } from '../../lib/api';

interface ComposerMicProps {
  onTranscript: (text: string) => void;
  round?: boolean;
}

type MicPhase = 'idle' | 'recording' | 'transcribing';

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const s = String(reader.result || '');
      const comma = s.indexOf(',');
      resolve(comma >= 0 ? s.slice(comma + 1) : s);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function audioFormat(blob: Blob): string {
  const raw = (blob.type.split(';')[0] || 'audio/webm').split('/')[1] || 'webm';
  if (raw === 'mpeg') return 'mp3';
  if (raw === 'x-wav' || raw === 'wave') return 'wav';
  return raw.replace(/[^a-z0-9]/gi, '') || 'webm';
}

export const ComposerMic: React.FC<ComposerMicProps> = ({ onTranscript, round }) => {
  const [stt, setStt] = useState<UserStt | null>(null);
  const [phase, setPhase] = useState<MicPhase>('idle');
  const [levels, setLevels] = useState<number[]>([0.15, 0.2, 0.35, 0.2, 0.15]);
  const [error, setError] = useState('');
  const recRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const audioRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number>(0);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    try {
      void api.getStt()
        .then(setStt)
        .catch(() => setStt({ configured: false, base_url: null, model: null }));
    } catch {
      setStt({ configured: false, base_url: null, model: null });
    }
    return () => {
      aliveRef.current = false;
      stopHardware();
    };
  }, []);

  const configured = Boolean(stt?.configured);

  const stopHardware = () => {
    cancelAnimationFrame(rafRef.current);
    recRef.current?.state === 'recording' && recRef.current.stop();
    recRef.current = null;
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    audioRef.current?.close().catch(() => {});
    audioRef.current = null;
  };

  const startMeter = (stream: MediaStream) => {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    audioRef.current = ctx;
    const src = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 32;
    src.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    const tick = () => {
      analyser.getByteFrequencyData(data);
      const slice = [2, 4, 6, 8, 10].map(i => Math.min(1, (data[i] || 0) / 180));
      setLevels(slice.map(v => 0.12 + v * 0.88));
      rafRef.current = requestAnimationFrame(tick);
    };
    tick();
  };

  const finish = async (blob: Blob) => {
    setPhase('transcribing');
    try {
      const audio = await blobToBase64(blob);
      const res = await api.transcribeAudio(audio, audioFormat(blob));
      const text = (res.text || '').trim();
      if (!aliveRef.current) return;
      if (text) onTranscript(text);
      else setError('No speech detected.');
    } catch (err: unknown) {
      if (aliveRef.current) setError(err instanceof Error ? err.message : 'Transcription failed.');
    } finally {
      if (aliveRef.current) {
        setPhase('idle');
        setLevels([0.15, 0.2, 0.35, 0.2, 0.15]);
      }
    }
  };

  const startRecording = async () => {
    setError('');
    if (!navigator.mediaDevices?.getUserMedia) {
      setError('Microphone is not available in this browser.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const rec = new MediaRecorder(stream);
      chunksRef.current = [];
      rec.ondataavailable = e => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      rec.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: rec.mimeType || 'audio/webm' });
        stopHardware();
        void finish(blob);
      };
      recRef.current = rec;
      rec.start();
      startMeter(stream);
      setPhase('recording');
    } catch {
      setError('Microphone permission was denied.');
    }
  };

  const toggle = () => {
    if (!configured || phase === 'transcribing') return;
    if (phase === 'recording') {
      recRef.current?.stop();
      return;
    }
    void startRecording();
  };

  const btn = round
    ? 'w-8 h-8 rounded-full'
    : 'p-2.5 rounded-md';

  return (
    <div className="relative group/mic shrink-0">
      <button
        type="button"
        onClick={toggle}
        disabled={!configured || phase === 'transcribing'}
        aria-label={phase === 'recording' ? 'Stop recording' : 'Speak'}
        aria-disabled={!configured}
        title={configured ? (phase === 'recording' ? 'Stop recording' : 'Speak') : 'Configure speech in Settings'}
        className={`mic-btn relative ${btn} flex items-center justify-center transition ${
          phase === 'recording'
            ? 'mic-recording bg-feedback-error-bg text-feedback-error-text'
            : phase === 'transcribing'
              ? 'mic-transcribing bg-surface-subtle text-txt-secondary'
              : configured
                ? 'bg-surface-subtle text-txt-secondary hover:text-txt-primary hover:bg-surface-mid'
                : 'bg-surface-subtle text-txt-tertiary opacity-50 cursor-not-allowed'
        }`}
      >
        {phase === 'recording' ? (
          <span className="mic-bars" aria-hidden>
            {levels.map((h, i) => (
              <span key={i} style={{ height: `${Math.round(h * 14)}px` }} />
            ))}
          </span>
        ) : (
          <Mic className="w-3.5 h-3.5" />
        )}
      </button>
      {!configured && (
        <div
          role="tooltip"
          className="pointer-events-none absolute bottom-[calc(100%+8px)] left-1/2 -translate-x-1/2 w-64 rounded-lg border border-border-mid bg-surface-canvas px-3 py-2 text-[11px] leading-relaxed text-txt-secondary shadow-xl opacity-0 translate-y-1 group-hover/mic:opacity-100 group-hover/mic:translate-y-0 group-focus-within/mic:opacity-100 group-focus-within/mic:translate-y-0 transition z-50"
        >
          <p className="text-txt-primary font-medium mb-1">Speech is not configured</p>
          <p>
            Add an OpenAI-compatible transcriptions endpoint in{' '}
            <a href="/settings" className="pointer-events-auto text-brand hover:underline">Settings → Speech</a>
            . OpenRouter guide:{' '}
            <a
              href="https://openrouter.ai/docs/guides/overview/multimodal/stt"
              target="_blank"
              rel="noreferrer"
              className="pointer-events-auto text-brand hover:underline"
            >
              STT docs
            </a>
            .
          </p>
        </div>
      )}
      {error && (
        <p className="absolute bottom-[calc(100%+8px)] right-0 w-52 rounded-md border border-feedback-error-border bg-feedback-error-bg px-2 py-1 text-[10px] text-feedback-error-text shadow-lg z-50">
          {error}
        </p>
      )}
    </div>
  );
};
