package main_core

import (
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/exolutionza/shapepay-scraper-go/src/core"
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

const (
	url = "https://fnb.co.za"
)

type Job struct {
	ID       string
	Scraper  *core.AccountScraper
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
			log.Printf("Job for account %s stopped", job.Scraper.Account.Username)
			return
		default:
			done := make(chan struct{})
			var err error

			go func() {
				defer func() {
					if r := recover(); r != nil {
						log.Printf("Recovered from panic in runAccount for account %s: %v", job.Scraper.Account.Username, r)
						err = fmt.Errorf("panic in runAccount: %v", r)
					}
					close(done)
				}()

				err = core.RunAccount(job.Scraper, IterationInterval, url)
			}()

			<-done

			if err != nil {
				log.Printf("Error running account %s: %v. Retrying in %v", job.Scraper.Account.Username, err, retryDelay)
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
			if time.Since(job.Scraper.LastActivity) > MaxInactiveTime {
				log.Printf("Job for account %s seems to be hanging. Forcing stop and scheduling restart...", job.Scraper.Account.Username)

				forceStopJob(job)
				close(job.StopChan)

				newStopChan := make(chan struct{})
				job.StopChan = newStopChan

				go func(j *Job) {
					time.Sleep(RestartDelay)
					log.Printf("Restarting job for account %s", j.Scraper.Account.Username)
					jm.runJob(j)
				}(job)
			}
		}
		jm.JobMutex.Unlock()
	}
}

func forceStopJob(job *Job) {
	if job.Scraper.Browser != nil {
		job.Scraper.Browser.MustClose()
		job.Scraper.Browser = nil
	}
	job.Scraper.Page = nil
	job.Scraper.LastActivity = time.Now()
	log.Printf("Forced stop of job %s (Account: %s)", job.ID, job.Scraper.Account.Username)
}

func main() {
	dbPool, err := core.InitDB()

	if err != nil {
		log.Fatalf("Failed to initialize database: %v", err)
	}
	defer dbPool.Close()

	jobManager := NewJobManager()
	go jobManager.MonitorJobs()

	maxConcurrentAccounts := 10 // Adjust as needed

	for {
		accounts, err := core.GetAvailableAccounts(maxConcurrentAccounts)
		if err != nil {
			log.Printf("Error getting available accounts: %v. Retrying in %v.", err, AccountFetchRetry)
			time.Sleep(AccountFetchRetry)
			continue
		}

		for _, account := range accounts {
			scraper := &core.AccountScraper{
				Account:      account,
				LastActivity: time.Now(),
				StopChan:     make(chan struct{}),
			}

			job := &Job{
				ID:       fmt.Sprintf("job-%s", account.ID),
				Scraper:  scraper,
				StopChan: scraper.StopChan,
			}

			jobManager.AddJob(job)
		}

		jobManager.Start()

		// Run indefinitely
		select {}
	}
}
