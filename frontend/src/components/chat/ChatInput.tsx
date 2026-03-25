import { useState, useRef, useEffect } from 'react';
import type { AudioState } from '../../hooks/useAudioRecorder';

interface Props {
  onSendText: (text: string) => void;
  onSendAudio: () => void;
  disabled: boolean;
  // Audio recorder props
  audioState: AudioState;
  audioUrl: string | null;
  duration: number;
  onStartRecording: () => void;
  onStopRecording: () => void;
  onDiscardRecording: () => void;
  audioError: string | null;
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export default function ChatInput({
  onSendText,
  onSendAudio,
  disabled,
  audioState,
  audioUrl,
  duration,
  onStartRecording,
  onStopRecording,
  onDiscardRecording,
  audioError,
}: Props) {
  const [text, setText] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    if (audioState === 'idle' && !disabled) {
      inputRef.current?.focus();
    }
  }, [audioState, disabled]);

  const handleSend = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    onSendText(trimmed);
    setText('');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // --- Recording state ---
  if (audioState === 'recording') {
    return (
      <div className="flex items-center gap-3 px-4 py-3 bg-white border-t border-gray-200">
        <div className="flex-1 flex items-center gap-3">
          <span className="relative flex h-3 w-3">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-3 w-3 bg-red-500" />
          </span>
          <span className="text-sm text-gray-600">Grabando... {formatDuration(duration)}</span>
        </div>
        <button
          onClick={onStopRecording}
          className="p-2 rounded-full bg-red-500 text-white hover:bg-red-600 transition-colors"
          title="Detener"
        >
          <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
            <rect x="5" y="5" width="10" height="10" rx="1" />
          </svg>
        </button>
      </div>
    );
  }

  // --- Preview state ---
  if (audioState === 'preview' && audioUrl) {
    return (
      <div className="flex items-center gap-3 px-4 py-3 bg-white border-t border-gray-200">
        <button
          onClick={onDiscardRecording}
          className="p-2 rounded-full text-gray-500 hover:bg-gray-100 transition-colors"
          title="Descartar"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
        <audio ref={audioRef} src={audioUrl} controls className="flex-1 h-8" />
        <button
          onClick={() => onSendAudio()}
          disabled={disabled}
          className="p-2 rounded-full bg-campo-600 text-white hover:bg-campo-700 transition-colors disabled:opacity-50"
          title="Enviar audio"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5" />
          </svg>
        </button>
      </div>
    );
  }

  // --- Idle state ---
  return (
    <div className="px-4 py-3 bg-white border-t border-gray-200">
      {audioError && (
        <p className="text-xs text-red-500 mb-2">{audioError}</p>
      )}
      <div className="flex items-center gap-2">
        <input
          ref={inputRef}
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Escribi un mensaje..."
          disabled={disabled}
          className="flex-1 text-sm border border-gray-300 rounded-full px-4 py-2 focus:outline-none focus:border-campo-500 focus:ring-1 focus:ring-campo-500 disabled:bg-gray-50"
        />
        {text.trim() ? (
          <button
            onClick={handleSend}
            disabled={disabled}
            className="p-2 rounded-full bg-campo-600 text-white hover:bg-campo-700 transition-colors disabled:opacity-50"
            title="Enviar"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5" />
            </svg>
          </button>
        ) : (
          <button
            onClick={onStartRecording}
            disabled={disabled}
            className="p-2 rounded-full text-gray-500 hover:bg-gray-100 transition-colors disabled:opacity-50"
            title="Grabar audio"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5a3 3 0 116 0v8.25a3 3 0 01-3 3z" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}
