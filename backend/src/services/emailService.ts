import nodemailer, { type SendMailOptions, type Transporter } from 'nodemailer';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import type { ComplaintTicket } from './complaintService.js';

export interface EmailDeliveryResult {
  enabled: boolean;
  sent: boolean;
  reason?: 'disabled' | 'not_configured' | 'invalid_recipient' | 'relay_error';
}

let transporter: Transporter | null = null;

// Keep this intentionally narrower than full RFC 5322: notification targets
// come from an AD username, so normal institutional addresses are sufficient
// and characters that could be interpreted as header syntax are rejected.
const EMAIL_LOCAL_ALLOWED =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789.!#$%&'*+/=?^_{}|~-";

function cleanHeaderValue(value: string): string {
  return value.split('\r').join(' ').split('\n').join(' ').trim();
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function validEmail(value: string): string | null {
  const normalized = cleanHeaderValue(value).toLowerCase();
  if (normalized.length > 320) return null;

  const at = normalized.lastIndexOf('@');
  if (at <= 0 || at !== normalized.indexOf('@')) return null;
  const localPart = normalized.slice(0, at);
  const domain = normalized.slice(at + 1);
  if (localPart.length > 64 || !domain || !domain.includes('.')) return null;
  if ([...localPart].some((character) => !EMAIL_LOCAL_ALLOWED.includes(character))) {
    return null;
  }

  const labels = domain.split('.');
  if (labels.some((label) => {
    if (!label || label.length > 63 || label.startsWith('-') || label.endsWith('-')) {
      return true;
    }
    return [...label].some((character) => {
      const code = character.charCodeAt(0);
      return !(
        (code >= 48 && code <= 57) ||
        (code >= 97 && code <= 122) ||
        character === '-'
      );
    });
  })) {
    return null;
  }

  return normalized;
}

/**
 * AD users are currently represented by username in the application database.
 * Accept an imported username that is already an email, otherwise use the
 * configured institutional suffix (normally username@bpdp.or.id).
 */
export function notificationEmailForUsername(username: string): string | null {
  const normalized = cleanHeaderValue(username).toLowerCase();
  const candidate = normalized.includes('@')
    ? normalized
    : `${normalized}@${cleanHeaderValue(config.email.userDomain).toLowerCase()}`;
  return validEmail(candidate);
}

function getTransporter(): Transporter | null {
  if (!config.email.enabled) return null;
  if (transporter) return transporter;

  if (!config.email.smtpHost || !validEmail(config.email.from)) {
    return null;
  }

  transporter = nodemailer.createTransport({
    host: config.email.smtpHost,
    port: config.email.smtpPort,
    secure: config.email.smtpSecure,
    name: 'igo-pdf',
    requireTLS: config.email.smtpRequireTls,
    connectionTimeout: config.email.connectionTimeoutMs,
    greetingTimeout: config.email.greetingTimeoutMs,
    socketTimeout: config.email.socketTimeoutMs,
    tls: {
      rejectUnauthorized: config.email.smtpRejectUnauthorized,
    },
  });
  return transporter;
}

function disabledResult(): EmailDeliveryResult {
  return { enabled: false, sent: false, reason: 'disabled' };
}

function notConfiguredResult(): EmailDeliveryResult {
  logger.warn('Email notification skipped because SMTP is not fully configured', {
    enabled: config.email.enabled,
    hostConfigured: Boolean(config.email.smtpHost),
    senderConfigured: Boolean(validEmail(config.email.from)),
  });
  return { enabled: true, sent: false, reason: 'not_configured' };
}

async function deliver(options: SendMailOptions): Promise<EmailDeliveryResult> {
  if (!config.email.enabled) return disabledResult();
  const mailer = getTransporter();
  if (!mailer) return notConfiguredResult();

  try {
    await mailer.sendMail(options);
    return { enabled: true, sent: true };
  } catch (error) {
    // A notification failure must not roll back a ticket or a resolution that
    // has already been committed. Keep relay details in server logs only.
    logger.error('Email notification delivery failed', {
      reason: error instanceof Error ? error.message : String(error),
    });
    return { enabled: true, sent: false, reason: 'relay_error' };
  }
}

function applicationLink(pathname: string): string {
  const base = config.email.appUrl.replace(/\/$/, '');
  return base ? `${base}${pathname}` : '';
}

function sharedText(ticket: ComplaintTicket): string {
  return [
    `Nomor tiket: ${ticket.ticketNumber}`,
    `Subjek: ${ticket.subject}`,
    `Fitur: ${ticket.featureName || 'Di luar fitur'}`,
  ].join('\n');
}

function sharedHtml(ticket: ComplaintTicket): string {
  return [
    `<p><strong>Nomor tiket:</strong> ${escapeHtml(ticket.ticketNumber)}</p>`,
    `<p><strong>Subjek:</strong> ${escapeHtml(ticket.subject)}</p>`,
    `<p><strong>Fitur:</strong> ${escapeHtml(ticket.featureName || 'Di luar fitur')}</p>`,
  ].join('');
}

function messageDefaults(to: string): SendMailOptions | null {
  const from = validEmail(config.email.from);
  const recipient = notificationEmailForUsername(to);
  if (!from || !recipient) return null;

  return {
    from,
    to: recipient,
    ...(validEmail(config.email.replyTo)
      ? { replyTo: validEmail(config.email.replyTo) as string }
      : {}),
  };
}

export async function sendComplaintSubmittedEmail(
  ticket: ComplaintTicket
): Promise<EmailDeliveryResult> {
  if (!config.email.enabled) return disabledResult();
  const defaults = messageDefaults(ticket.reporterUsername);
  if (!defaults) {
    logger.warn('Complaint receipt email skipped because recipient is invalid', {
      ticketNumber: ticket.ticketNumber,
    });
    return { enabled: true, sent: false, reason: 'invalid_recipient' };
  }

  const link = applicationLink('/aduan');
  const text = [
    `Halo,`,
    '',
    'Aduan Anda sudah diterima oleh IGO PDF.',
    sharedText(ticket),
    '',
    'Simpan nomor tiket tersebut untuk referensi.',
    ...(link ? ['', `Buka IGO PDF: ${link}`] : []),
    '',
    'Email ini dikirim otomatis. Mohon tidak membalas jika tidak diperlukan.',
  ].join('\n');
  const html = [
    '<p>Halo,</p>',
    '<p>Aduan Anda sudah diterima oleh IGO PDF.</p>',
    sharedHtml(ticket),
    '<p>Simpan nomor tiket tersebut untuk referensi.</p>',
    ...(link ? [`<p><a href="${escapeHtml(link)}">Buka IGO PDF</a></p>`] : []),
    '<p>Email ini dikirim otomatis. Mohon tidak membalas jika tidak diperlukan.</p>',
  ].join('');

  return deliver({
    ...defaults,
    subject: `[IGO PDF] Aduan diterima - ${cleanHeaderValue(ticket.ticketNumber)}`,
    text,
    html,
  });
}

export async function sendComplaintResolvedEmail(
  ticket: ComplaintTicket
): Promise<EmailDeliveryResult> {
  if (!config.email.enabled) return disabledResult();
  const defaults = messageDefaults(ticket.reporterUsername);
  if (!defaults) {
    logger.warn('Complaint resolution email skipped because recipient is invalid', {
      ticketNumber: ticket.ticketNumber,
    });
    return { enabled: true, sent: false, reason: 'invalid_recipient' };
  }

  const resolution = ticket.resolutionText || '';
  const link = applicationLink('/aduan');
  const text = [
    `Halo,`,
    '',
    'Aduan Anda telah ditandai selesai oleh tim IGO PDF.',
    sharedText(ticket),
    '',
    'Catatan penyelesaian:',
    resolution,
    ...(link ? ['', `Buka IGO PDF: ${link}`] : []),
    '',
    'Email ini dikirim otomatis. Mohon tidak membalas jika tidak diperlukan.',
  ].join('\n');
  const html = [
    '<p>Halo,</p>',
    '<p>Aduan Anda telah ditandai selesai oleh tim IGO PDF.</p>',
    sharedHtml(ticket),
    '<p><strong>Catatan penyelesaian:</strong></p>',
    `<p>${escapeHtml(resolution).replaceAll('\n', '<br>')}</p>`,
    ...(link ? [`<p><a href="${escapeHtml(link)}">Buka IGO PDF</a></p>`] : []),
    '<p>Email ini dikirim otomatis. Mohon tidak membalas jika tidak diperlukan.</p>',
  ].join('');

  return deliver({
    ...defaults,
    subject: `[IGO PDF] Aduan selesai - ${cleanHeaderValue(ticket.ticketNumber)}`,
    text,
    html,
  });
}

/** Used by the deployment smoke test; it only opens the SMTP session. */
export async function verifyEmailTransport(): Promise<boolean> {
  if (!config.email.enabled) return false;
  const mailer = getTransporter();
  if (!mailer) return false;
  try {
    await mailer.verify();
    return true;
  } catch (error) {
    logger.error('SMTP transport verification failed', {
      reason: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/** Sends a plain smoke-test message when explicitly requested by an operator. */
export async function sendTestEmail(
  recipient: string
): Promise<EmailDeliveryResult> {
  if (!config.email.enabled) return disabledResult();
  const from = validEmail(config.email.from);
  const to = validEmail(recipient);
  if (!from || !to) {
    return { enabled: true, sent: false, reason: 'invalid_recipient' };
  }

  return deliver({
    from,
    to,
    subject: '[IGO PDF] SMTP smoke test',
    text: 'SMTP relay test from IGO PDF succeeded.',
  });
}
