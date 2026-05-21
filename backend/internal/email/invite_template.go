package email

import (
	"fmt"
	"html"
	"strings"
)

// InviteEmail renders the HTML and plaintext bodies for an invitation.
// orgName and inviterName may be empty; the template degrades gracefully.
//
// Note on styling: email clients (Gmail in particular) strip <style> tags
// and SVG, and ignore most modern CSS. So everything is inline-styled,
// uses table layout, and recreates the logomark in HTML rather than
// embedding the SVG.
func InviteEmail(orgName, inviterName, acceptURL string) (subject, htmlBody, textBody string) {
	org := strings.TrimSpace(orgName)
	by := strings.TrimSpace(inviterName)

	switch {
	case org != "" && by != "":
		subject = fmt.Sprintf("%s invited you to %s on slip/scan", by, org)
	case org != "":
		subject = fmt.Sprintf("You're invited to %s on slip/scan", org)
	default:
		subject = "You're invited to slip/scan"
	}

	whoLine := "You've been invited to join a workspace on slip/scan."
	if org != "" && by != "" {
		whoLine = fmt.Sprintf(
			`<strong style="color:#18181b;font-weight:500;">%s</strong> invited you to join <strong style="color:#18181b;font-weight:500;">%s</strong> on slip/scan.`,
			html.EscapeString(by), html.EscapeString(org))
	} else if org != "" {
		whoLine = fmt.Sprintf(
			`You've been invited to join <strong style="color:#18181b;font-weight:500;">%s</strong> on slip/scan.`,
			html.EscapeString(org))
	}

	escURL := html.EscapeString(acceptURL)

	htmlBody = fmt.Sprintf(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>%s</title>
</head>
<body style="margin:0;padding:0;background:#fafafa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#27272a;-webkit-font-smoothing:antialiased;">
  <!-- Preheader: shows after subject in inbox preview, hidden in body -->
  <div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:#fafafa;opacity:0;">
    %s — accept the invitation to join the workspace.
  </div>

  <table role="presentation" width="100%%" cellpadding="0" cellspacing="0" border="0" style="background:#fafafa;">
    <tr>
      <td align="center" style="padding:40px 16px;">
        <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background:#ffffff;border:1px solid #e4e4e7;border-radius:12px;overflow:hidden;">

          <!-- Header bar with logomark + wordmark -->
          <tr>
            <td style="padding:24px 32px;border-bottom:1px solid #f4f4f5;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <!-- Logomark: dark rounded square with the chartreuse slash -->
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

          <!-- Body -->
          <tr>
            <td style="padding:40px 32px 32px;">
              <p style="margin:0 0 10px;font-size:11px;letter-spacing:0.10em;text-transform:uppercase;color:#71717a;font-weight:500;">
                You're invited
              </p>
              <h1 style="margin:0 0 20px;font-size:26px;line-height:1.2;letter-spacing:-0.025em;font-weight:500;color:#18181b;">
                Join the workspace
              </h1>
              <p style="margin:0 0 28px;font-size:15px;line-height:1.6;color:#3f3f46;">
                %s
              </p>

              <!-- Bulletproof button (works in Outlook + everywhere else) -->
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 28px;">
                <tr>
                  <td bgcolor="#C8FF00" style="border-radius:8px;">
                    <a href="%s"
                       style="display:inline-block;padding:13px 28px;background:#C8FF00;color:#0A0A0A;text-decoration:none;border-radius:8px;font-weight:500;font-size:15px;letter-spacing:-0.01em;line-height:1;mso-padding-alt:0;">
                      Accept invitation
                    </a>
                  </td>
                </tr>
              </table>

              <p style="margin:0 0 6px;font-size:12px;color:#71717a;">
                Or paste this link into your browser:
              </p>
              <p style="margin:0 0 28px;font-size:12px;line-height:1.5;color:#52525b;word-break:break-all;">
                <a href="%s" style="color:#52525b;text-decoration:underline;">%s</a>
              </p>

              <!-- Hairline divider -->
              <div style="height:1px;background:#f4f4f5;margin:0 0 20px;line-height:1px;font-size:0;">&nbsp;</div>

              <p style="margin:0;font-size:11px;line-height:1.6;color:#a1a1aa;">
                This link expires in 7 days. If you weren't expecting this email, you can safely ignore it — no account will be created.
              </p>
            </td>
          </tr>
        </table>

        <!-- Footer -->
        <p style="margin:18px 0 0;font-size:11px;color:#a1a1aa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
          slip<span style="color:#9FCC00;">/</span>scan &nbsp;·&nbsp; receipts, structured.
        </p>
      </td>
    </tr>
  </table>
</body>
</html>`, html.EscapeString(subject), html.EscapeString(plainWho(org, by)), whoLine, escURL, escURL, escURL)

	var t strings.Builder
	t.WriteString("slip/scan — receipts, structured.\n\n")
	t.WriteString("You're invited\n==============\n\n")
	t.WriteString(plainWho(org, by))
	t.WriteString("\n\nAccept the invitation:\n")
	t.WriteString(acceptURL)
	t.WriteString("\n\nThis link expires in 7 days. If you weren't expecting this email, you can safely ignore it — no account will be created.\n")
	textBody = t.String()
	return subject, htmlBody, textBody
}

func plainWho(org, by string) string {
	switch {
	case org != "" && by != "":
		return fmt.Sprintf("%s has invited you to join %s on slip/scan.", by, org)
	case org != "":
		return fmt.Sprintf("You've been invited to join %s on slip/scan.", org)
	default:
		return "You've been invited to join a workspace on slip/scan."
	}
}
