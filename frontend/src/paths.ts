// Fuente ÚNICA de las URLs de las páginas de cuenta (en español). Los paths
// viejos en inglés (/login, /register…) los redirige el servidor con 301
// (`LEGACY_AUTH_REDIRECTS` en src/app.ts): siguen vivos en mails ya enviados,
// links de invitación y la landing. Los endpoints de la API NO cambian.
export const PATHS = {
  login: '/ingresar',
  register: '/crear-cuenta',
  forgotPassword: '/recuperar-contrasena',
  resetPassword: '/nueva-contrasena',
  verifyEmail: '/verificar-email',
} as const;
