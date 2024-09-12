package main

import (
	"log"
	"time"

	"github.com/exolutionza/shapepay-scraper-go/src/core"
	"github.com/exolutionza/shapepay-scraper-go/src/db"
)

func main() {
	// Initialize the database
	if err := db.InitDB(); err != nil {
		log.Fatalf("Failed to initialize database: %v", err)
	}
	log.Println("Database initialized")

	config := core.Config{
		MaxJobDuration:    time.Hour * 3,
		HeartbeatInterval: time.Second * 10,
		IterationInterval: time.Second * 5,
		MaxInactivityTime: time.Minute * 3,
		RestartDelay:      time.Minute * 2,
		MaxExecutionTime:  time.Minute * 15,
		MaxBackoffTime:    time.Minute * 30,
	}

	scheduler := core.NewScheduler(config)

	// Start the job monitor
	go scheduler.MonitorJobs()

	// Load initial jobs
	err := scheduler.LoadJobs(2) // Load up to 10 jobs
	if err != nil {
		log.Fatalf("Failed to load jobs: %v", err)
	}

	// Run jobs continuously
	for {
		scheduler.RunNextJob()
		time.Sleep(time.Second) // Small delay to prevent tight loop
	}
}
