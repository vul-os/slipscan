// Package storage wraps an S3-compatible object store. The S3 endpoint and
// region come from config so the same code can target Backblaze B2, AWS S3,
// or any other S3-compatible service.
package storage

import (
	"bytes"
	"context"
	"fmt"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

type Config struct {
	KeyID          string
	ApplicationKey string
	Bucket         string
	Region         string
	Endpoint       string
}

type Client struct {
	s3        *s3.Client
	presigner *s3.PresignClient
	bucket    string
}

func New(cfg Config) (*Client, error) {
	if cfg.KeyID == "" || cfg.ApplicationKey == "" || cfg.Bucket == "" || cfg.Endpoint == "" {
		return nil, fmt.Errorf("storage: missing required config")
	}
	creds := credentials.NewStaticCredentialsProvider(cfg.KeyID, cfg.ApplicationKey, "")
	awsCfg := aws.Config{Region: cfg.Region, Credentials: creds}

	client := s3.NewFromConfig(awsCfg, func(o *s3.Options) {
		o.BaseEndpoint = aws.String(cfg.Endpoint)
		o.UsePathStyle = true
	})
	return &Client{
		s3:        client,
		presigner: s3.NewPresignClient(client),
		bucket:    cfg.Bucket,
	}, nil
}

func (c *Client) Put(ctx context.Context, key string, data []byte, contentType string) error {
	_, err := c.s3.PutObject(ctx, &s3.PutObjectInput{
		Bucket:      aws.String(c.bucket),
		Key:         aws.String(key),
		Body:        bytes.NewReader(data),
		ContentType: aws.String(contentType),
	})
	if err != nil {
		return fmt.Errorf("storage put %s: %w", key, err)
	}
	return nil
}

// PresignGet returns a time-limited URL the client can use to GET the object
// directly from B2 without proxying through our backend.
func (c *Client) PresignGet(ctx context.Context, key string, expires time.Duration) (string, error) {
	out, err := c.presigner.PresignGetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(c.bucket),
		Key:    aws.String(key),
	}, s3.WithPresignExpires(expires))
	if err != nil {
		return "", fmt.Errorf("storage presign %s: %w", key, err)
	}
	return out.URL, nil
}

func (c *Client) Delete(ctx context.Context, key string) error {
	_, err := c.s3.DeleteObject(ctx, &s3.DeleteObjectInput{
		Bucket: aws.String(c.bucket),
		Key:    aws.String(key),
	})
	if err != nil {
		return fmt.Errorf("storage delete %s: %w", key, err)
	}
	return nil
}
