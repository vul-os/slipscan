package db

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
)

func Open(ctx context.Context, dsn string) (*sql.DB, error) {
	d, err := sql.Open("pgx", dsn)
	if err != nil {
		return nil, fmt.Errorf("sql.Open: %w", err)
	}
	d.SetMaxOpenConns(25)
	d.SetMaxIdleConns(5)
	d.SetConnMaxLifetime(30 * time.Minute)

	pingCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := d.PingContext(pingCtx); err != nil {
		_ = d.Close()
		return nil, fmt.Errorf("ping: %w", err)
	}
	return d, nil
}
