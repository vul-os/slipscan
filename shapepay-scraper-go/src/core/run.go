package core

import (
	"container/list"
	"fmt"
	"sync"
	"time"

	"github.com/go-rod/rod"
	"github.com/google/uuid"
)

type Config struct {
	MaxJobDuration    time.Duration
	HeartbeatInterval time.Duration
	IterationInterval time.Duration
	MaxInactivityTime time.Duration
	RestartDelay      time.Duration
	MaxExecutionTime  time.Duration
	MaxBackoffTime    time.Duration
}

type Account struct {
	ID            string
	BankAccountID uuid.UUID
	Username      string
	Password      string
}

type AccountScraper struct {
	Account      Account
	Browser      *rod.Browser
	Page         *rod.Page
	LastActivity time.Time
	StopChan     chan struct{}
}

type Job struct {
	ID              string
	AccountID       string
	Priority        int
	StartTime       time.Time
	Scraper         *AccountScraper
	FailureCount    int
	LastFailureTime time.Time
}

type Scheduler struct {
	jobs        *list.List
	runningJobs map[string]*list.Element
	accountJobs map[string]*list.Element
	mu          sync.Mutex
	config      Config
}

func NewScheduler(config Config) *Scheduler {
	return &Scheduler{
		jobs:        list.New(),
		runningJobs: make(map[string]*list.Element),
		accountJobs: make(map[string]*list.Element),
		config:      config,
	}
}

func (s *Scheduler) AddJob(job *Job) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if existingJob, exists := s.accountJobs[job.AccountID]; exists {
		s.jobs.Remove(existingJob)
	}
	elem := s.jobs.PushBack(job)
	s.accountJobs[job.AccountID] = elem
}

func (s *Scheduler) UpdateHeartbeat(jobID string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if elem, exists := s.runningJobs[jobID]; exists {
		job := elem.Value.(*Job)
		job.Scraper.LastActivity = time.Now()
	}
}

func (s *Scheduler) cleanupJob(job *Job) {
	if job.Scraper.Browser != nil {
		job.Scraper.Browser.Close()
	}
	job.Scraper.Browser = nil
	job.Scraper.Page = nil
}

func (s *Scheduler) requeueJob(job *Job) {
	if job.FailureCount > 0 {
		backoffTime := time.Duration(job.FailureCount) * time.Minute
		if backoffTime > s.config.MaxBackoffTime {
			backoffTime = s.config.MaxBackoffTime
		}
		time.AfterFunc(backoffTime, func() {
			s.AddJob(job)
		})
	} else {
		time.AfterFunc(s.config.RestartDelay, func() {
			s.AddJob(job)
		})
	}
}

func (s *Scheduler) MonitorJobs() {
	ticker := time.NewTicker(s.config.HeartbeatInterval)
	defer ticker.Stop()

	for range ticker.C {
		s.mu.Lock()
		now := time.Now()
		for id, elem := range s.runningJobs {
			job := elem.Value.(*Job)
			if now.Sub(job.Scraper.LastActivity) > s.config.MaxInactivityTime {
				fmt.Printf("Job %s has been inactive for too long. Stopping and rescheduling...\n", id)
				job.Scraper.StopChan <- struct{}{}
				s.cleanupJob(job)
				delete(s.runningJobs, id)
				s.requeueJob(job)
			} else if now.Sub(job.StartTime) > s.config.MaxJobDuration {
				fmt.Printf("Job %s has exceeded max duration. Stopping and rescheduling...\n", id)
				job.Scraper.StopChan <- struct{}{}
				s.cleanupJob(job)
				delete(s.runningJobs, id)
				s.requeueJob(job)
			}
		}
		s.mu.Unlock()

		// Run next job to ensure continuous processing
		s.RunNextJob()
	}
}

func (s *Scheduler) RunNextJob() {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.jobs.Len() == 0 {
		return
	}

	elem := s.jobs.Front()
	job := elem.Value.(*Job)
	s.jobs.Remove(elem)
	delete(s.accountJobs, job.AccountID)
	s.runningJobs[job.ID] = elem

	go func() {
		job.StartTime = time.Now()
		job.Scraper.LastActivity = time.Now()

		done := make(chan error)
		go func() {
			err := runAccount(job.Scraper, s.config.IterationInterval)
			done <- err
		}()

		var err error
		select {
		case err = <-done:
		case <-time.After(s.config.MaxExecutionTime):
			fmt.Printf("Job %s exceeded max execution time. Stopping...\n", job.ID)
			job.Scraper.StopChan <- struct{}{}
			err = fmt.Errorf("job exceeded max execution time")
		}

		s.mu.Lock()
		defer s.mu.Unlock()

		if err != nil {
			fmt.Printf("Error executing job %s: %v\n", job.ID, err)
			job.FailureCount++
			job.LastFailureTime = time.Now()
		} else {
			job.FailureCount = 0
		}

		s.cleanupJob(job)
		delete(s.runningJobs, job.ID)
		s.requeueJob(job)
	}()
}

func (s *Scheduler) LoadJobs(limit int) error {
	accounts, err := getAvailableAccounts(limit)
	if err != nil {
		return fmt.Errorf("failed to get available accounts: %w", err)
	}

	for _, account := range accounts {
		scraper := &AccountScraper{
			Account:      account,
			Browser:      rod.New(),
			StopChan:     make(chan struct{}),
			LastActivity: time.Now(),
		}

		job := &Job{
			ID:        uuid.New().String(),
			AccountID: account.ID,
			Priority:  1,
			Scraper:   scraper,
		}

		s.AddJob(job)
	}

	return nil
}
