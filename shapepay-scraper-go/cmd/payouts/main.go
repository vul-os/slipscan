package payouts_main

import (
	"context"
	"fmt"

	"github.com/exolutionza/shapepay-scraper-go/src/payouts"
	"github.com/jackc/pgx/v4/pgxpool"
)

func main() {
	// Create a connection pool
	ctx := context.Background()
	pool, err := pgxpool.Connect(ctx, "postgres://username:password@localhost/dbname")
	if err != nil {
		fmt.Printf("Error connecting to the database: %v\n", err)
		return
	}
	defer pool.Close()

	// Call the function to generate the CSV
	outputDir := "." // Current directory
	filePath, err := payouts.GenerateFNBCSV(ctx, pool, outputDir)
	if err != nil {
		fmt.Printf("Error generating CSV: %v\n", err)
		return
	}

	fmt.Printf("CSV file generated successfully: %s\n", filePath)
}
