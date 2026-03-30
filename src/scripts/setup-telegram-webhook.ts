#!/usr/bin/env npx tsx
/**
 * Setup Telegram webhook.
 * Usage: TELEGRAM_BOT_TOKEN=xxx npx tsx src/scripts/setup-telegram-webhook.ts <URL>
 * Example: npx tsx src/scripts/setup-telegram-webhook.ts https://abc123.ngrok.io/telegram
 */
import dotenv from 'dotenv';
dotenv.config();

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('Error: TELEGRAM_BOT_TOKEN env var is required');
  process.exit(1);
}

const url = process.argv[2];
if (!url) {
  console.error('Usage: npx tsx src/scripts/setup-telegram-webhook.ts <WEBHOOK_URL>');
  process.exit(1);
}

const secret = process.env.TELEGRAM_WEBHOOK_SECRET;

async function main() {
  const body: Record<string, unknown> = {
    url,
    allowed_updates: ['message', 'callback_query'],
  };
  if (secret) {
    body.secret_token = secret;
  }

  const resp = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const data = await resp.json();
  console.log('setWebhook response:', JSON.stringify(data, null, 2));

  if (!(data as any).ok) {
    process.exit(1);
  }
  console.log(`Webhook set to: ${url}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
