package main

import (
	"log"
	"time"

	"github.com/exolutionza/shapepay-scraper-go/src/core"
)

func main() {
	config := core.Config{
		MaxConcurrentAccounts:   2,
		MaxInactiveTime:         5 * time.Minute,
		RestartDelay:            5 * time.Minute,
		JobMonitorInterval:      1 * time.Minute,
		AccountFetchRetry:       1 * time.Minute,
		IterationInterval:       1 * time.Second,
		InitialRetryDelay:       3 * time.Minute,
		MaxRetryDelay:           10 * time.Minute,
		MinRandomResetInterval:  3 * time.Hour,
		MaxRandomResetInterval:  4 * time.Hour,
		InitialRandomResetDelay: 3 * time.Minute,
		MaxRandomResetDelay:     10 * time.Minute,
		MinJobStartDelay:        3 * time.Minute,
		InitialJobStartDelay:    10 * time.Minute,
	}

	c := core.NewCore(config)

	if err := c.Init(); err != nil {
		log.Fatalf("Failed to initialize core: %v", err)
	}

	c.Run()
}
