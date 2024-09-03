package core

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"io"
	"os"

	"github.com/go-rod/rod/lib/proto"
)

const (
	encryptionKey = "***REMOVED***"
	cookieFile    = "./cookies.json"
)

func Encrypt(plaintext string) ([]byte, error) {
	block, err := aes.NewCipher([]byte(encryptionKey))
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err = io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, err
	}
	return gcm.Seal(nonce, nonce, []byte(plaintext), nil), nil
}

func Decrypt(ciphertext []byte) (string, error) {
	block, err := aes.NewCipher([]byte(encryptionKey))
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	nonceSize := gcm.NonceSize()
	if len(ciphertext) < nonceSize {
		return "", fmt.Errorf("ciphertext too short")
	}
	nonce, ciphertext := ciphertext[:nonceSize], ciphertext[nonceSize:]
	plaintext, err := gcm.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		return "", err
	}
	return string(plaintext), nil
}

func LoadCookies() ([]*proto.NetworkCookieParam, error) {
	data, err := os.ReadFile(cookieFile)
	if err != nil {
		return nil, err
	}

	var cookies []*proto.NetworkCookieParam
	err = json.Unmarshal(data, &cookies)
	return cookies, err
}

func SaveCookies(cookies []*proto.NetworkCookie) error {
	data, err := json.Marshal(cookies)
	if err != nil {
		return err
	}
	return os.WriteFile(cookieFile, data, 0644)
}
