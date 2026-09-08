import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * Render del markdown que devuelve el análisis (títulos, listas, tablas).
 *
 * No hay plugin typography en Tailwind, así que cada elemento lleva sus clases
 * explícitas. Las tablas van dentro de un contenedor con scroll horizontal:
 * la página nunca scrollea de costado (390 px).
 */
export default function Markdown({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        h1: ({ children }) => <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100 mt-3 mb-1.5 first:mt-0">{children}</h3>,
        h2: ({ children }) => <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100 mt-3 mb-1.5 first:mt-0">{children}</h3>,
        h3: ({ children }) => <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mt-3 mb-1 first:mt-0">{children}</h4>,
        p: ({ children }) => <p className="text-sm text-gray-800 dark:text-gray-200 leading-relaxed mb-2 last:mb-0">{children}</p>,
        ul: ({ children }) => <ul className="list-disc pl-5 mb-2 space-y-1 text-sm text-gray-800 dark:text-gray-200">{children}</ul>,
        ol: ({ children }) => <ol className="list-decimal pl-5 mb-2 space-y-1 text-sm text-gray-800 dark:text-gray-200">{children}</ol>,
        li: ({ children }) => <li className="leading-relaxed">{children}</li>,
        strong: ({ children }) => <strong className="font-semibold text-gray-900 dark:text-gray-100">{children}</strong>,
        em: ({ children }) => <em className="italic text-gray-600 dark:text-gray-400">{children}</em>,
        code: ({ children }) => <code className="font-mono text-xs bg-gray-100 dark:bg-gray-900 rounded px-1 py-0.5">{children}</code>,
        a: ({ children, href }) => <a href={href} target="_blank" rel="noreferrer" className="text-campo-700 dark:text-campo-400 underline">{children}</a>,
        hr: () => <hr className="my-3 border-gray-200 dark:border-gray-700" />,
        table: ({ children }) => (
          <div className="overflow-x-auto mb-3 -mx-1">
            <table className="min-w-full text-xs border-collapse">{children}</table>
          </div>
        ),
        thead: ({ children }) => <thead className="bg-gray-50 dark:bg-gray-900/60">{children}</thead>,
        th: ({ children }) => <th className="text-left font-semibold text-gray-700 dark:text-gray-300 px-2 py-1.5 border-b border-gray-200 dark:border-gray-700 whitespace-nowrap">{children}</th>,
        td: ({ children }) => <td className="px-2 py-1.5 border-b border-gray-100 dark:border-gray-800 text-gray-800 dark:text-gray-200 align-top">{children}</td>,
      }}
    >
      {text}
    </ReactMarkdown>
  );
}
