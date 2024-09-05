package main

import (
	"log"
	"time"
)

const (
	MaxInactiveTime    = 10 * time.Minute
	RestartDelay       = 5 * time.Minute
	JobMonitorInterval = 1 * time.Minute
	AccountFetchRetry  = 1 * time.Minute
	IterationInterval  = 1 * time.Second
	InitialRetryDelay  = 2 * time.Minute
	MaxRetryDelay      = 10 * time.Minute
)

func main() {
	if err := initDB(); err != nil {
		log.Fatalf("Failed to initialize database: %v", err)
	}
	defer dbPool.Close()

	jobManager := NewJobManager()
	go jobManager.MonitorJobs()

	maxConcurrentAccounts := 10 // Adjust as needed

	Run(jobManager, maxConcurrentAccounts)
}
