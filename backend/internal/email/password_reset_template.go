package email

import (
	"fmt"
	"html"
	"strings"
)

// PasswordResetEmail renders the "reset your password" message. fullName
// may be empty.
func PasswordResetEmail(fullName, resetURL string) (subject, htmlBody, textBody string) {
	subject = "Reset your slip/scan password"

	greet := "We got a request to reset your slip/scan password."
	if fn := strings.TrimSpace(fullName); fn != "" {
		greet = fmt.Sprintf("Hi %s, we got a request to reset your slip/scan password.", html.EscapeString(fn))
	}

	c := LayoutContent{
		Subject:      subject,
		Preheader:    "Click to choose a new slip/scan password.",
		Eyebrow:      "Reset password",
		Headline:     "Choose a new password",
		IntroHTML:    fmt.Sprintf(`%s Click the button below to set a new one.`, greet),
		CTAText:      "Reset password",
		CTAURL:       resetURL,
		FootnoteHTML: `This link expires in 1 hour. If you didn't request a reset, you can safely ignore this email — your password stays unchanged.`,
	}
	htmlBody = renderLayout(c)
	textBody = renderText(c)
	return subject, htmlBody, textBody
}
