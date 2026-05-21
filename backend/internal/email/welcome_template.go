package email

import (
	"fmt"
	"html"
	"strings"
)

// WelcomeEmail renders the post-verification welcome message. orgName is
// shown if non-empty so businesses see their workspace name.
// dashboardURL points the user at their first-login destination.
// rxLocalPart, if set, surfaces the email-in address so users can start
// forwarding receipts immediately.
func WelcomeEmail(fullName, orgName, dashboardURL, rxLocalPart, rxDomain string) (subject, htmlBody, textBody string) {
	subject = "Welcome to slip/scan"

	greet := "You're in."
	if fn := strings.TrimSpace(fullName); fn != "" {
		greet = fmt.Sprintf("You're in, %s.", html.EscapeString(fn))
	}

	var intro strings.Builder
	intro.WriteString(greet)
	intro.WriteString(" ")
	if org := strings.TrimSpace(orgName); org != "" {
		fmt.Fprintf(&intro,
			`Your workspace <strong style="color:#18181b;font-weight:500;">%s</strong> is ready. `,
			html.EscapeString(org))
	} else {
		intro.WriteString("Your workspace is ready. ")
	}
	intro.WriteString("Upload a receipt, forward an email, or just paste a number — slip/scan reads it, classifies it, and files it where you can find it again.")

	after := ""
	if rxLocalPart != "" && rxDomain != "" {
		emailAddr := fmt.Sprintf("%s@%s", rxLocalPart, rxDomain)
		after = fmt.Sprintf(`
              <div style="margin:0 0 28px;padding:14px 16px;background:#fafafa;border:1px solid #f4f4f5;border-radius:8px;">
                <p style="margin:0 0 4px;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:#71717a;font-weight:500;">
                  Your inbox address
                </p>
                <p style="margin:0;font-size:14px;font-family:'SF Mono',ui-monospace,Menlo,Consolas,monospace;color:#18181b;word-break:break-all;">
                  %s
                </p>
                <p style="margin:8px 0 0;font-size:12px;line-height:1.5;color:#71717a;">
                  Forward any receipt or invoice here and we'll process it automatically.
                </p>
              </div>`, html.EscapeString(emailAddr))
	}

	c := LayoutContent{
		Subject:      subject,
		Preheader:    "Your slip/scan workspace is ready.",
		Eyebrow:      "Welcome",
		Headline:     "Receipts, structured.",
		IntroHTML:    intro.String(),
		CTAText:      "Open your dashboard",
		CTAURL:       dashboardURL,
		AfterCTAHTML: after,
		FootnoteHTML: `Need a hand? Reply to this email — a real person reads every reply.`,
	}
	htmlBody = renderLayout(c)
	textBody = renderText(c)
	return subject, htmlBody, textBody
}
