import { useState, useRef, useEffect } from 'react';
import { Send, Mic, Square, X } from 'lucide-react';
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
          <Square className="w-5 h-5" fill="currentColor" />
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
          <X className="w-5 h-5" />
        </button>
        <audio ref={audioRef} src={audioUrl} controls className="flex-1 h-8" />
        <button
          onClick={() => onSendAudio()}
          disabled={disabled}
          className="p-2 rounded-full bg-campo-600 text-white hover:bg-campo-700 transition-colors disabled:opacity-50"
          title="Enviar audio"
        >
          <Send className="w-5 h-5" />
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
            <Send className="w-5 h-5" />
          </button>
        ) : (
          <button
            onClick={onStartRecording}
            disabled={disabled}
            className="p-2 rounded-full text-gray-500 hover:bg-gray-100 transition-colors disabled:opacity-50"
            title="Grabar audio"
          >
            <Mic className="w-5 h-5" />
          </button>
        )}
      </div>
    </div>
  );
}
