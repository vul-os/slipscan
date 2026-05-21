package auth

import (
	"errors"
	"unicode/utf8"

	"golang.org/x/crypto/bcrypt"
)

const (
	bcryptCost   = 12
	minPwLen     = 8
	maxPwLen     = 256
	bcryptMaxLen = 72
)

var (
	ErrPasswordTooShort = errors.New("password must be at least 8 characters")
	ErrPasswordTooLong  = errors.New("password is too long")
)

func HashPassword(plain string) (string, error) {
	if utf8.RuneCountInString(plain) < minPwLen {
		return "", ErrPasswordTooShort
	}
	if len(plain) > maxPwLen {
		return "", ErrPasswordTooLong
	}
	if len(plain) > bcryptMaxLen {
		return "", ErrPasswordTooLong
	}
	h, err := bcrypt.GenerateFromPassword([]byte(plain), bcryptCost)
	if err != nil {
		return "", err
	}
	return string(h), nil
}

func VerifyPassword(hash, plain string) bool {
	if len(plain) > bcryptMaxLen {
		return false
	}
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(plain)) == nil
}
