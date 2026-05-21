package testsuite

import (
	"context"
	"fmt"
	"os"

	"github.com/exolutionza/slipscan/backend/internal/email"
)

func init() {
	Register(Test{
		Name:        "preview-email",
		Description: "Renders the invitation email to /tmp/invite-preview.html for visual review.",
		NeedsDB:     false,
		Run:         runPreviewEmail,
	})
}

func runPreviewEmail(_ context.Context, _ *Env) error {
	subject, html, text := email.InviteEmail(
		"Test Workspace",
		"Andile",
		"http://localhost:5173/invitations/accept?token=preview-token-1234",
	)
	const path = "/tmp/invite-preview.html"
	if err := os.WriteFile(path, []byte(html), 0o644); err != nil {
		return fmt.Errorf("write preview: %w", err)
	}
	fmt.Printf("  subject: %s\n", subject)
	fmt.Printf("  html:    %s\n", path)
	fmt.Printf("  text version:\n  ---\n%s\n  ---\n", text)
	return nil
}
