package auth

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
)

var ErrUserNotFound = errors.New("user not found")
var ErrEmailTaken = errors.New("email already in use")

type User struct {
	ID              uuid.UUID
	Email           string
	PasswordHash    string
	FullName        sql.NullString
	AvatarURL       sql.NullString
	EmailVerifiedAt sql.NullTime
	LastLoginAt     sql.NullTime
	CreatedAt       time.Time
	UpdatedAt       time.Time
}

type Store struct {
	db *sql.DB
}

func NewStore(db *sql.DB) *Store { return &Store{db: db} }

func (s *Store) Create(ctx context.Context, email, passwordHash, fullName string) (*User, error) {
	const q = `
		INSERT INTO users (email, password_hash, full_name)
		VALUES ($1, $2, NULLIF($3, ''))
		RETURNING id, email, password_hash, full_name, avatar_url,
		          email_verified_at, last_login_at, created_at, updated_at
	`
	row := s.db.QueryRowContext(ctx, q, email, passwordHash, fullName)
	u, err := scanUser(row)
	if err != nil {
		// pgx surfaces unique_violation as "23505" via SQLSTATE in the
		// error string. We do a lightweight match here to avoid taking a
		// hard dependency on pgx error types in this package.
		if isUniqueViolation(err) {
			return nil, ErrEmailTaken
		}
		return nil, err
	}
	return u, nil
}

func (s *Store) ByEmail(ctx context.Context, email string) (*User, error) {
	const q = `
		SELECT id, email, password_hash, full_name, avatar_url,
		       email_verified_at, last_login_at, created_at, updated_at
		FROM users
		WHERE email = $1
	`
	row := s.db.QueryRowContext(ctx, q, email)
	u, err := scanUser(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrUserNotFound
	}
	return u, err
}

func (s *Store) ByID(ctx context.Context, id uuid.UUID) (*User, error) {
	const q = `
		SELECT id, email, password_hash, full_name, avatar_url,
		       email_verified_at, last_login_at, created_at, updated_at
		FROM users
		WHERE id = $1
	`
	row := s.db.QueryRowContext(ctx, q, id)
	u, err := scanUser(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrUserNotFound
	}
	return u, err
}

func (s *Store) TouchLogin(ctx context.Context, id uuid.UUID) error {
	_, err := s.db.ExecContext(ctx, `UPDATE users SET last_login_at = NOW() WHERE id = $1`, id)
	return err
}

type scanner interface {
	Scan(dest ...any) error
}

func scanUser(row scanner) (*User, error) {
	var u User
	if err := row.Scan(
		&u.ID, &u.Email, &u.PasswordHash, &u.FullName, &u.AvatarURL,
		&u.EmailVerifiedAt, &u.LastLoginAt, &u.CreatedAt, &u.UpdatedAt,
	); err != nil {
		return nil, err
	}
	return &u, nil
}

func isUniqueViolation(err error) bool {
	if err == nil {
		return false
	}
	s := err.Error()
	// SQLSTATE 23505 is unique_violation. Match by string to avoid taking
	// a hard dependency on pgx error types in this package.
	return strings.Contains(s, "SQLSTATE 23505") || strings.Contains(s, "unique constraint")
}
