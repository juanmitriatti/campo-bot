import { logError } from './error-logger.js';

const BOT_TOKEN = () => process.env.TELEGRAM_BOT_TOKEN || '';
const API_BASE = () => `https://api.telegram.org/bot${BOT_TOKEN()}`;

/**
 * Convert WhatsApp-style formatting to Telegram Markdown.
 * WhatsApp: *bold*, _italic_, ~strikethrough~, ```code```
 * Telegram MarkdownV2 is tricky, so we use plain Markdown parse_mode.
 */
export function formatMarkdown(text: string): string {
  // WhatsApp uses *bold* — Telegram Markdown also uses *bold*, so it works directly.
  // WhatsApp uses _italic_ — Telegram Markdown also uses _italic_.
  // WhatsApp uses ~strike~ — Telegram doesn't support strike in basic Markdown, strip the tildes.
  return text.replace(/~([^~]+)~/g, '$1');
}

export async function sendTelegramMessage(chatId: string | number, text: string): Promise<void> {
  try {
    const response = await fetch(`${API_BASE()}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: formatMarkdown(text),
        parse_mode: 'Markdown',
      }),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Telegram sendMessage failed: ${response.status} ${body}`);
    }
  } catch (err: any) {
    logError('telegram', 'SEND_MESSAGE_ERROR', err, {
      context: { action: 'sendTelegramMessage', chatId },
    });
    throw err;
  }
}

export async function sendTelegramButtons(
  chatId: string | number,
  body: string,
  buttons: Array<{ id: string; title: string }>,
): Promise<void> {
  try {
    // One button per row
    const inline_keyboard = buttons.map(b => [{ text: b.title, callback_data: b.id }]);
    const response = await fetch(`${API_BASE()}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: formatMarkdown(body),
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard },
      }),
    });
    if (!response.ok) {
      const respBody = await response.text();
      throw new Error(`Telegram sendButtons failed: ${response.status} ${respBody}`);
    }
  } catch (err: any) {
    logError('telegram', 'SEND_BUTTONS_ERROR', err, {
      context: { action: 'sendTelegramButtons', chatId },
    });
    throw err;
  }
}

export async function sendTelegramList(
  chatId: string | number,
  body: string,
  sections: Array<{ title: string; rows: Array<{ id: string; title: string; description?: string }> }>,
): Promise<void> {
  try {
    // Convert WhatsApp list sections to inline keyboard grid (2 per row)
    const inline_keyboard: Array<Array<{ text: string; callback_data: string }>> = [];
    for (const section of sections) {
      // Add section title as a disabled-looking button (callback_data = noop)
      if (section.title) {
        inline_keyboard.push([{ text: `── ${section.title} ──`, callback_data: 'noop' }]);
      }
      // Rows in pairs of 2
      for (let i = 0; i < section.rows.length; i += 2) {
        const row: Array<{ text: string; callback_data: string }> = [];
        row.push({ text: section.rows[i].title, callback_data: section.rows[i].id });
        if (i + 1 < section.rows.length) {
          row.push({ text: section.rows[i + 1].title, callback_data: section.rows[i + 1].id });
        }
        inline_keyboard.push(row);
      }
    }
    const response = await fetch(`${API_BASE()}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: formatMarkdown(body),
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard },
      }),
    });
    if (!response.ok) {
      const respBody = await response.text();
      throw new Error(`Telegram sendList failed: ${response.status} ${respBody}`);
    }
  } catch (err: any) {
    logError('telegram', 'SEND_LIST_ERROR', err, {
      context: { action: 'sendTelegramList', chatId },
    });
    throw err;
  }
}

export async function sendTelegramDocument(
  chatId: string | number,
  buffer: Buffer,
  filename: string,
  caption?: string,
): Promise<void> {
  try {
    const formData = new FormData();
    formData.append('chat_id', String(chatId));
    formData.append('document', new Blob([buffer]), filename);
    if (caption) formData.append('caption', formatMarkdown(caption));
    if (caption) formData.append('parse_mode', 'Markdown');

    const response = await fetch(`${API_BASE()}/sendDocument`, {
      method: 'POST',
      body: formData,
    });
    if (!response.ok) {
      const respBody = await response.text();
      throw new Error(`Telegram sendDocument failed: ${response.status} ${respBody}`);
    }
  } catch (err: any) {
    logError('telegram', 'SEND_DOCUMENT_ERROR', err, {
      context: { action: 'sendTelegramDocument', chatId, filename },
    });
    throw err;
  }
}

export async function answerCallbackQuery(callbackQueryId: string): Promise<void> {
  try {
    await fetch(`${API_BASE()}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callbackQueryId }),
    });
  } catch {
    // Non-critical, best-effort
  }
}

export async function sendTelegramMessageWithRetry(
  chatId: string | number,
  text: string,
  maxRetries = 3,
): Promise<{ success: boolean; attempts: number; error?: string }> {
  const delays = [1000, 5000, 15000];
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      await sendTelegramMessage(chatId, text);
      return { success: true, attempts: attempt + 1 };
    } catch (err: any) {
      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, delays[attempt]));
      } else {
        return { success: false, attempts: attempt + 1, error: err.message };
      }
    }
  }
  return { success: false, attempts: maxRetries + 1 };
}

/** Download a file from Telegram servers by file_id. Returns Buffer. */
export async function downloadTelegramFile(fileId: string): Promise<Buffer> {
  // Step 1: getFile to get the file_path
  const fileResp = await fetch(`${API_BASE()}/getFile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file_id: fileId }),
  });
  if (!fileResp.ok) {
    throw new Error(`Telegram getFile failed: ${fileResp.status}`);
  }
  const fileData = await fileResp.json() as any;
  const filePath = fileData.result?.file_path;
  if (!filePath) throw new Error('No file_path in Telegram response');

  // Step 2: download the file
  const downloadUrl = `https://api.telegram.org/file/bot${BOT_TOKEN()}/${filePath}`;
  const dlResp = await fetch(downloadUrl);
  if (!dlResp.ok) {
    throw new Error(`Telegram file download failed: ${dlResp.status}`);
  }
  const arrayBuffer = await dlResp.arrayBuffer();
  return Buffer.from(arrayBuffer);
}
