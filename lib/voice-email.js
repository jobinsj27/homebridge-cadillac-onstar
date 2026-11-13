'use strict';

// Validate the complete Gmail REST message, including its ordered authentication headers.
function parseVoiceEmail(message, config, parseAlert) {
  try {
    if (!message || typeof message !== 'object' || Array.isArray(message)
        || !config || typeof config !== 'object' || Array.isArray(config)
        || typeof parseAlert !== 'function' || typeof Buffer === 'undefined'
        || Buffer.byteLength(JSON.stringify(message), 'utf8') > 131072
        || typeof message.id !== 'string' || !/^[0-9a-f]{1,64}$/i.test(message.id)
        || typeof message.internalDate !== 'string' || !/^\d{1,16}$/.test(message.internalDate)) return null;
    const timestamp = Number(message.internalDate);
    const now = config.now ?? Date.now();
    const maxAge = config.maxAgeSeconds ?? 3600;
    const shortCode = config.shortCode ?? '63628';
    const utcTimestamp = value => {
      if (typeof value !== 'string') return null;
      const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/.exec(value);
      const parsed = Date.parse(value);
      return match && Number.isSafeInteger(parsed) && parsed >= 0
        && new Date(parsed).toISOString() === `${match[1]}.${(match[2] || '').padEnd(3, '0')}Z`
        ? parsed : null;
    };
    const notBefore = utcTimestamp(config.notBefore);
    if (!Number.isSafeInteger(timestamp) || timestamp < 0 || !Number.isSafeInteger(now) || now < 0
        || !Number.isInteger(maxAge) || maxAge < 60 || maxAge > 86400
        || typeof shortCode !== 'string' || !/^\d{5,6}$/.test(shortCode)
        || notBefore === null || notBefore > now || timestamp < notBefore
        || timestamp > now + 30000 || now - timestamp > maxAge * 1000) return null;

    const validHeaders = headers => Array.isArray(headers) && headers.length <= 100
      && headers.every(header => header && typeof header === 'object'
        && typeof header.name === 'string' && /^[A-Za-z0-9-]{1,100}$/.test(header.name)
        && typeof header.value === 'string' && header.value.length <= 8192);
    const headers = message.payload?.headers;
    if (!validHeaders(headers)) return null;
    const values = name => headers.filter(header => header.name.toLowerCase() === name)
      .map(header => header.value);
    const authentication = values('authentication-results')[0];
    if (typeof authentication !== 'string' || authentication.length > 4096) return null;
    // Trust only the first Authentication-Results header inserted by Gmail.
    // A later forged pass must not rescue a failed or foreign first header.
    let authenticationText = authentication.replace(/\r?\n[ \t]+/g, ' ').replace(/[ \t]+/g, ' ');
    if (/[\u0000-\u001f\u007f]/.test(authenticationText)) return null;
    for (let i = 0; i < 8 && /\([^()]*\)/.test(authenticationText); i += 1) {
      authenticationText = authenticationText.replace(/\([^()]*\)/g, ' ');
    }
    if (/[()]/.test(authenticationText)) return null;
    const clauses = authenticationText.split(';').map(value => value.trim());
    if (clauses.shift()?.toLowerCase() !== 'mx.google.com') return null;
    const dkim = clauses.some(clause => /^dkim=pass(?:\s|$)/i.test(clause)
      && /(?:^|\s)header\.(?:i=@google\.com|d=google\.com)(?=\s|$)/i.test(clause));
    const dmarc = clauses.some(clause => /^dmarc=pass(?:\s|$)/i.test(clause)
      && /(?:^|\s)header\.from=(?:google\.com|txt\.voice\.google\.com)(?=\s|$)/i.test(clause));
    if (!dkim || !dmarc) return null;

    const fromValues = values('from');
    const subjects = values('subject');
    if (fromValues.length !== 1 || subjects.length > 1) return null;
    const from = fromValues[0].trim();
    if (/[\r\n,;]/.test(from)) return null;
    const mailbox = /^[^<>]*<([^<>]+)>$/.exec(from)?.[1] ?? from;
    if (/[\s<>]/.test(mailbox)) return null;
    const address = mailbox.toLowerCase();
    const numberedSender = /^(\d{10,15})\.(\d{5,6})\.([a-z0-9_-]{1,128})@txt\.voice\.google\.com$/.exec(address);
    if (!(numberedSender && numberedSender[2] === shortCode)
        && !(address === 'voice-noreply@google.com'
          && subjects[0] === `New text message from ${shortCode}`)) return null;

    let count = 0;
    let malformed = false;
    const candidates = [];
    const visit = (part, depth, attached = false) => {
      if (++count > 30 || depth > 8 || !part || typeof part !== 'object' || Array.isArray(part)
          || typeof part.mimeType !== 'string' || part.mimeType.length > 100
          || (part.headers !== undefined && !validHeaders(part.headers))
          || (part.parts !== undefined && !Array.isArray(part.parts))) {
        malformed = true;
        return;
      }
      const disposition = (part.headers || []).filter(header => header.name.toLowerCase() === 'content-disposition');
      const attachment = attached || Boolean(part.filename)
        || disposition.some(header => /^\s*attachment(?:\s|;|$)/i.test(header.value));
      if (part.mimeType.toLowerCase() === 'text/plain' && !attachment) {
        if (part.parts?.length || typeof part.body?.data !== 'string' || part.body.attachmentId) malformed = true;
        else candidates.push(part.body.data);
      }
      for (const child of part.parts || []) {
        if (malformed) break;
        visit(child, depth + 1, attachment);
      }
    };
    visit(message.payload, 0);
    if (malformed || candidates.length !== 1) return null;
    const encoded = candidates[0];
    if (!/^[A-Za-z0-9_-]*={0,2}$/.test(encoded) || encoded.length > 21848) return null;
    const unpadded = encoded.replace(/=+$/, '');
    if (unpadded.length % 4 === 1 || (encoded !== unpadded && (encoded.length % 4 !== 0
        || unpadded.length % 4 === 0))) return null;
    const bytes = Buffer.from(encoded, 'base64url');
    if (bytes.length === 0 || bytes.length > 16384 || bytes.toString('base64url') !== unpadded) return null;
    const plain = bytes.toString('utf8');
    if (!Buffer.from(plain, 'utf8').equals(bytes)
        || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ufeff]/.test(plain)) return null;
    const lines = plain.replace(/\r\n/g, '\n').trim().split('\n');
    if (lines.some(line => line.includes('\r'))) return null;
    if (/^<https:\/\/voice\.google\.com(?:\/[^\s<>]*)?>$/.test(lines[0])) lines.shift();
    const responseInstructions = [
      'To respond to this text message, reply to this email or visit Google Voice.',
      'To respond to this text message, visit Google Voice.',
    ];
    const knownTail = 'YOUR ACCOUNT <https://voice.google.com> HELP CENTER '
        + '<https://support.google.com/voice#topic=1707989> HELP FORUM '
        + '<https://productforums.google.com/forum/#!forum/voice> '
        + "This email was sent to you because you indicated that you'd like to receive "
        + "email notifications for text messages. If you don't want to receive such "
        + 'emails in the future, please update your email notification settings '
        + '<https://voice.google.com/settings#messages>. Google LLC '
        + '1600 Amphitheatre Pkwy Mountain View CA 94043 USA';
    // Voice wraps its plain-text parts at column boundaries. Remove only complete
    // known suffixes so unrelated text or a second event cannot become a crossing.
    let text = lines.join(' ').trim().replace(/[ \t]+/g, ' ');
    const footers = [knownTail, knownTail.replace('#messages>', '#messaging>')];
    for (const footer of footers) {
      if (text.endsWith(' ' + footer)) text = text.slice(0, -(footer.length + 1));
    }
    responseInstructions.push('To respond to this message, launch Google Voice (https://voice.google.com) on your mobile device or computer.');
    for (const instruction of responseInstructions) {
      if (text.endsWith(' ' + instruction)) text = text.slice(0, -(instruction.length + 1));
    }
    return parseAlert({ text, vehicleName: config.vehicleName, locationName: config.locationName,
      locationId: config.locationId, eventId: `gmail:${message.id.toLowerCase()}`,
      occurredAt: new Date(timestamp).toISOString() });
  } catch {
    // Bad source messages and unexpected formats never expose their contents.
    return null;
  }
}

module.exports = { parseVoiceEmail };
