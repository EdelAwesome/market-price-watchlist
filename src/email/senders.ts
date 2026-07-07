import { env } from '../config/env.js';
import type { AlertEmail, EmailSender } from '../alerts/outbox.js';

function renderText(e: AlertEmail): string {
  const dir = e.direction === 'ABOVE' ? 'rose above' : 'fell below';
  return [
    `Price alert: ${e.symbol} ${dir} ${e.threshold}.`,
    `Current price: ${e.price}`,
    `Triggered at: ${e.triggeredAt.toISOString()}`,
  ].join('\n');
}

function renderHtml(e: AlertEmail): string {
  const dir = e.direction === 'ABOVE' ? 'rose above' : 'fell below';
  return `<h2>Price alert: ${e.symbol}</h2>
<p><strong>${e.symbol}</strong> ${dir} <strong>${e.threshold}</strong>.</p>
<ul><li>Current price: ${e.price}</li><li>Triggered at: ${e.triggeredAt.toISOString()}</li></ul>`;
}

/**
 * Real transactional provider. The `Idempotency-Key` header (= trigger dedupe_key) makes duplicate
 * sends no-ops for 24h (Resend's retention window) — so a retry within 24h can't double-deliver.
 * Residual risk: a retry landing >24h after the provider accepted the first send. See README.
 */
export class ResendSender implements EmailSender {
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
  ) {}

  async send(email: AlertEmail, idempotencyKey: string): Promise<{ id: string }> {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify({
        from: this.from,
        to: email.to,
        subject: `Price alert: ${email.symbol} ${email.direction === 'ABOVE' ? 'above' : 'below'} ${email.threshold}`,
        text: renderText(email),
        html: renderHtml(email),
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`resend send failed: ${res.status} ${body.slice(0, 200)}`);
    }
    const data = (await res.json()) as { id?: string };
    return { id: data.id ?? idempotencyKey };
  }
}

/** Fallback when RESEND_API_KEY is unset: logs the email instead of sending. Lets the worker boot. */
export class LoggingSender implements EmailSender {
  async send(email: AlertEmail, idempotencyKey: string): Promise<{ id: string }> {
    console.log(`[email:log] -> ${email.to} | ${email.symbol} ${email.direction} ${email.threshold} @ ${email.price} (key=${idempotencyKey})`);
    return { id: `log_${idempotencyKey}` };
  }
}

export function makeEmailSender(): EmailSender {
  if (env.RESEND_API_KEY) return new ResendSender(env.RESEND_API_KEY, env.ALERT_FROM_EMAIL);
  console.warn('[email] RESEND_API_KEY unset — using LoggingSender (emails are logged, not sent)');
  return new LoggingSender();
}
