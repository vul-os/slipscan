package email

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/url"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/sesv2"
	sestypes "github.com/aws/aws-sdk-go-v2/service/sesv2/types"
)

// SESConfig holds the parameters required to create a SESClient.
// AccessKeyID and SecretAccessKey are optional — when both are empty the AWS
// default credential chain is used (IAM instance roles, env vars, ~/.aws/…).
type SESConfig struct {
	Region           string
	From             string // default From address
	ConfigurationSet string // optional SES configuration set name
	AccessKeyID      string
	SecretAccessKey  string
}

// SESClient wraps the AWS SES v2 SDK and satisfies email.Sender.
type SESClient struct {
	client *sesv2.Client
	cfg    SESConfig
}

// NewSES constructs a SESClient using the provided config.
// When AccessKeyID/SecretAccessKey are both set, a static credential provider
// is used; otherwise the SDK's default chain (env, file, IMDSv2) is used.
func NewSES(ctx context.Context, cfg SESConfig) (*SESClient, error) {
	if cfg.Region == "" {
		return nil, errors.New("ses: AWS_REGION is required")
	}

	var loadOpts []func(*awsconfig.LoadOptions) error
	loadOpts = append(loadOpts, awsconfig.WithRegion(cfg.Region))

	if cfg.AccessKeyID != "" && cfg.SecretAccessKey != "" {
		provider := credentials.NewStaticCredentialsProvider(
			cfg.AccessKeyID, cfg.SecretAccessKey, "",
		)
		loadOpts = append(loadOpts, awsconfig.WithCredentialsProvider(provider))
	}

	awsCfg, err := awsconfig.LoadDefaultConfig(ctx, loadOpts...)
	if err != nil {
		return nil, fmt.Errorf("ses: load aws config: %w", err)
	}

	return &SESClient{
		client: sesv2.NewFromConfig(awsCfg),
		cfg:    cfg,
	}, nil
}

// Send delivers msg via Amazon SES.  The From address is taken from msg.From
// when set, falling back to the configured default.  The returned provider
// MessageId is discarded here; the outbox worker captures it via the store
// after calling the underlying SES transport directly.
func (c *SESClient) Send(ctx context.Context, msg Message) error {
	_, err := c.sendRaw(ctx, msg)
	return err
}

// SendWithID delivers msg and returns the SES MessageId on success.  The
// mailout worker calls this when it needs to persist the provider message id.
func (c *SESClient) SendWithID(ctx context.Context, msg Message) (string, error) {
	return c.sendRaw(ctx, msg)
}

func (c *SESClient) sendRaw(ctx context.Context, msg Message) (string, error) {
	from := msg.From
	if from == "" {
		from = c.cfg.From
	}
	if from == "" {
		return "", errors.New("ses: missing from address")
	}
	if msg.To == "" {
		return "", errors.New("ses: missing to address")
	}

	input := buildSendInput(from, msg, c.cfg.ConfigurationSet)

	out, err := c.client.SendEmail(ctx, input)
	if err != nil {
		return "", fmt.Errorf("ses: send email: %w", err)
	}
	if out.MessageId != nil {
		return *out.MessageId, nil
	}
	return "", nil
}

// buildSendInput constructs the SES v2 SendEmailInput from a Message.
// It is a pure function so it can be tested without an AWS client.
func buildSendInput(from string, msg Message, configurationSet string) *sesv2.SendEmailInput {
	body := &sestypes.Body{}
	if msg.HTML != "" {
		body.Html = &sestypes.Content{Data: aws.String(msg.HTML)}
	}
	if msg.Text != "" {
		body.Text = &sestypes.Content{Data: aws.String(msg.Text)}
	}

	content := &sestypes.EmailContent{
		Simple: &sestypes.Message{
			Subject: &sestypes.Content{Data: aws.String(msg.Subject)},
			Body:    body,
		},
	}

	input := &sesv2.SendEmailInput{
		FromEmailAddress: aws.String(from),
		Destination: &sestypes.Destination{
			ToAddresses: []string{msg.To},
		},
		Content: content,
	}

	if configurationSet != "" {
		input.ConfigurationSetName = aws.String(configurationSet)
	}

	return input
}

// IsTransient reports whether err is a transient SES/network failure that
// warrants a retry.  Throttling, internal service errors, and network/timeout
// errors are transient.  Permanent errors (bad address, suspended account,
// rejected message, unverified domain) return false.
func IsTransient(err error) bool {
	if err == nil {
		return false
	}

	// SES throttling — retry.
	var tooMany *sestypes.TooManyRequestsException
	if errors.As(err, &tooMany) {
		return true
	}

	// SES internal server error — retry.
	var internalErr *sestypes.InternalServiceErrorException
	if errors.As(err, &internalErr) {
		return true
	}

	// Account temporarily paused — treat as transient; admin can unpause.
	var paused *sestypes.SendingPausedException
	if errors.As(err, &paused) {
		return true
	}

	// Permanent SES client errors — do not retry.
	var accountSuspended *sestypes.AccountSuspendedException
	if errors.As(err, &accountSuspended) {
		return false
	}

	var msgRejected *sestypes.MessageRejected
	if errors.As(err, &msgRejected) {
		return false
	}

	var domainNotVerified *sestypes.MailFromDomainNotVerifiedException
	if errors.As(err, &domainNotVerified) {
		return false
	}

	var badRequest *sestypes.BadRequestException
	if errors.As(err, &badRequest) {
		return false
	}

	// Network errors (DNS, connection refused, timeout) are transient.
	var netErr net.Error
	if errors.As(err, &netErr) {
		return true
	}

	var urlErr *url.Error
	if errors.As(err, &urlErr) {
		return true
	}

	// Unknown errors default to transient so they get a retry.
	return true
}
