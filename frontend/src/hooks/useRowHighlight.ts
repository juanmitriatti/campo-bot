import { useEffect, useState } from 'react';

/**
 * Coordinates row-scrolling + a brief highlight pulse when the user clicks
 * an item in the dashboard "Actividad reciente" feed. Tables pass the
 * incoming highlightId; this hook returns:
 *   - active: the id whose row should currently show the highlight class
 *   - rowRef: a ref-setter to register each row's DOM node
 *
 * On every new highlightId, the matching row scrolls into view and the
 * highlight persists for ~2s before fading.
 */
export function useRowHighlight(highlightId: number | undefined) {
  const [active, setActive] = useState<number | undefined>(highlightId);
  const [nodes] = useState<Map<number, HTMLElement>>(() => new Map());

  useEffect(() => {
    if (highlightId == null) return;
    setActive(highlightId);
    // Wait one tick so newly-rendered rows have time to register
    const tScroll = setTimeout(() => {
      const node = nodes.get(highlightId);
      if (node) node.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 80);
    const tFade = setTimeout(() => setActive(undefined), 2400);
    return () => { clearTimeout(tScroll); clearTimeout(tFade); };
  }, [highlightId, nodes]);

  const rowRef = (id: number) => (el: HTMLElement | null) => {
    if (el) nodes.set(id, el);
    else nodes.delete(id);
  };

  return { active, rowRef };
}
