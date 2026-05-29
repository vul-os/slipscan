/**
 * Email templates — port of backend/internal/email/layout.go and
 * invite_template.go.
 *
 * renderLayout() produces the shared brand-chrome HTML; renderText() produces
 * the plain-text counterpart. inviteEmail() is the only template ported here
 * (auth/verify + welcome templates use the same renderLayout primitives and
 * can be added later without touching this file).
 */

// ── Layout types ──────────────────────────────────────────────────────────────

export interface LayoutContent {
  subject:      string;
  preheader?:   string; // inbox preview; auto-derived from introHTML when absent
  eyebrow:      string; // small uppercase label above headline
  headline:     string;
  introHTML:    string; // may contain safe HTML
  ctaText?:     string; // button label; button omitted when absent
  ctaURL?:      string; // button target; required when ctaText is set
  afterCtaHTML?: string;
  footnoteHTML?: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function escapeHTML(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Minimal HTML tag-stripper for converting layout HTML to plain text. */
function stripHTML(s: string): string {
  let out   = "";
  let skip  = false;
  for (const ch of s) {
    if      (ch === "<") skip = true;
    else if (ch === ">") skip = false;
    else if (!skip)      out += ch;
  }
  out = out
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g,  "&")
    .replace(/&lt;/g,   "<")
    .replace(/&gt;/g,   ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g,  "'");
  return out.replace(/\s+/g, " ").trim();
}

// ── renderLayout ──────────────────────────────────────────────────────────────

/** Render a full HTML email from LayoutContent using the shared brand chrome. */
export function renderLayout(c: LayoutContent): string {
  const preheader = c.preheader ?? stripHTML(c.introHTML);

  let cta = "";
  if (c.ctaText && c.ctaURL) {
    const eURL  = escapeHTML(c.ctaURL);
    const eText = escapeHTML(c.ctaText);
    cta = `
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 28px;">
                <tr>
                  <td bgcolor="#C8FF00" style="border-radius:8px;">
                    <a href="${eURL}"
                       style="display:inline-block;padding:13px 28px;background:#C8FF00;color:#0A0A0A;text-decoration:none;border-radius:8px;font-weight:500;font-size:15px;letter-spacing:-0.01em;line-height:1;mso-padding-alt:0;">
                      ${eText}
                    </a>
                  </td>
                </tr>
              </table>

              <p style="margin:0 0 6px;font-size:12px;color:#71717a;">
                Or paste this link into your browser:
              </p>
              <p style="margin:0 0 28px;font-size:12px;line-height:1.5;color:#52525b;word-break:break-all;">
                <a href="${eURL}" style="color:#52525b;text-decoration:underline;">${eURL}</a>
              </p>`;
  }

  let footnote = "";
  if (c.footnoteHTML) {
    footnote = `
              <div style="height:1px;background:#f4f4f5;margin:0 0 20px;line-height:1px;font-size:0;">&nbsp;</div>
              <p style="margin:0;font-size:11px;line-height:1.6;color:#a1a1aa;">
                ${c.footnoteHTML}
              </p>`;
  }

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${escapeHTML(c.subject)}</title>
</head>
<body style="margin:0;padding:0;background:#fafafa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#27272a;-webkit-font-smoothing:antialiased;">
  <div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:#fafafa;opacity:0;">
    ${escapeHTML(preheader)}
  </div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#fafafa;">
    <tr>
      <td align="center" style="padding:40px 16px;">
        <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background:#ffffff;border:1px solid #e4e4e7;border-radius:12px;overflow:hidden;">

          <tr>
            <td style="padding:24px 32px;border-bottom:1px solid #f4f4f5;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td width="28" height="28" align="center" valign="middle"
                      style="width:28px;height:28px;background:#0A0A0A;border-radius:6px;font-family:Georgia,'Times New Roman',serif;color:#C8FF00;font-weight:700;font-size:18px;line-height:28px;text-align:center;">
                    /
                  </td>
                  <td style="padding-left:10px;font-size:18px;line-height:28px;font-weight:500;letter-spacing:-0.02em;color:#18181b;">
                    slip<span style="color:#9FCC00;">/</span>scan
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <tr>
            <td style="padding:40px 32px 32px;">
              <p style="margin:0 0 10px;font-size:11px;letter-spacing:0.10em;text-transform:uppercase;color:#71717a;font-weight:500;">
                ${escapeHTML(c.eyebrow)}
              </p>
              <h1 style="margin:0 0 20px;font-size:26px;line-height:1.2;letter-spacing:-0.025em;font-weight:500;color:#18181b;">
                ${escapeHTML(c.headline)}
              </h1>
              <p style="margin:0 0 28px;font-size:15px;line-height:1.6;color:#3f3f46;">
                ${c.introHTML}
              </p>
${cta}${c.afterCtaHTML ?? ""}${footnote}
            </td>
          </tr>
        </table>

        <p style="margin:18px 0 0;font-size:11px;color:#a1a1aa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
          slip<span style="color:#9FCC00;">/</span>scan &nbsp;·&nbsp; receipts, structured.
        </p>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// ── renderText ────────────────────────────────────────────────────────────────

/** Render a plain-text email from LayoutContent. */
export function renderText(c: LayoutContent, ...footerLines: string[]): string {
  let out = "slip/scan — receipts, structured.\n\n";
  if (c.eyebrow) {
    out += c.eyebrow + "\n";
    out += "=".repeat(c.eyebrow.length) + "\n\n";
  }
  if (c.headline) out += c.headline + "\n\n";
  const intro = stripHTML(c.introHTML);
  if (intro)     out += intro + "\n\n";
  if (c.ctaText && c.ctaURL) {
    out += c.ctaText + ":\n";
    out += c.ctaURL  + "\n\n";
  }
  const foot = stripHTML(c.footnoteHTML ?? "");
  if (foot) out += foot + "\n";
  for (const line of footerLines) out += line + "\n";
  return out;
}

// ── Invite template ───────────────────────────────────────────────────────────

/**
 * Render the invitation email — port of backend/internal/email/invite_template.go.
 * Returns { subject, html, text }.
 */
export function inviteEmail(
  orgName:     string,
  inviterName: string,
  acceptURL:   string,
): { subject: string; html: string; text: string } {
  const org = orgName.trim();
  const by  = inviterName.trim();

  let subject: string;
  if (org && by)  subject = `${by} invited you to ${org} on slip/scan`;
  else if (org)   subject = `You're invited to ${org} on slip/scan`;
  else            subject = "You're invited to slip/scan";

  // Plain-text who-line
  let plainWho: string;
  if (org && by)  plainWho = `${by} has invited you to join ${org} on slip/scan.`;
  else if (org)   plainWho = `You've been invited to join ${org} on slip/scan.`;
  else            plainWho = "You've been invited to join a workspace on slip/scan.";

  // HTML who-line
  let introHTML: string;
  if (org && by) {
    introHTML = `<strong style="color:#18181b;font-weight:500;">${escapeHTML(by)}</strong> invited you to join <strong style="color:#18181b;font-weight:500;">${escapeHTML(org)}</strong> on slip/scan.`;
  } else if (org) {
    introHTML = `You've been invited to join <strong style="color:#18181b;font-weight:500;">${escapeHTML(org)}</strong> on slip/scan.`;
  } else {
    introHTML = "You've been invited to join a workspace on slip/scan.";
  }

  const html = renderLayout({
    subject,
    preheader:   plainWho,
    eyebrow:     "You're invited",
    headline:    "Join the workspace",
    introHTML,
    ctaText:     "Accept invitation",
    ctaURL:      acceptURL,
    footnoteHTML: "This link expires in 7 days. If you weren't expecting this email, you can safely ignore it — no account will be created.",
  });

  const text = renderText(
    {
      subject,
      eyebrow:     "You're invited",
      headline:    "Join the workspace",
      introHTML:   plainWho,
      ctaText:     "Accept the invitation",
      ctaURL:      acceptURL,
      footnoteHTML: "This link expires in 7 days. If you weren't expecting this email, you can safely ignore it — no account will be created.",
    },
  );

  return { subject, html, text };
}

// ── verifyEmail (port of Go email.VerifyEmail) ─────────────────────────────────

export function verifyEmail(
  fullName: string,
  verifyURL: string,
): { subject: string; html: string; text: string } {
  const subject = "Verify your email for slip/scan";
  const fn = (fullName ?? "").trim();
  const greet = fn ? `Welcome to slip/scan, ${escapeHTML(fn)}.` : "Welcome to slip/scan.";
  const content: LayoutContent = {
    subject,
    preheader: "Click to confirm your slip/scan email address.",
    eyebrow: "Verify your email",
    headline: "One quick step",
    introHTML: `${greet} Confirm your email so we can secure your account and send you receipts, summaries, and the things that matter.`,
    ctaText: "Verify email",
    ctaURL: verifyURL,
    footnoteHTML:
      "This link expires in 24 hours. If you didn't sign up for slip/scan, you can safely ignore this email.",
  };
  return { subject, html: renderLayout(content), text: renderText(content) };
}

// ── passwordResetEmail (port of Go email.PasswordResetEmail) ───────────────────

export function passwordResetEmail(
  fullName: string,
  resetURL: string,
): { subject: string; html: string; text: string } {
  const subject = "Reset your slip/scan password";
  const fn = (fullName ?? "").trim();
  const greet = fn
    ? `Hi ${escapeHTML(fn)}, we got a request to reset your slip/scan password.`
    : "We got a request to reset your slip/scan password.";
  const content: LayoutContent = {
    subject,
    preheader: "Click to choose a new slip/scan password.",
    eyebrow: "Reset password",
    headline: "Choose a new password",
    introHTML: `${greet} Click the button below to set a new one.`,
    ctaText: "Reset password",
    ctaURL: resetURL,
    footnoteHTML:
      "This link expires in 1 hour. If you didn't request a reset, you can safely ignore this email — your password stays unchanged.",
  };
  return { subject, html: renderLayout(content), text: renderText(content) };
}
