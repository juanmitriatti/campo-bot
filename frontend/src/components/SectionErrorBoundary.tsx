import { Component, type ReactNode } from 'react';

/**
 * Boundary local por sección: un widget que crashea (ej: el mapa con un
 * polígono corrupto) degrada a un aviso chico en su lugar — NO tumba el
 * dashboard entero al boundary global "Algo se rompió" (visto en prod con
 * Leaflet, Jul 2026).
 */
export default class SectionErrorBoundary extends Component<
  { children: ReactNode; label?: string },
  { hasError: boolean }
> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: unknown) {
    console.error('[SectionErrorBoundary]', this.props.label ?? 'section', error);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 p-4 text-sm text-gray-500 dark:text-gray-400">
          ⚠️ No pudimos mostrar {this.props.label ?? 'esta sección'} — el resto del panel sigue funcionando.
        </div>
      );
    }
    return this.props.children;
  }
}
