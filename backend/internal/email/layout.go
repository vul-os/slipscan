package email

import (
	"fmt"
	"html"
	"strings"
)

// LayoutContent is the per-template payload rendered inside the shared
// header/footer/wrapper. Every transactional email shares this chrome so
// brand updates land in one place.
type LayoutContent struct {
	// Subject is the email subject line.
	Subject string

	// Preheader is hidden inbox preview text. Leave empty to omit.
	Preheader string

	// Eyebrow is the small uppercase label above the headline.
	// Examples: "You're invited", "Verify your email", "Welcome".
	Eyebrow string

	// Headline is the large h1.
	Headline string

	// Intro is the single paragraph below the headline. May contain HTML.
	IntroHTML string

	// CTAText is the button label (e.g. "Verify email"). Leave empty to omit
	// the button entirely.
	CTAText string

	// CTAURL is the button target URL. Required when CTAText is set.
	CTAURL string

	// AfterCTAHTML is optional HTML rendered between the button and the
	// "or paste this link" fallback.
	AfterCTAHTML string

	// Footnote is the small grey paragraph at the bottom of the card
	// (expiry, "ignore if you didn't request" etc.).
	FootnoteHTML string
}

// renderLayout renders LayoutContent into a full HTML document using the
// shared brand chrome. The HTML follows email-client constraints: tables,
// inline styles only, no <style>, no SVG.
func renderLayout(c LayoutContent) string {
	preheader := c.Preheader
	if preheader == "" {
		preheader = stripHTML(c.IntroHTML)
	}

	cta := ""
	if c.CTAText != "" && c.CTAURL != "" {
		cta = fmt.Sprintf(`
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 28px;">
                <tr>
                  <td bgcolor="#C8FF00" style="border-radius:8px;">
                    <a href="%s"
                       style="display:inline-block;padding:13px 28px;background:#C8FF00;color:#0A0A0A;text-decoration:none;border-radius:8px;font-weight:500;font-size:15px;letter-spacing:-0.01em;line-height:1;mso-padding-alt:0;">
                      %s
                    </a>
                  </td>
                </tr>
              </table>

              <p style="margin:0 0 6px;font-size:12px;color:#71717a;">
                Or paste this link into your browser:
              </p>
              <p style="margin:0 0 28px;font-size:12px;line-height:1.5;color:#52525b;word-break:break-all;">
                <a href="%s" style="color:#52525b;text-decoration:underline;">%s</a>
              </p>`,
			html.EscapeString(c.CTAURL), html.EscapeString(c.CTAText),
			html.EscapeString(c.CTAURL), html.EscapeString(c.CTAURL))
	}

	footnote := ""
	if c.FootnoteHTML != "" {
		footnote = fmt.Sprintf(`
              <div style="height:1px;background:#f4f4f5;margin:0 0 20px;line-height:1px;font-size:0;">&nbsp;</div>
              <p style="margin:0;font-size:11px;line-height:1.6;color:#a1a1aa;">
                %s
              </p>`, c.FootnoteHTML)
	}

	return fmt.Sprintf(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>%s</title>
</head>
<body style="margin:0;padding:0;background:#fafafa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#27272a;-webkit-font-smoothing:antialiased;">
  <div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:#fafafa;opacity:0;">
    %s
  </div>

  <table role="presentation" width="100%%" cellpadding="0" cellspacing="0" border="0" style="background:#fafafa;">
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
                %s
              </p>
              <h1 style="margin:0 0 20px;font-size:26px;line-height:1.2;letter-spacing:-0.025em;font-weight:500;color:#18181b;">
                %s
              </h1>
              <p style="margin:0 0 28px;font-size:15px;line-height:1.6;color:#3f3f46;">
                %s
              </p>
%s%s%s
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
</html>`,
		html.EscapeString(c.Subject),
		html.EscapeString(preheader),
		html.EscapeString(c.Eyebrow),
		html.EscapeString(c.Headline),
		c.IntroHTML,
		cta,
		c.AfterCTAHTML,
		footnote,
	)
}

// renderText is the plaintext counterpart to renderLayout. It produces a
// readable plain-text version of the same content.
func renderText(c LayoutContent, footerLines ...string) string {
	var b strings.Builder
	b.WriteString("slip/scan — receipts, structured.\n\n")
	if c.Eyebrow != "" {
		b.WriteString(c.Eyebrow + "\n")
		b.WriteString(strings.Repeat("=", len(c.Eyebrow)) + "\n\n")
	}
	if c.Headline != "" {
		b.WriteString(c.Headline + "\n\n")
	}
	if intro := stripHTML(c.IntroHTML); intro != "" {
		b.WriteString(intro + "\n\n")
	}
	if c.CTAText != "" && c.CTAURL != "" {
		b.WriteString(c.CTAText + ":\n")
		b.WriteString(c.CTAURL + "\n\n")
	}
	if foot := stripHTML(c.FootnoteHTML); foot != "" {
		b.WriteString(foot + "\n")
	}
	for _, line := range footerLines {
		b.WriteString(line + "\n")
	}
	return b.String()
}

// stripHTML is a minimal tag-stripper for converting layout HTML payloads
// to plain text. Good enough for our limited template HTML — not a general
// HTML parser.
func stripHTML(s string) string {
	var b strings.Builder
	skip := false
	for _, r := range s {
		switch {
		case r == '<':
			skip = true
		case r == '>':
			skip = false
		case !skip:
			b.WriteRune(r)
		}
	}
	out := b.String()
	out = strings.ReplaceAll(out, "&nbsp;", " ")
	out = strings.ReplaceAll(out, "&amp;", "&")
	out = strings.ReplaceAll(out, "&lt;", "<")
	out = strings.ReplaceAll(out, "&gt;", ">")
	out = strings.ReplaceAll(out, "&quot;", `"`)
	out = strings.ReplaceAll(out, "&#39;", "'")
	out = strings.Join(strings.Fields(out), " ")
	return strings.TrimSpace(out)
}
