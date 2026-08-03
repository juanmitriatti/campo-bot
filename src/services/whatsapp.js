import axios from "axios";
import dotenv from "dotenv";
import { logError } from "./error-logger.js";

dotenv.config();

function formatArgNumber(phone) {
  if (!phone) return phone;
  // WhatsApp envía 5492364469135 pero para responder necesita 54236154469135
  if (phone.startsWith("549")) {
    const local = phone.slice(3); // quita "549"
    return "54" + local.slice(0, 3) + "15" + local.slice(3);
  }
  return phone;
}

const API_BASE = `https://graph.facebook.com/v22.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}`;
const authHeaders = {
  Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
  "Content-Type": "application/json"
};

// ── Circuit breaker por token inválido ─────────────────────────────────────
// Cuando el token de Cloud API vence, CADA envío da 401 y cada AxiosError
// crudo dumpeaba ~200 líneas al log. Un weekly summary sobre N usuarios
// inundó Railway (rate limit: ~30k líneas descartadas) y nos dejó ciegos
// justo durante un debugging en vivo (Jul 2026). Tras 3 auth-fails seguidos
// el breaker se abre 15 min: los envíos fallan al instante con UNA línea,
// sin pegarle a Meta. Se cierra solo al vencer el cooldown (y el próximo
// éxito resetea el contador). Renovar el token: Meta Business → WhatsApp.
const AUTH_FAILS_TO_OPEN = 3;
const BREAKER_COOLDOWN_MS = 15 * 60 * 1000;
let consecutiveAuthFails = 0;
let breakerOpenUntil = 0;

function whatsappBreakerCheck() {
  if (Date.now() < breakerOpenUntil) {
    throw new Error('WhatsApp deshabilitado temporalmente: token inválido (circuit breaker abierto, renovar WHATSAPP_TOKEN en Meta)');
  }
}

function whatsappTrackResult(err) {
  const status = err?.response?.status;
  if (status === 401 || status === 403) {
    consecutiveAuthFails++;
    if (consecutiveAuthFails >= AUTH_FAILS_TO_OPEN && Date.now() >= breakerOpenUntil) {
      breakerOpenUntil = Date.now() + BREAKER_COOLDOWN_MS;
      console.error(`[whatsapp] TOKEN INVÁLIDO (${consecutiveAuthFails} auth-fails seguidos) — breaker ABIERTO 15 min. Renovar WHATSAPP_TOKEN en Meta Business Manager.`);
    }
  } else {
    consecutiveAuthFails = 0;
  }
}

/** Error compacto: una línea con status + detalle de Meta, sin el dump axios. */
function compactWhatsappError(err, action) {
  const status = err?.response?.status ?? 'network';
  const metaMsg = err?.response?.data?.error?.message ?? err?.message ?? 'unknown';
  return new Error(`WhatsApp ${action} failed: ${status} — ${String(metaMsg).slice(0, 200)}`);
}

export async function sendMessage(to, text) {
  to = formatArgNumber(to);
  whatsappBreakerCheck();
  try {
    await axios.post(
      `${API_BASE}/messages`,
      {
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body: text }
      },
      { headers: authHeaders }
    );
    consecutiveAuthFails = 0;
  } catch (err) {
    whatsappTrackResult(err);
    const compact = compactWhatsappError(err, 'sendMessage');
    logError('whatsapp', 'SEND_MESSAGE_ERROR', compact, {
      phone: to,
      context: { action: 'sendMessage', status: err.response?.status },
    });
    throw compact;
  }
}

export async function uploadMedia(buffer, filename, mimeType) {
  try {
    const formData = new FormData();
    formData.append("messaging_product", "whatsapp");
    formData.append("file", new Blob([buffer], { type: mimeType }), filename);
    formData.append("type", mimeType);

    const response = await axios.post(
      `${API_BASE}/media`,
      formData,
      {
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`
        }
      }
    );
    return response.data.id;
  } catch (err) {
    logError('whatsapp', 'UPLOAD_MEDIA_ERROR', err, {
      context: { action: 'uploadMedia', filename, mimeType, status: err.response?.status },
    });
    throw err;
  }
}

export async function downloadMedia(mediaId) {
  try {
    const meta = await axios.get(
      `https://graph.facebook.com/v22.0/${mediaId}`,
      { headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` } }
    );
    const response = await axios.get(meta.data.url, {
      headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` },
      responseType: 'arraybuffer',
    });
    return Buffer.from(response.data);
  } catch (err) {
    logError('whatsapp', 'DOWNLOAD_MEDIA_ERROR', err, {
      context: { action: 'downloadMedia', mediaId, status: err.response?.status },
    });
    throw err;
  }
}

export async function sendInteractiveButtons(to, body, buttons) {
  to = formatArgNumber(to);
  try {
    const renderable = buttons.filter((b) => {
      if (b.webAppUrl) {
        console.log('[FORM] skip web_app button (whatsapp v1):', b.title);
        return false;
      }
      return true;
    });
    await axios.post(
      `${API_BASE}/messages`,
      {
        messaging_product: "whatsapp",
        to,
        type: "interactive",
        interactive: {
          type: "button",
          body: { text: body },
          action: {
            buttons: renderable.map(b => ({
              type: "reply",
              reply: { id: b.id, title: b.title }
            }))
          }
        }
      },
      { headers: authHeaders }
    );
  } catch (err) {
    logError('whatsapp', 'SEND_INTERACTIVE_BUTTONS_ERROR', err, {
      phone: to,
      context: { action: 'sendInteractiveButtons', status: err.response?.status },
    });
    throw err;
  }
}

export async function sendInteractiveList(to, body, buttonText, sections) {
  to = formatArgNumber(to);
  // La Cloud API rechaza listas con más de 10 filas TOTALES (el request entero
  // falla y el usuario no ve NADA). Truncar con log en vez de fallar mudo —
  // el menú principal viajó meses con 12 filas sin que nadie lo viera en WA.
  let totalRows = 0;
  const capped = [];
  for (const s of sections) {
    const remaining = 10 - totalRows;
    if (remaining <= 0) break;
    const rows = s.rows.slice(0, remaining);
    totalRows += rows.length;
    capped.push({ ...s, rows });
  }
  const originalTotal = sections.reduce((n, s) => n + s.rows.length, 0);
  if (originalTotal > 10) {
    console.warn(`[INTERCEPT] WA list truncada: ${originalTotal} filas → 10 (body="${String(body).slice(0, 40)}")`);
  }
  sections = capped;
  try {
    await axios.post(
      `${API_BASE}/messages`,
      {
        messaging_product: "whatsapp",
        to,
        type: "interactive",
        interactive: {
          type: "list",
          body: { text: body },
          action: {
            button: buttonText,
            sections: sections.map(s => ({
              title: s.title,
              rows: s.rows.map(r => ({
                id: r.id,
                title: r.title,
                ...(r.description ? { description: r.description } : {})
              }))
            }))
          }
        }
      },
      { headers: authHeaders }
    );
  } catch (err) {
    logError('whatsapp', 'SEND_INTERACTIVE_LIST_ERROR', err, {
      phone: to,
      context: { action: 'sendInteractiveList', status: err.response?.status },
    });
    throw err;
  }
}

export async function sendMessageWithRetry(to, text, maxRetries = 3) {
  const delays = [1000, 5000, 15000];
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      await sendMessage(to, text);
      return { success: true, attempts: attempt + 1 };
    } catch (err) {
      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, delays[attempt]));
      } else {
        return { success: false, attempts: attempt + 1, error: err.message };
      }
    }
  }
}

export async function sendDocument(to, mediaId, filename, caption) {
  to = formatArgNumber(to);
  try {
    await axios.post(
      `${API_BASE}/messages`,
      {
        messaging_product: "whatsapp",
        to,
        type: "document",
        document: {
          id: mediaId,
          filename,
          caption
        }
      },
      { headers: authHeaders }
    );
  } catch (err) {
    logError('whatsapp', 'SEND_DOCUMENT_ERROR', err, {
      phone: to,
      context: { action: 'sendDocument', filename, status: err.response?.status },
    });
    throw err;
  }
}
