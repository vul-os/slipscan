package main

import (
	"log"

	"github.com/exolutionza/shapepay-scraper-go/src/db"
	"github.com/exolutionza/shapepay-scraper-go/src/payout"
)

func main() {
	// Initialize the database connection
	if err := db.InitDB(); err != nil {
		log.Fatalf("Failed to initialize database: %v", err)
	}
	defer db.CloseDB()

	// Call the function to generate CSV
	if err := payout.GenerateCSV(); err != nil {
		log.Fatalf("Failed to generate CSV: %v", err)
	}
}
