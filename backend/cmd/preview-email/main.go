// preview-email writes the invitation HTML to /tmp/invite-preview.html
// so you can iterate on the template without sending real emails.
//
//	go run ./cmd/preview-email
//	xdg-open /tmp/invite-preview.html
package main

import (
	"fmt"
	"os"

	"github.com/exolutionza/slipscan/backend/internal/email"
)

func main() {
	subject, html, text := email.InviteEmail(
		"Test Workspace",
		"Andile",
		"http://localhost:5173/invitations/accept?token=preview-token-1234",
	)
	if err := os.WriteFile("/tmp/invite-preview.html", []byte(html), 0o644); err != nil {
		fmt.Fprintln(os.Stderr, "write:", err)
		os.Exit(1)
	}
	fmt.Println("subject:", subject)
	fmt.Println("html:    /tmp/invite-preview.html")
	fmt.Println()
	fmt.Println("text version:")
	fmt.Println("---")
	fmt.Println(text)
}
