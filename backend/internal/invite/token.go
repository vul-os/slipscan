package invite

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
)

// tokenBytes is the raw entropy size. 32 bytes = 256 bits, plenty for an
// invitation token that the user shouldn't be guessing.
const tokenBytes = 32

// GenerateToken produces a random URL-safe token (sent to the user) and
// the SHA-256 hex digest of that token (stored in the database). The
// plaintext token is never persisted — if the DB leaks, attackers can't
// redeem outstanding invitations.
func GenerateToken() (plain, hash string, err error) {
	buf := make([]byte, tokenBytes)
	if _, err := rand.Read(buf); err != nil {
		return "", "", err
	}
	plain = base64.RawURLEncoding.EncodeToString(buf)
	hash = HashToken(plain)
	return plain, hash, nil
}

func HashToken(plain string) string {
	sum := sha256.Sum256([]byte(plain))
	return hex.EncodeToString(sum[:])
}
