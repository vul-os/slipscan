package store

// Per-node identity. Every node generates an Ed25519 keypair on first run and
// keeps it in settings. The public key is exchanged and recorded on pairing
// (peers.pubkey), and op batches + snapshots are signed with the private key.
//
// This is groundwork: it makes replicated data attributable and tamper-evident.
// The sync transport still authenticates with the shared Bearer secret exactly
// as before — upgrading transport auth to these keys (mutual key auth instead
// of a shared secret) is a documented next step, not forced here.

import (
	"crypto"
	"crypto/ed25519"
	"database/sql"
	"encoding/hex"
)

// ensureIdentity loads this node's keypair from settings, generating one on a
// brand-new database. Called from Open.
func (s *Store) ensureIdentity() error {
	seedHex, err := s.getSetting("node_privkey")
	if err != nil {
		return err
	}
	if seedHex == "" {
		_, priv, err := ed25519.GenerateKey(nil)
		if err != nil {
			return err
		}
		seed := priv.Seed()
		if err := s.SetSetting("node_privkey", hex.EncodeToString(seed)); err != nil {
			return err
		}
		pub := priv.Public().(ed25519.PublicKey)
		if err := s.SetSetting("node_pubkey", hex.EncodeToString(pub)); err != nil {
			return err
		}
		s.priv = priv
		s.pub = pub
		return nil
	}
	seed, err := hex.DecodeString(seedHex)
	if err != nil || len(seed) != ed25519.SeedSize {
		return sql.ErrNoRows // corrupt; caller treats as fatal open error
	}
	s.priv = ed25519.NewKeyFromSeed(seed)
	s.pub = s.priv.Public().(ed25519.PublicKey)
	return nil
}

// PublicKeyHex is this node's Ed25519 public key, hex-encoded.
func (s *Store) PublicKeyHex() string {
	if s.pub == nil {
		return ""
	}
	return hex.EncodeToString(s.pub)
}

// Sign returns a hex Ed25519 signature over msg using this node's private key.
func (s *Store) Sign(msg []byte) string {
	if s.priv == nil {
		return ""
	}
	return hex.EncodeToString(ed25519.Sign(s.priv, msg))
}

// VerifySig checks a hex signature against a hex public key. An empty key or
// signature returns false.
func VerifySig(pubHex string, msg []byte, sigHex string) bool {
	if pubHex == "" || sigHex == "" {
		return false
	}
	pub, err := hex.DecodeString(pubHex)
	if err != nil || len(pub) != ed25519.PublicKeySize {
		return false
	}
	sig, err := hex.DecodeString(sigHex)
	if err != nil || len(sig) != ed25519.SignatureSize {
		return false
	}
	return ed25519.Verify(ed25519.PublicKey(pub), msg, sig)
}

// CryptoSigner exposes this node's identity as a crypto.Signer — a custodian
// that answers signature requests without surrendering the key.
//
// It is the shape the substrate sync binding takes (kotvasync.CryptoSigner), and
// deliberately the only shape: that binding accepts no key material at all, so
// FlowStock hands out signatures rather than a seed. Today the custodian is an
// in-process ed25519.PrivateKey; moving it to an HSM or agent later is a change
// here and at no call site.
func (s *Store) CryptoSigner() (crypto.Signer, bool) {
	if s.priv == nil {
		return nil, false
	}
	return s.priv, true
}

// PrivateSeedHexForTest exposes the private seed so tests can assert it never
// escapes through an API surface. It exists only to make a negative assertion
// checkable; nothing in the product calls it, and it must stay that way.
func (s *Store) PrivateSeedHexForTest() string {
	if s.priv == nil {
		return ""
	}
	return hex.EncodeToString(s.priv.Seed())
}
