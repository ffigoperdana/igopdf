import {
  sendTestEmail,
  verifyEmailTransport,
} from '../services/emailService.js';

const recipient = process.argv[2]?.trim();

if (recipient) {
  const result = await sendTestEmail(recipient);
  console.log(JSON.stringify(result));
  process.exitCode = result.sent ? 0 : 1;
} else {
  const verified = await verifyEmailTransport();
  console.log(JSON.stringify({ verified }));
  process.exitCode = verified ? 0 : 1;
}
