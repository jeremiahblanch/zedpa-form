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
  ownerEmail: "hello@zedpa.dev",
  ownerName: "Zedpa.dev",
  fromEmail: "hello@zedpa.dev",
  fromName: "Zedpa.dev",
  subject: "New enquiry from zedpa.dev",
};

const DUDA_SITES = {
  "apcv.zedpa.dev": {
    ownerEmail: "owner@apcv.com.au",
    ownerName: "APCV Owner",
    fromEmail: "hello@zedpa.dev",
    fromName: "APCV",
    subject: "New enquiry from apcv.com.au",
  },
  "site3.com": {
    ownerEmail: "owner@site3.com",
    ownerName: "Site Three Owner",
    fromEmail: "hello@zedpa.dev",
    fromName: "Site Three",
    subject: "New enquiry from site3.com",
  },
};

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const host = url.hostname.replace(/^www\./, "");
    console.log(JSON.stringify(request));
    console.log('method', request.method);
    console.log('url', request.url);

    if (request.method === "OPTIONS") {
      return handleCors();
    }

    if (url.pathname === "/submit") {
      const site = DUDA_SITES[host] ?? (host === "zedpa.dev" ? ZEDPA_SITE : null);
      return handleSubmit(request, env, site);
    }

    return new Response("Not found", { status: 404 });
  },
};



// ---------------------------------------------------------------------------
// Form submission handler
// ---------------------------------------------------------------------------
async function handleSubmit(request, env, site) {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  if (!site) {
    return jsonError("Unknown site", 400);
  }

  let fields;
  try {
    fields = await request.json();
  } catch {
    return jsonError("Could not parse JSON body", 400);
  }

  const name = getFieldValue(fields, "name");
  const email = getFieldValue(fields, "email");
  const phone = getFieldValue(fields, "phone");
  const message = getFieldValue(fields, "message");

  if (!name || !email || !message) {
    return jsonError("Missing required fields: name, email, message", 422);
  }
  if (!isValidEmail(email)) {
    return jsonError("Invalid email address", 422);
  }

  try {
    await Promise.all([
      sendOwnerNotification({ site, name, email, phone, message }, env),
      sendUserAutoresponse({ site, name, email }, env),
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
async function sendOwnerNotification({ site, name, email, phone, message }, env) {
  const body = `
New enquiry received

Name:    ${name}
Email:   ${email}
Phone:   ${phone || "Not provided"}

Message:
${message}
  `.trim();

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
async function sendUserAutoresponse({ site, name, email }, env) {
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

// gets the field value even if casing of field name is different
function getFieldValue(fields, key) {
  const foundKey = Object.keys(fields).find(k => k.toLowerCase() === key.toLowerCase());
  const value = foundKey ? fields[foundKey] : undefined;
  return value?.trim();
}