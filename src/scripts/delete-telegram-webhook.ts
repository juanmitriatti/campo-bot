#!/usr/bin/env npx tsx
/**
 * Delete Telegram webhook.
 * Usage: TELEGRAM_BOT_TOKEN=xxx npx tsx src/scripts/delete-telegram-webhook.ts
 */
import dotenv from 'dotenv';
dotenv.config();

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('Error: TELEGRAM_BOT_TOKEN env var is required');
  process.exit(1);
}

async function main() {
  const resp = await fetch(`https://api.telegram.org/bot${token}/deleteWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });

  const data = await resp.json();
  console.log('deleteWebhook response:', JSON.stringify(data, null, 2));

  if (!(data as any).ok) {
    process.exit(1);
  }
  console.log('Webhook deleted');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
