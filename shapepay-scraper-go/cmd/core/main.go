package main

import (
	"log"
	"time"

	"github.com/exolutionza/shapepay-scraper-go/src/core"
	"github.com/exolutionza/shapepay-scraper-go/src/db"
)

func main() {
	log.Println("Starting application")

	// Initialize the database
	if err := db.InitDB(); err != nil {
		log.Fatalf("Failed to initialize database: %v", err)
	}
	log.Println("Database initialized")

	config := core.Config{
		MaxConcurrentAccounts:  2,
		MaxInactivityDuration:  5 * time.Minute,
		ResetCooldownDuration:  5 * time.Minute,
		JobIterationInterval:   10 * time.Second,
		InitialJobDelay:        5 * time.Second,
		JobStatusCheckInterval: 30 * time.Second,
		JobMaxRuntime:          30 * time.Minute,
		MinTickerDuration:      1 * time.Second,
		JobMonitoringInterval:  5 * time.Second,
		MinJobStartDelay:       15 * time.Minute,
		MaxJobStartDelay:       45 * time.Minute,
	}

	log.Println("Creating JobManager")
	jobManager := core.NewJobManager(config)

	log.Println("Running JobManager")
	if err := jobManager.Run(); err != nil {
		log.Fatalf("Failed to run job manager: %v", err)
	}

	log.Println("Application completed")
}
