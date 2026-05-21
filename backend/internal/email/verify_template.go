package email

import (
	"fmt"
	"html"
	"strings"
)

// VerifyEmail renders the email-verification message. fullName may be empty.
func VerifyEmail(fullName, verifyURL string) (subject, htmlBody, textBody string) {
	subject = "Verify your email for slip/scan"

	greet := "Welcome to slip/scan."
	if fn := strings.TrimSpace(fullName); fn != "" {
		greet = fmt.Sprintf("Welcome to slip/scan, %s.", html.EscapeString(fn))
	}
	intro := fmt.Sprintf(
		`%s Confirm your email so we can secure your account and send you receipts, summaries, and the things that matter.`,
		greet)

	c := LayoutContent{
		Subject:      subject,
		Preheader:    "Click to confirm your slip/scan email address.",
		Eyebrow:      "Verify your email",
		Headline:     "One quick step",
		IntroHTML:    intro,
		CTAText:      "Verify email",
		CTAURL:       verifyURL,
		FootnoteHTML: `This link expires in 24 hours. If you didn't sign up for slip/scan, you can safely ignore this email.`,
	}
	htmlBody = renderLayout(c)
	textBody = renderText(c)
	return subject, htmlBody, textBody
}
