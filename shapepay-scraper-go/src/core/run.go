package core

import (
	"fmt"
	"log"
	"math/rand"
	"sync"
	"time"

	"github.com/exolutionza/shapepay-scraper-go/src/db"
	"github.com/go-rod/rod"
)

type Config struct {
	MaxConcurrentAccounts   int
	InitialRetryDelay       time.Duration
	IterationInterval       time.Duration
	MaxRetryDelay           time.Duration
	JobMonitorInterval      time.Duration
	MaxInactiveTime         time.Duration
	RestartDelay            time.Duration
	AccountFetchRetry       time.Duration
	MinRandomResetInterval  time.Duration
	MaxRandomResetInterval  time.Duration
	InitialRandomResetDelay time.Duration
	MaxRandomResetDelay     time.Duration
	MinJobStartDelay        time.Duration
	InitialJobStartDelay    time.Duration
}

type Core struct {
	JobManager *JobManager
	Config     Config
}

type AccountScraper struct {
	account      Account
	browser      *rod.Browser
	page         *rod.Page
	lastActivity time.Time
	stopChan     chan struct{}
	resetTimer   *time.Timer
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

func NewCore(config Config) *Core {
	return &Core{
		JobManager: NewJobManager(),
		Config:     config,
	}
}

func (c *Core) Init() error {
	if err := db.InitDB(); err != nil {
		return fmt.Errorf("failed to initialize database: %w", err)
	}
	return nil
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

func (c *Core) Start() {
	c.JobManager.JobMutex.Lock()
	defer c.JobManager.JobMutex.Unlock()

	isFirstJob := true
	for _, job := range c.JobManager.Jobs {
		if isFirstJob {
			go c.runJob(job)
			isFirstJob = false
		} else {
			go c.delayedStart(job)
		}
	}
}

func (c *Core) delayedStart(job *Job) {
	delay := c.Config.MinJobStartDelay + time.Duration(rand.Int63n(int64(c.Config.InitialJobStartDelay-c.Config.MinJobStartDelay)))
	log.Printf("Delaying start of job for account %s by %v", job.Scraper.account.Username, delay)
	time.Sleep(delay)
	c.runJob(job)
}

func (c *Core) runJob(job *Job) {
	retryDelay := c.Config.InitialRetryDelay
	c.scheduleReset(job)

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

				err = runAccount(job.Scraper, c.Config.IterationInterval)
			}()

			<-done

			if err != nil {
				log.Printf("Error running account %s: %v. Retrying in %v", job.Scraper.account.Username, err, retryDelay)
				time.Sleep(retryDelay)

				retryDelay += time.Minute
				if retryDelay > c.Config.MaxRetryDelay {
					retryDelay = c.Config.MaxRetryDelay
				}
			} else {
				retryDelay = c.Config.InitialRetryDelay
			}
		}
	}
}

func (c *Core) scheduleReset(job *Job) {
	resetInterval := c.Config.MinRandomResetInterval +
		time.Duration(rand.Int63n(int64(c.Config.MaxRandomResetInterval-c.Config.MinRandomResetInterval)))

	job.Scraper.resetTimer = time.AfterFunc(resetInterval, func() {
		c.resetJob(job)
	})
}

func (c *Core) resetJob(job *Job) {
	log.Printf("Resetting job for account %s", job.Scraper.account.Username)

	c.forceStopJob(job)
	close(job.StopChan)

	newStopChan := make(chan struct{})
	job.StopChan = newStopChan

	resetDelay := c.Config.InitialRandomResetDelay +
		time.Duration(rand.Int63n(int64(c.Config.MaxRandomResetDelay-c.Config.InitialRandomResetDelay)))

	time.AfterFunc(resetDelay+c.Config.RestartDelay, func() {
		log.Printf("Restarting reset job for account %s after cool-down", job.Scraper.account.Username)
		go c.runJob(job)
	})
}

func (c *Core) MonitorJobs() {
	for {
		time.Sleep(c.Config.JobMonitorInterval)
		c.JobManager.JobMutex.Lock()
		for _, job := range c.JobManager.Jobs {
			if time.Since(job.Scraper.lastActivity) > c.Config.MaxInactiveTime {
				log.Printf("Job for account %s seems to be hanging. Forcing stop and scheduling restart...", job.Scraper.account.Username)
				c.resetJob(job)
			}
		}
		c.JobManager.JobMutex.Unlock()
	}
}

func (c *Core) forceStopJob(job *Job) {
	if job.Scraper.resetTimer != nil {
		job.Scraper.resetTimer.Stop()
	}
	if job.Scraper.browser != nil {
		job.Scraper.browser.MustClose()
		job.Scraper.browser = nil
	}
	job.Scraper.page = nil
	job.Scraper.lastActivity = time.Now()
	log.Printf("Forced stop of job %s (Account: %s)", job.ID, job.Scraper.account.Username)
}

func (c *Core) Run() {
	go c.MonitorJobs()

	for {
		accounts, err := getAvailableAccounts(c.Config.MaxConcurrentAccounts)
		if err != nil {
			log.Printf("Error getting available accounts: %v. Retrying in %v.", err, c.Config.AccountFetchRetry)
			time.Sleep(c.Config.AccountFetchRetry)
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

			c.JobManager.AddJob(job)
		}

		c.Start()

		select {}
	}
}
