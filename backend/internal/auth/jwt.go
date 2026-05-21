package auth

import (
	"errors"
	"fmt"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
)

type TokenType string

const (
	TokenAccess  TokenType = "access"
	TokenRefresh TokenType = "refresh"
)

type Claims struct {
	UserID uuid.UUID `json:"uid"`
	Email  string    `json:"email,omitempty"`
	Type   TokenType `json:"typ"`
	jwt.RegisteredClaims
}

type Signer struct {
	secret     []byte
	accessTTL  time.Duration
	refreshTTL time.Duration
	issuer     string
}

func NewSigner(secret []byte, access, refresh time.Duration, issuer string) *Signer {
	return &Signer{secret: secret, accessTTL: access, refreshTTL: refresh, issuer: issuer}
}

type TokenPair struct {
	AccessToken      string    `json:"access_token"`
	RefreshToken     string    `json:"refresh_token"`
	AccessExpiresAt  time.Time `json:"access_expires_at"`
	RefreshExpiresAt time.Time `json:"refresh_expires_at"`
}

func (s *Signer) Issue(userID uuid.UUID, email string) (TokenPair, error) {
	now := time.Now()
	access, accessExp, err := s.sign(userID, email, TokenAccess, now, s.accessTTL)
	if err != nil {
		return TokenPair{}, err
	}
	refresh, refreshExp, err := s.sign(userID, "", TokenRefresh, now, s.refreshTTL)
	if err != nil {
		return TokenPair{}, err
	}
	return TokenPair{
		AccessToken:      access,
		RefreshToken:     refresh,
		AccessExpiresAt:  accessExp,
		RefreshExpiresAt: refreshExp,
	}, nil
}

func (s *Signer) sign(userID uuid.UUID, email string, typ TokenType, now time.Time, ttl time.Duration) (string, time.Time, error) {
	exp := now.Add(ttl)
	claims := Claims{
		UserID: userID,
		Email:  email,
		Type:   typ,
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:    s.issuer,
			Subject:   userID.String(),
			IssuedAt:  jwt.NewNumericDate(now),
			NotBefore: jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(exp),
			ID:        uuid.NewString(),
		},
	}
	t := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	signed, err := t.SignedString(s.secret)
	if err != nil {
		return "", time.Time{}, err
	}
	return signed, exp, nil
}

var ErrInvalidToken = errors.New("invalid token")

func (s *Signer) Parse(raw string, expect TokenType) (*Claims, error) {
	t, err := jwt.ParseWithClaims(raw, &Claims{}, func(t *jwt.Token) (any, error) {
		if t.Method.Alg() != jwt.SigningMethodHS256.Alg() {
			return nil, fmt.Errorf("unexpected signing method: %s", t.Method.Alg())
		}
		return s.secret, nil
	}, jwt.WithIssuer(s.issuer), jwt.WithLeeway(30*time.Second))
	if err != nil {
		return nil, errors.Join(ErrInvalidToken, err)
	}
	claims, ok := t.Claims.(*Claims)
	if !ok || !t.Valid {
		return nil, ErrInvalidToken
	}
	if claims.Type != expect {
		return nil, fmt.Errorf("%w: wrong token type", ErrInvalidToken)
	}
	if claims.UserID == uuid.Nil {
		return nil, fmt.Errorf("%w: missing user id", ErrInvalidToken)
	}
	return claims, nil
}
