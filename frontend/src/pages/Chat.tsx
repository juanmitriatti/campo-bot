import { useState, useRef, useEffect, useCallback } from 'react';
import Navbar from '../components/Navbar';
import ChatBubble from '../components/chat/ChatBubble';
import ChatInput from '../components/chat/ChatInput';
import TypingIndicator from '../components/chat/TypingIndicator';
import { useAudioRecorder } from '../hooks/useAudioRecorder';
import { fetchApi, apiUpload } from '../api/client';
import type { ChatMessage, BotResponseItem } from '../types/chat';

let msgIdCounter = 0;
function nextId(): string {
  return `msg_${++msgIdCounter}_${Date.now()}`;
}

export default function Chat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const {
    audioState, audioBlob, audioUrl, duration,
    startRecording, stopRecording, discardRecording, error: audioError,
  } = useAudioRecorder();

  // Auto-scroll on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  const addBotMessages = useCallback((items: BotResponseItem[]) => {
    if (items.length === 0) return;
    setMessages(prev => [...prev, {
      id: nextId(),
      role: 'bot',
      items,
      timestamp: new Date(),
    }]);
  }, []);

  const handleSendText = useCallback(async (text: string) => {
    // Add user message
    setMessages(prev => [...prev, {
      id: nextId(),
      role: 'user',
      text,
      timestamp: new Date(),
    }]);

    setLoading(true);
    try {
      const data = await fetchApi<{ messages: BotResponseItem[] }>('/api/test-bot', {
        method: 'POST',
        body: { message: text },
      });
      addBotMessages(data.messages);
    } catch (err) {
      addBotMessages([{ type: 'text', text: 'Error de conexion. Intenta de nuevo.' }]);
    } finally {
      setLoading(false);
    }
  }, [addBotMessages]);

  const handleSendAudio = useCallback(async () => {
    if (!audioBlob) return;

    // Add user audio message
    setMessages(prev => [...prev, {
      id: nextId(),
      role: 'user',
      audioUrl: audioUrl || undefined,
      timestamp: new Date(),
    }]);
    discardRecording();

    setLoading(true);
    try {
      const formData = new FormData();
      formData.append('audio', audioBlob, 'audio.webm');

      const data = await apiUpload<{ transcript: string; messages: BotResponseItem[] }>(
        '/api/test-bot/audio',
        formData,
      );

      // Update last user message with transcript
      if (data.transcript) {
        setMessages(prev => {
          const copy = [...prev];
          // Find last user message
          for (let i = copy.length - 1; i >= 0; i--) {
            if (copy[i].role === 'user' && copy[i].audioUrl) {
              copy[i] = { ...copy[i], transcript: data.transcript };
              break;
            }
          }
          return copy;
        });
      }

      addBotMessages(data.messages);
    } catch (err) {
      addBotMessages([{ type: 'text', text: 'No pude procesar el audio. Intenta de nuevo.' }]);
    } finally {
      setLoading(false);
    }
  }, [audioBlob, audioUrl, discardRecording, addBotMessages]);

  const handleInteractiveClick = useCallback(async (callbackId: string, label: string) => {
    // Show button label (not internal callback ID)
    setMessages(prev => [...prev, {
      id: nextId(),
      role: 'user',
      text: label,
      timestamp: new Date(),
    }]);

    setLoading(true);
    try {
      const data = await fetchApi<{ messages: BotResponseItem[] }>('/api/test-bot', {
        method: 'POST',
        body: { interactiveReplyId: callbackId },
      });
      addBotMessages(data.messages);
    } catch (err) {
      addBotMessages([{ type: 'text', text: 'Error de conexion. Intenta de nuevo.' }]);
    } finally {
      setLoading(false);
    }
  }, [addBotMessages]);

  return (
    <div className="flex flex-col h-screen bg-gray-100">
      <Navbar />

      {/* Chat header */}
      <div className="bg-campo-700 text-white px-4 py-2 shadow-sm">
        <div className="max-w-2xl mx-auto flex items-center gap-3">
          <div className="w-8 h-8 rounded-full bg-campo-500 flex items-center justify-center text-sm font-bold">
            CB
          </div>
          <div>
            <p className="text-sm font-semibold">Campo Bot</p>
            <p className="text-xs text-campo-200">Chat de prueba</p>
          </div>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-2xl mx-auto px-4 py-4">
          {messages.length === 0 && (
            <div className="text-center text-gray-400 mt-20">
              <p className="text-lg mb-2">Chat de prueba</p>
              <p className="text-sm">Escribi un mensaje para interactuar con el bot.</p>
              <p className="text-sm">Probá: "hola", "menu", "gaste 50mil en gasoil"</p>
            </div>
          )}
          {messages.map(msg => (
            <ChatBubble
              key={msg.id}
              message={msg}
              onInteractiveClick={handleInteractiveClick}
            />
          ))}
          {loading && <TypingIndicator />}
          <div ref={bottomRef} />
        </div>
      </div>

      {/* Input */}
      <div className="max-w-2xl mx-auto w-full">
        <ChatInput
          onSendText={handleSendText}
          onSendAudio={handleSendAudio}
          disabled={loading}
          audioState={audioState}
          audioUrl={audioUrl}
          duration={duration}
          onStartRecording={startRecording}
          onStopRecording={stopRecording}
          onDiscardRecording={discardRecording}
          audioError={audioError}
        />
      </div>
    </div>
  );
}
