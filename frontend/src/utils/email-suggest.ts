// "¿Quisiste decir juan@gmail.com?" — detecta errores de tipeo en el DOMINIO
// del email al registrarse. `type="email"` solo valida el formato: juan@gmial.com
// pasa, la verificación sale a un dominio que no es del usuario y la cuenta
// queda sin recuperación posible. Es una sugerencia, nunca bloquea: un dominio
// propio parecido a uno conocido sigue siendo válido.

// Dominios reales: si el usuario escribió uno de estos, no se sugiere nada.
const KNOWN_DOMAINS = [
  'gmail.com', 'googlemail.com',
  'hotmail.com', 'hotmail.com.ar', 'outlook.com', 'outlook.com.ar',
  'live.com', 'live.com.ar', 'msn.com',
  'yahoo.com', 'yahoo.com.ar', 'icloud.com', 'me.com',
  'fibertel.com.ar', 'speedy.com.ar', 'arnet.com.ar',
];

// Candidatos a sugerir: los cortos (me.com, msn.com) quedan afuera porque a
// 1-2 letras de distancia hay demasiados dominios reales distintos.
const SUGGESTABLE = KNOWN_DOMAINS.filter(d => d.length >= 8);

// Errores frecuentes que la distancia no alcanza o resolvería mal.
const EXPLICIT_FIXES: Record<string, string> = {
  'gmail.com.ar': 'gmail.com',
  'gmail.ar': 'gmail.com',
  'icloud.com.ar': 'icloud.com',
};

/** Distancia de edición con transposición (gmial → gmail = 1). */
function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[a.length][b.length];
}

/**
 * Devuelve el email corregido si el dominio parece un error de tipeo de un
 * proveedor conocido, o null si no hay nada que sugerir.
 */
export function suggestEmailFix(email: string): string | null {
  const trimmed = email.trim().toLowerCase();
  const at = trimmed.lastIndexOf('@');
  if (at <= 0 || at === trimmed.length - 1) return null;
  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);
  if (KNOWN_DOMAINS.includes(domain)) return null;

  if (EXPLICIT_FIXES[domain]) return `${local}@${EXPLICIT_FIXES[domain]}`;

  let best: string | null = null;
  let bestDist = Infinity;
  let tie = false;
  for (const candidate of SUGGESTABLE) {
    const dist = editDistance(domain, candidate);
    if (dist < bestDist) { best = candidate; bestDist = dist; tie = false; }
    else if (dist === bestDist) tie = true;
  }
  // Hasta 2 ediciones, y nunca ante un empate (no adivinamos entre dos).
  if (!best || bestDist > 2 || tie) return null;
  return `${local}@${best}`;
}
