/**
 * Cloudflare Worker
 *
 * Handles form submissions for all sites via POST /submit.
 * Uses Postmark to send owner notifications + user autoresponses.
 *
 * Secrets to set via Wrangler CLI (wrangler secret put POSTMARK_API_KEY):
 *   POSTMARK_API_KEY   — your Postmark server API token
 */

// ---------------------------------------------------------------------------
// Site config
// ---------------------------------------------------------------------------

const ZEDPA_SITE = {
  domain: "zedpa.dev",
  ownerEmail: "hello@zedpa.dev",
  ownerName: "Zedpa.dev",
  fromEmail: "hello@zedpa.dev",
  fromName: "Zedpa.dev",
  subject: "New enquiry from zedpa.dev",
};

const APCV_SITE = {
  domain: "apcv.zedpa.dev",
  ownerEmail: "hello@zedpa.dev", // TODO should be to apcv
  ownerName: "APCV Owner",
  fromEmail: "hello@zedpa.dev", // TODO should be from apcv
  fromName: "APCV",
  subject: "New enquiry from apcv.com.au",
}

const ALL_SITES = [ZEDPA_SITE, APCV_SITE];

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
export default {
  async fetch(request, env) {

    if (request.method === "OPTIONS") {
      return handleCors();
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    const url = new URL(request.url);

    if (url.pathname !== "/submit") {
      // only interested in /submit path
      return new Response("Not found", { status: 404 });
    }

    // if origin doesn't match one of our sites, ignore
    const origin = request.headers.get('Origin');
    const site = ALL_SITES.find(s => origin.endsWith(s.domain));

    if (!site) {
      return jsonError("Unknown site", 400);
    }

    return handleSubmit(request, env, site);
  },
};



// ---------------------------------------------------------------------------
// Form submission handler
// ---------------------------------------------------------------------------
async function handleSubmit(request, env, site) {
  if (!site) {
    return jsonError("Unknown site", 400);
  }

  let fields;
  try {
    fields = await request.json();
  } catch {
    return jsonError("Could not parse JSON body", 400);
  }

  const safeFields = makeSafeFields(fields);
  const email = safeFields.EMAIL;
  const name = safeFields.NAME;

  if (!isValidEmail(email)) {
    return jsonError("Invalid email address", 422);
  }

  try {
    await Promise.all([
      sendOwnerNotification(site, safeFields, env),
      sendUserAutoresponse(site, { name, email }, env),
    ]);
  } catch (err) {
    console.error("Postmark error:", err);
    return jsonError("Failed to send email. Please try again later.", 502);
  }

  return new Response(JSON.stringify({ ok: true }), {
    headers: corsHeaders({ "Content-Type": "application/json" }),
  });
}

// ---------------------------------------------------------------------------
// Email senders
// ---------------------------------------------------------------------------

/**
 * Sends a notification to the site owner with the full submission details.
 */
async function sendOwnerNotification(site, fields, env) {
  const { NAME: name, EMAIL: email, PHONE: phone, ...otherFields } = fields;

  const body = `
New enquiry received

NAME:    ${name}
EMAIL:   ${email}
${phone ? `PHONE:   ${phone}` : ''}

` + Object.entries(otherFields).map(([key, value]) => `${key}: ${value}`).join('\n').trim();

  return postmark({
    From: `${site.fromName} <${site.fromEmail}>`,
    To: `${site.ownerName} <${site.ownerEmail}>`,
    ReplyTo: `${name} <${email}>`,
    Subject: site.subject,
    TextBody: body,
  }, env);
}

/**
 * Sends a plain confirmation to the person who submitted the form.
 */
async function sendUserAutoresponse(site, { name, email }, env) {
  const body = `
Hi ${name},

Thanks for getting in touch. We've received your message and will get back to you shortly.

— ${site.fromName}
  `.trim();

  return postmark({
    From: `${site.fromName} <${site.fromEmail}>`,
    To: email,
    Subject: `We've received your message`,
    TextBody: body,
  }, env);
}

// ---------------------------------------------------------------------------
// Postmark API call
// ---------------------------------------------------------------------------
async function postmark(payload, env) {
  const response = await fetch("https://api.postmarkapp.com/email", {
    method: "POST",
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/json",
      "X-Postmark-Server-Token": env.POSTMARK_API_KEY,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Postmark responded ${response.status}: ${error}`);
  }

  return response.json();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function jsonError(message, status) {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status,
    headers: corsHeaders({ "Content-Type": "application/json" }),
  });
}

function handleCors() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

function corsHeaders(extra = {}) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    ...extra,
  };
}

// given an object of fields, returns a new object with cleaned field names (e.g. "Email:" becomes "EMAIL") but same values
const rxDisallowedChars = /[^a-z0-9 ]/g;
function makeSafeFields(fields) {
  const safeFields = {};
  for (const key in fields) {
    const safeKey = key.toUpperCase().replace(rxDisallowedChars, '');
    safeFields[safeKey] = fields[key];
  }
  return safeFields;
}