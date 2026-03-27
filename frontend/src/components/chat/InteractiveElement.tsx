interface InteractiveButton {
  id: string;
  title: string;
}

interface InteractiveListRow {
  id: string;
  title: string;
  description?: string;
}

interface InteractiveListSection {
  title: string;
  rows: InteractiveListRow[];
}

interface InteractiveData {
  type: 'buttons' | 'list';
  body: string;
  buttons?: InteractiveButton[];
  buttonText?: string;
  sections?: InteractiveListSection[];
}

interface Props {
  interactive: InteractiveData;
  onClick: (callbackId: string, label: string) => void;
  hideBody?: boolean;
}

function formatBody(text: string): string {
  return text
    .replace(/\*(.+?)\*/g, '<strong>$1</strong>')
    .replace(/_(.+?)_/g, '<em>$1</em>')
    .replace(/\n/g, '<br/>');
}

export default function InteractiveElement({ interactive, onClick, hideBody }: Props) {
  if (interactive.type === 'buttons') {
    return (
      <div className="bg-white border border-gray-200 rounded-2xl rounded-bl-md shadow-sm overflow-hidden">
        {!hideBody && (
          <div
            className="px-4 py-2 text-sm text-gray-800"
            dangerouslySetInnerHTML={{ __html: formatBody(interactive.body) }}
          />
        )}
        <div className={hideBody ? '' : 'border-t border-gray-100'}>
          {interactive.buttons?.map((btn) => (
            <button
              key={btn.id}
              onClick={() => onClick(btn.id, btn.title)}
              className="w-full text-left px-4 py-2.5 text-sm font-medium text-campo-700 hover:bg-campo-50 transition-colors border-b border-gray-50 last:border-b-0"
            >
              {btn.title}
            </button>
          ))}
        </div>
      </div>
    );
  }

  if (interactive.type === 'list') {
    return (
      <div className="bg-white border border-gray-200 rounded-2xl rounded-bl-md shadow-sm overflow-hidden">
        {!hideBody && (
          <div
            className="px-4 py-2 text-sm text-gray-800"
            dangerouslySetInnerHTML={{ __html: formatBody(interactive.body) }}
          />
        )}
        <div className={hideBody ? '' : 'border-t border-gray-100'}>
          {interactive.sections?.map((section, si) => (
            <div key={si}>
              <div className="px-4 py-1.5 text-xs font-semibold text-gray-500 uppercase tracking-wide bg-gray-50">
                {section.title}
              </div>
              {section.rows.map((row) => (
                <button
                  key={row.id}
                  onClick={() => onClick(row.id, row.title)}
                  className="w-full text-left px-4 py-2.5 hover:bg-campo-50 transition-colors border-b border-gray-50 last:border-b-0"
                >
                  <span className="text-sm font-medium text-campo-700">{row.title}</span>
                  {row.description && (
                    <span className="block text-xs text-gray-500 mt-0.5">{row.description}</span>
                  )}
                </button>
              ))}
            </div>
          ))}
        </div>
      </div>
    );
  }

  return null;
}
