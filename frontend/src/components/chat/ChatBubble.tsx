import type { ChatMessage, BotResponseItem } from '../../types/chat';
import InteractiveElement from './InteractiveElement';

interface Props {
  message: ChatMessage;
  onInteractiveClick: (callbackId: string, label: string) => void;
}

function formatText(text: string): string {
  // Convert WhatsApp-style markdown: *bold*, _italic_
  return text
    .replace(/\*(.+?)\*/g, '<strong>$1</strong>')
    .replace(/_(.+?)_/g, '<em>$1</em>')
    .replace(/\n/g, '<br/>');
}

function BotItem({ item, onInteractiveClick, hideBody }: { item: BotResponseItem; onInteractiveClick: (id: string, label: string) => void; hideBody?: boolean }) {
  if (item.type === 'text' && item.text) {
    return (
      <div
        className="text-sm text-gray-800 whitespace-pre-wrap"
        dangerouslySetInnerHTML={{ __html: formatText(item.text) }}
      />
    );
  }
  if (item.type === 'interactive' && item.interactive) {
    return <InteractiveElement interactive={item.interactive} onClick={onInteractiveClick} hideBody={hideBody} />;
  }
  return null;
}

export default function ChatBubble({ message, onInteractiveClick }: Props) {
  const isUser = message.role === 'user';
  const time = message.timestamp.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });

  if (isUser) {
    return (
      <div className="flex justify-end mb-3">
        <div className="max-w-[80%] bg-campo-600 text-white px-4 py-2 rounded-2xl rounded-br-md shadow-sm">
          {message.audioUrl && (
            <div className="mb-1">
              <audio src={message.audioUrl} controls className="max-w-full h-8" />
              {message.transcript && (
                <p className="text-xs text-campo-100 mt-1 italic">{message.transcript}</p>
              )}
            </div>
          )}
          {message.text && (
            <p className="text-sm whitespace-pre-wrap">{message.text}</p>
          )}
          <p className="text-[10px] text-campo-200 text-right mt-1">{time}</p>
        </div>
      </div>
    );
  }

  // Bot message — suppress interactive body when a text item already provides context
  const items = message.items ?? [];
  const hasTextItem = items.some(it => it.type === 'text' && it.text);

  return (
    <div className="flex justify-start mb-3">
      <div className="max-w-[85%] space-y-2">
        {items.map((item, i) => (
          <div
            key={i}
            className={
              item.type === 'text'
                ? 'bg-white border border-gray-200 px-4 py-2 rounded-2xl rounded-bl-md shadow-sm'
                : ''
            }
          >
            <BotItem
              item={item}
              onInteractiveClick={onInteractiveClick}
              hideBody={item.type === 'interactive' && hasTextItem}
            />
          </div>
        ))}
        <p className="text-[10px] text-gray-400 ml-2">{time}</p>
      </div>
    </div>
  );
}
