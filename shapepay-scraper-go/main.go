package main

import (
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/go-rod/rod"
)

const (
	MaxInactiveTime    = 10 * time.Minute
	RestartDelay       = 5 * time.Minute
	JobMonitorInterval = 1 * time.Minute
	AccountFetchRetry  = 1 * time.Minute
	IterationInterval  = 1 * time.Second
	InitialRetryDelay  = 1 * time.Minute
	MaxRetryDelay      = 10 * time.Minute
)

type AccountScraper struct {
	account      Account
	browser      *rod.Browser
	page         *rod.Page
	lastActivity time.Time
	stopChan     chan struct{}
}

type Job struct {
	ID       string
	Scraper  *AccountScraper
	StopChan chan struct{}
}

type JobManager struct {
	Jobs     map[string]*Job
	JobMutex sync.Mutex
}

func NewJobManager() *JobManager {
	return &JobManager{
		Jobs: make(map[string]*Job),
	}
}

func (jm *JobManager) AddJob(job *Job) {
	jm.JobMutex.Lock()
	defer jm.JobMutex.Unlock()
	jm.Jobs[job.ID] = job
}

func (jm *JobManager) Start() {
	for _, job := range jm.Jobs {
		go jm.runJob(job)
	}
}

func (jm *JobManager) runJob(job *Job) {
	retryDelay := InitialRetryDelay
	for {
		select {
		case <-job.StopChan:
			log.Printf("Job for account %s stopped", job.Scraper.account.Username)
			return
		default:
			done := make(chan struct{})
			var err error

			go func() {
				defer func() {
					if r := recover(); r != nil {
						log.Printf("Recovered from panic in runAccount for account %s: %v", job.Scraper.account.Username, r)
						err = fmt.Errorf("panic in runAccount: %v", r)
					}
					close(done)
				}()

				err = runAccount(job.Scraper)
			}()

			<-done

			if err != nil {
				log.Printf("Error running account %s: %v. Retrying in %v", job.Scraper.account.Username, err, retryDelay)
				time.Sleep(retryDelay)

				// Increase retry delay
				retryDelay += time.Minute
				if retryDelay > MaxRetryDelay {
					retryDelay = MaxRetryDelay
				}
			} else {
				// Reset retry delay on successful run
				retryDelay = InitialRetryDelay
			}
		}
	}
}

func (jm *JobManager) MonitorJobs() {
	for {
		time.Sleep(JobMonitorInterval)
		jm.JobMutex.Lock()
		for _, job := range jm.Jobs {
			if time.Since(job.Scraper.lastActivity) > MaxInactiveTime {
				log.Printf("Job for account %s seems to be hanging. Forcing stop and scheduling restart...", job.Scraper.account.Username)

				forceStopJob(job)
				close(job.StopChan)

				newStopChan := make(chan struct{})
				job.StopChan = newStopChan

				go func(j *Job) {
					time.Sleep(RestartDelay)
					log.Printf("Restarting job for account %s", j.Scraper.account.Username)
					jm.runJob(j)
				}(job)
			}
		}
		jm.JobMutex.Unlock()
	}
}

func forceStopJob(job *Job) {
	if job.Scraper.browser != nil {
		job.Scraper.browser.MustClose()
		job.Scraper.browser = nil
	}
	job.Scraper.page = nil
	job.Scraper.lastActivity = time.Now()
	log.Printf("Forced stop of job %s (Account: %s)", job.ID, job.Scraper.account.Username)
}

func main() {
	if err := initDB(); err != nil {
		log.Fatalf("Failed to initialize database: %v", err)
	}
	defer dbPool.Close()

	jobManager := NewJobManager()
	go jobManager.MonitorJobs()

	maxConcurrentAccounts := 10 // Adjust as needed

	for {
		accounts, err := getAvailableAccounts(maxConcurrentAccounts)
		if err != nil {
			log.Printf("Error getting available accounts: %v. Retrying in %v.", err, AccountFetchRetry)
			time.Sleep(AccountFetchRetry)
			continue
		}

		for _, account := range accounts {
			scraper := &AccountScraper{
				account:      account,
				lastActivity: time.Now(),
				stopChan:     make(chan struct{}),
			}

			job := &Job{
				ID:       fmt.Sprintf("job-%s", account.ID),
				Scraper:  scraper,
				StopChan: scraper.stopChan,
			}

			jobManager.AddJob(job)
		}

		jobManager.Start()

		// Run indefinitely
		select {}
	}
}
