package main

import (
	"log"
	"time"

	"github.com/exolutionza/shapepay-scraper-go/src/core"
)

func main() {
	config := core.Config{
		MaxConcurrentAccounts: 2,
		MaxInactiveTime:       3 * time.Minute,
		RestartDelay:          3 * time.Minute,
		JobMonitorInterval:    1 * time.Minute,
		AccountFetchRetry:     1 * time.Minute,
		IterationInterval:     1 * time.Second,
		InitialRetryDelay:     2 * time.Minute,
		MaxRetryDelay:         10 * time.Minute,
		RandomResetInterval:   3 * time.Hour,
	}

	c := core.NewCore(config)

	if err := c.Init(); err != nil {
		log.Fatalf("Failed to initialize core: %v", err)
	}

	go c.MonitorJobs()

	c.Run()
}
