package main

import (
	"log"
	"sync"
	"time"

	"github.com/go-rod/rod"
)

const (
	maxConcurrentAccounts = 2
	maxInactiveTime       = 60 * time.Second
	mainLoopInterval      = 5 * time.Second
	iterationInterval     = 1 * time.Second
)

type accountScraper struct {
	account      Account
	browser      *rod.Browser
	page         *rod.Page
	lastActivity time.Time
}

type Job struct {
	ID          string
	Scraper     *accountScraper
	Timeout     time.Duration
	Interval    time.Duration
	MaxInactive time.Duration
}

type JobManager struct {
	jobs     map[string]*Job
	stopChan chan struct{}
	wg       sync.WaitGroup
	mu       sync.Mutex
}

func NewJobManager() *JobManager {
	return &JobManager{
		jobs:     make(map[string]*Job),
		stopChan: make(chan struct{}),
	}
}

func (jm *JobManager) AddJob(job *Job) {
	jm.mu.Lock()
	defer jm.mu.Unlock()
	jm.jobs[job.ID] = job
}

func (jm *JobManager) Start() {
	for _, job := range jm.jobs {
		jm.wg.Add(1)
		go jm.runJob(job)
	}
}

func (jm *JobManager) Stop() {
	close(jm.stopChan)
	jm.wg.Wait()
}

func (jm *JobManager) runJob(job *Job) {
	defer jm.wg.Done()
	for {
		select {
		case <-jm.stopChan:
			return
		default:
			if time.Since(job.Scraper.lastActivity) > job.MaxInactive {
				log.Printf("Job %s (Account: %s) has been inactive for too long, restarting...", job.ID, job.Scraper.account.Username)
				job.Scraper.lastActivity = time.Now()
			}

			done := make(chan bool)
			go func() {
				err := runAccount(job.Scraper)
				if err != nil {
					log.Printf("Job %s (Account: %s) error: %v", job.ID, job.Scraper.account.Username, err)
				}
				done <- true
			}()

			select {
			case <-done:
				job.Scraper.lastActivity = time.Now()
			case <-time.After(job.Timeout):
				log.Printf("Job %s (Account: %s) timed out, restarting...", job.ID, job.Scraper.account.Username)
			}

			time.Sleep(job.Interval)
		}
	}
}

func main() {
	if err := initDB(); err != nil {
		log.Fatalf("Failed to initialize database: %v", err)
	}
	defer dbPool.Close()

	jobManager := NewJobManager()

	for {
		accounts, err := getAvailableAccounts(maxConcurrentAccounts)
		if err != nil {
			log.Printf("Error getting available accounts: %v. Retrying in 1 minute.", err)
			time.Sleep(1 * time.Minute)
			continue
		}

		for _, account := range accounts {
			scraper := &accountScraper{
				account:      account,
				lastActivity: time.Now(),
			}

			job := &Job{
				ID:          account.ID,
				Scraper:     scraper,
				Timeout:     5 * time.Minute,
				Interval:    iterationInterval,
				MaxInactive: maxInactiveTime,
			}

			jobManager.AddJob(job)
		}

		jobManager.Start()

		// Wait for some time before checking for new accounts
		time.Sleep(15 * time.Minute)

		// Stop all jobs
		jobManager.Stop()

		// Clear the jobs for the next iteration
		jobManager = NewJobManager()
	}
}
