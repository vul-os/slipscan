package main

import (
	"context"
	"log"
	"time"

	"github.com/exolutionza/shapepay-scraper-go/src/core"
	"github.com/exolutionza/shapepay-scraper-go/src/db"
)

func main() {
	config := core.Config{
		MinInitialDelay:   20 * time.Minute,
		MaxInitialDelay:   50 * time.Minute,
		MinResetInterval:  3 * time.Hour,
		MaxResetInterval:  4 * time.Hour,
		HeartbeatTimeout:  5 * time.Minute,
		IterationInterval: 1 * time.Second,
		PostResetDelay:    2 * time.Minute,
		AccountLimit:      2,
	}

	// Initialize the database
	if err := db.InitDB(); err != nil {
		log.Fatalf("Failed to initialize database: %v", err)
	}
	log.Println("Database initialized")

	scraper := core.NewParallelScraper(config)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	if err := scraper.Run(ctx); err != nil {
		log.Fatalf("Scraper error: %v", err)
	}
}
