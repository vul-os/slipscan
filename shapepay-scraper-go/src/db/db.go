package db

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v4/pgxpool"
)

const (
	dbURL = "user=postgres.wmpyolgckopmwhhlaiye password=***REMOVED*** host=aws-0-eu-central-1.pooler.supabase.com port=6543 dbname=postgres"
)

var Pool *pgxpool.Pool

func InitDB() error {
	config, err := pgxpool.ParseConfig(dbURL)
	if err != nil {
		return fmt.Errorf("unable to parse database URL: %w", err)
	}

	// Configure the pool to prefer simple protocol
	config.ConnConfig.PreferSimpleProtocol = true

	// Connect to the database
	Pool, err = pgxpool.ConnectConfig(context.Background(), config)
	if err != nil {
		return fmt.Errorf("unable to connect to database: %w", err)
	}

	return nil
}

func CloseDB() {
	if Pool != nil {
		Pool.Close()
	}
}
