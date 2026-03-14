import axios from "axios";
import dotenv from "dotenv";
import { logError } from "./error-logger.js";

dotenv.config();

function formatArgNumber(phone) {
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

export async function sendMessage(to, text) {
  to = formatArgNumber(to);
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
  } catch (err) {
    logError('whatsapp', 'SEND_MESSAGE_ERROR', err, {
      phone: to,
      context: { action: 'sendMessage', status: err.response?.status },
    });
    throw err;
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
            buttons: buttons.map(b => ({
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
