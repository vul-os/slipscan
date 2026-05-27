package email

import (
	"errors"
	"fmt"
	"net"
	"testing"

	sestypes "github.com/aws/aws-sdk-go-v2/service/sesv2/types"
)

// ── IsTransient tests ──────────────────────────────────────────────────────

func TestIsTransientNil(t *testing.T) {
	if IsTransient(nil) {
		t.Error("nil error should not be transient")
	}
}

func TestIsTransientThrottling(t *testing.T) {
	err := &sestypes.TooManyRequestsException{}
	if !IsTransient(err) {
		t.Error("TooManyRequestsException should be transient")
	}
}

func TestIsTransientInternalServiceError(t *testing.T) {
	err := &sestypes.InternalServiceErrorException{}
	if !IsTransient(err) {
		t.Error("InternalServiceErrorException should be transient")
	}
}

func TestIsTransientSendingPaused(t *testing.T) {
	err := &sestypes.SendingPausedException{}
	if !IsTransient(err) {
		t.Error("SendingPausedException should be transient")
	}
}

func TestIsTransientAccountSuspended(t *testing.T) {
	err := &sestypes.AccountSuspendedException{}
	if IsTransient(err) {
		t.Error("AccountSuspendedException should NOT be transient")
	}
}

func TestIsTransientMessageRejected(t *testing.T) {
	err := &sestypes.MessageRejected{}
	if IsTransient(err) {
		t.Error("MessageRejected should NOT be transient")
	}
}

func TestIsTransientMailFromDomainNotVerified(t *testing.T) {
	err := &sestypes.MailFromDomainNotVerifiedException{}
	if IsTransient(err) {
		t.Error("MailFromDomainNotVerifiedException should NOT be transient")
	}
}

func TestIsTransientBadRequest(t *testing.T) {
	err := &sestypes.BadRequestException{}
	if IsTransient(err) {
		t.Error("BadRequestException should NOT be transient")
	}
}

func TestIsTransientNetworkError(t *testing.T) {
	// Wrap a net.Error to simulate a connection timeout.
	err := &net.DNSError{IsTimeout: true}
	if !IsTransient(err) {
		t.Error("net timeout error should be transient")
	}
}

func TestIsTransientWrappedTransient(t *testing.T) {
	inner := &sestypes.TooManyRequestsException{}
	err := fmt.Errorf("ses: send email: %w", inner)
	if !IsTransient(err) {
		t.Error("wrapped TooManyRequestsException should be transient")
	}
}

func TestIsTransientWrappedPermanent(t *testing.T) {
	inner := &sestypes.MessageRejected{}
	err := fmt.Errorf("ses: send email: %w", inner)
	if IsTransient(err) {
		t.Error("wrapped MessageRejected should NOT be transient")
	}
}

func TestIsTransientUnknownError(t *testing.T) {
	// Unknown errors default to transient (fail open → retry).
	err := errors.New("some unexpected error")
	if !IsTransient(err) {
		t.Error("unknown error should default to transient")
	}
}

// ── buildSendInput mapping tests ───────────────────────────────────────────

func TestBuildSendInputBasicMapping(t *testing.T) {
	msg := Message{
		From:    "sender@example.com",
		To:      "recipient@example.com",
		Subject: "Hello",
		HTML:    "<p>Hello</p>",
		Text:    "Hello",
	}

	input := buildSendInput(msg.From, msg, "")

	if input.FromEmailAddress == nil || *input.FromEmailAddress != "sender@example.com" {
		t.Errorf("FromEmailAddress: got %v want sender@example.com", input.FromEmailAddress)
	}
	if len(input.Destination.ToAddresses) != 1 || input.Destination.ToAddresses[0] != "recipient@example.com" {
		t.Errorf("ToAddresses: got %v want [recipient@example.com]", input.Destination.ToAddresses)
	}
	if input.Content.Simple.Subject.Data == nil || *input.Content.Simple.Subject.Data != "Hello" {
		t.Errorf("Subject: got %v want Hello", input.Content.Simple.Subject.Data)
	}
	if input.Content.Simple.Body.Html == nil {
		t.Error("Html body should be set")
	} else if *input.Content.Simple.Body.Html.Data != "<p>Hello</p>" {
		t.Errorf("Html.Data: got %q want <p>Hello</p>", *input.Content.Simple.Body.Html.Data)
	}
	if input.Content.Simple.Body.Text == nil {
		t.Error("Text body should be set")
	} else if *input.Content.Simple.Body.Text.Data != "Hello" {
		t.Errorf("Text.Data: got %q want Hello", *input.Content.Simple.Body.Text.Data)
	}
	if input.ConfigurationSetName != nil {
		t.Errorf("ConfigurationSetName should be nil when empty, got %v", input.ConfigurationSetName)
	}
}

func TestBuildSendInputConfigurationSet(t *testing.T) {
	msg := Message{To: "a@b.com", Subject: "s"}
	input := buildSendInput("from@b.com", msg, "my-config-set")
	if input.ConfigurationSetName == nil || *input.ConfigurationSetName != "my-config-set" {
		t.Errorf("ConfigurationSetName: got %v want my-config-set", input.ConfigurationSetName)
	}
}

func TestBuildSendInputHTMLOnlyBody(t *testing.T) {
	msg := Message{To: "a@b.com", Subject: "s", HTML: "<b>hi</b>"}
	input := buildSendInput("f@b.com", msg, "")
	if input.Content.Simple.Body.Html == nil {
		t.Error("Html body should be set")
	}
	if input.Content.Simple.Body.Text != nil {
		t.Error("Text body should be nil when msg.Text is empty")
	}
}

func TestBuildSendInputTextOnlyBody(t *testing.T) {
	msg := Message{To: "a@b.com", Subject: "s", Text: "plain"}
	input := buildSendInput("f@b.com", msg, "")
	if input.Content.Simple.Body.Text == nil {
		t.Error("Text body should be set")
	}
	if input.Content.Simple.Body.Html != nil {
		t.Error("Html body should be nil when msg.HTML is empty")
	}
}
