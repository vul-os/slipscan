package core

import (
	"fmt"
	"log"
	"math/rand"
	"runtime/debug"
	"sync"
	"time"

	"github.com/go-rod/rod"
	"github.com/google/uuid"
)

// AccountScraper handles the scraping process for an individual account
type AccountScraper struct {
	account      Account
	browser      *rod.Browser
	page         *rod.Page
	lastActivity time.Time
	stopChan     chan struct{}
}

// Config holds all configurable time constants
type Config struct {
	MaxInactivityDuration  time.Duration
	ResetCooldownDuration  time.Duration
	JobIterationInterval   time.Duration
	InitialJobDelay        time.Duration
	JobStatusCheckInterval time.Duration
	JobMaxRuntime          time.Duration
	MinTickerDuration      time.Duration
	JobMonitoringInterval  time.Duration
	MaxConcurrentAccounts  int
	MinJobStartDelay       time.Duration
	MaxJobStartDelay       time.Duration
}

// Job represents an individual account scraping job
type Job struct {
	account       Account
	scraper       *AccountScraper
	isRunning     bool
	resetCooldown time.Time
	startTime     time.Time
}

// JobManager manages the execution of account scraping jobs
type JobManager struct {
	config Config
	jobs   map[uuid.UUID]*Job
	mutex  sync.Mutex
	wg     sync.WaitGroup
}

// NewJobManager creates a new JobManager with the given configuration
func NewJobManager(config Config) *JobManager {
	log.Println("Creating new JobManager")
	return &JobManager{
		config: config,
		jobs:   make(map[uuid.UUID]*Job),
	}
}

// Run retrieves available accounts and starts running jobs for each account
func (jm *JobManager) Run() error {
	log.Println("JobManager Run started")
	accounts, err := getAvailableAccounts(jm.config.MaxConcurrentAccounts)
	if err != nil {
		return fmt.Errorf("failed to get available accounts: %w", err)
	}
	log.Printf("Retrieved %d accounts", len(accounts))

	for _, account := range accounts {
		jm.AddJob(account)
	}

	log.Println("Starting job monitor")
	go jm.monitorJobs()

	log.Println("Starting jobs")
	jm.Start()

	log.Println("Waiting for jobs to complete")
	jm.Wait()

	log.Println("JobManager Run completed")
	return nil
}

// AddJob adds a new job to the manager
func (jm *JobManager) AddJob(account Account) {
	jm.mutex.Lock()
	defer jm.mutex.Unlock()

	if _, exists := jm.jobs[account.BankAccountID]; !exists {
		log.Printf("Adding job for account %s", account.BankAccountID)
		jm.jobs[account.BankAccountID] = &Job{
			account: account,
			scraper: NewAccountScraper(account),
		}
	}
}

// Start begins running all jobs with random delays
func (jm *JobManager) Start() {
	isFirst := true
	for id, job := range jm.jobs {
		jm.wg.Add(1)
		if isFirst {
			log.Printf("Starting first job for account %s immediately", id)
			go jm.runJob(id, job)
			isFirst = false
		} else {
			delay := randomDuration(jm.config.MinJobStartDelay, jm.config.MaxJobStartDelay)
			log.Printf("Scheduling job for account %s with delay %v", id, delay)
			go func(id uuid.UUID, job *Job, delay time.Duration) {
				time.Sleep(delay)
				jm.runJob(id, job)
			}(id, job, delay)
		}
	}
}

// Wait waits for all jobs to complete
func (jm *JobManager) Wait() {
	jm.wg.Wait()
}

func (jm *JobManager) monitorJobs() {
	log.Println("Job monitor started")
	tickerDuration := jm.config.JobMonitoringInterval
	if tickerDuration < jm.config.MinTickerDuration {
		tickerDuration = jm.config.MinTickerDuration
	}
	ticker := time.NewTicker(tickerDuration)
	defer ticker.Stop()

	for range ticker.C {
		jm.mutex.Lock()
		for id, job := range jm.jobs {
			if job.isRunning && time.Since(job.scraper.lastActivity) > jm.config.MaxInactivityDuration {
				log.Printf("Job %s has hung. Resetting...", id)
				job.scraper.Reset()
				job.isRunning = false
				job.resetCooldown = time.Now()
			}
		}
		jm.mutex.Unlock()
	}
}

func (jm *JobManager) runJob(id uuid.UUID, job *Job) {
	defer jm.wg.Done()
	defer jm.recoverFromPanic(id)

	log.Printf("Job %s: Initial delay of %v", id, jm.config.InitialJobDelay)
	time.Sleep(jm.config.InitialJobDelay)

	for {
		if !job.isRunning && time.Since(job.resetCooldown) > jm.config.ResetCooldownDuration {
			job.isRunning = true
			job.startTime = time.Now()
			job.scraper.lastActivity = time.Now()
			log.Printf("Job %s: Starting execution", id)
			go jm.executeJob(id, job)
		}

		time.Sleep(jm.config.JobStatusCheckInterval)
	}
}

func (jm *JobManager) executeJob(id uuid.UUID, job *Job) {
	defer func() {
		job.isRunning = false
		job.resetCooldown = time.Now()
	}()
	defer jm.recoverFromPanic(id)

	log.Printf("Starting job execution for account %s", id)

	done := make(chan bool)
	go func() {
		defer jm.recoverFromPanic(id)
		for {
			log.Printf("Job %s: Running account", id)
			err := runAccount(job.scraper, jm.config.JobIterationInterval)
			if err != nil {
				log.Printf("Error in job %s: %v", id, err)
			}

			job.scraper.lastActivity = time.Now()
			log.Printf("Job %s: Updated lastActivity", id)

			if time.Since(job.startTime) >= jm.config.JobMaxRuntime {
				log.Printf("Job %s has reached max runtime. Resetting...", id)
				break
			}

			log.Printf("Job %s: Sleeping for %v", id, jm.config.JobIterationInterval)
			time.Sleep(jm.config.JobIterationInterval)
		}
		done <- true
	}()

	select {
	case <-done:
		log.Printf("Job completed for account %s", id)
	case <-time.After(jm.config.MaxInactivityDuration):
		log.Printf("Job %s has hung. Resetting...", id)
		job.scraper.Reset()
	}
}

func (jm *JobManager) recoverFromPanic(id uuid.UUID) {
	if r := recover(); r != nil {
		log.Printf("Recovered from panic in job %s: %v\nStack Trace:\n%s", id, r, debug.Stack())
	}
}

// NewAccountScraper creates a new AccountScraper
func NewAccountScraper(account Account) *AccountScraper {
	return &AccountScraper{
		account:      account,
		lastActivity: time.Now(),
		stopChan:     make(chan struct{}),
	}
}

// Reset resets the AccountScraper
func (as *AccountScraper) Reset() {
	if as.browser != nil {
		as.browser.Close()
	}
	as.browser = nil
	as.page = nil
	close(as.stopChan)
	as.stopChan = make(chan struct{})
	as.lastActivity = time.Now()
}

// randomDuration returns a random duration between min and max
func randomDuration(min, max time.Duration) time.Duration {
	if min >= max {
		return min
	}
	return min + time.Duration(rand.Int63n(int64(max-min)))
}
