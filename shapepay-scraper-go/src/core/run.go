package core

import (
	"context"
	"fmt"
	"log"
	"math/rand"
	"sync"
	"time"

	"github.com/go-rod/rod"
)

// AccountScraper handles the scraping process for an individual account
type AccountScraper struct {
	account      Account
	browser      *rod.Browser
	page         *rod.Page
	lastActivity time.Time
	stopChan     chan struct{}
}

// Config holds the configuration for the parallel scraper
type Config struct {
	MinInitialDelay   time.Duration
	MaxInitialDelay   time.Duration
	MinResetInterval  time.Duration
	MaxResetInterval  time.Duration
	HeartbeatTimeout  time.Duration
	IterationInterval time.Duration
	PostResetDelay    time.Duration
	AccountLimit      int // Limit for getAvailableAccounts
}

// ParallelScraper manages parallel account scraping jobs
type ParallelScraper struct {
	config Config
	mu     sync.Mutex
	jobs   map[string]*AccountScraper
}

// NewParallelScraper creates a new ParallelScraper with the given configuration
func NewParallelScraper(config Config) *ParallelScraper {
	log.Printf("Initializing ParallelScraper with config: %+v", config)
	return &ParallelScraper{
		config: config,
		jobs:   make(map[string]*AccountScraper),
	}
}

// Run starts the parallel scraping process
func (ps *ParallelScraper) Run(ctx context.Context) error {
	log.Printf("Starting parallel scraping process with limit: %d", ps.config.AccountLimit)
	accounts, err := getAvailableAccounts(ps.config.AccountLimit)
	if err != nil {
		log.Printf("Error getting available accounts: %v", err)
		return fmt.Errorf("failed to get available accounts: %w", err)
	}
	log.Printf("Retrieved %d accounts for scraping", len(accounts))

	var wg sync.WaitGroup

	for i, account := range accounts {
		account := account // Capture loop variable
		initialDelay := 0 * time.Second
		if i > 0 {
			initialDelay = ps.getRandomDuration(ps.config.MinInitialDelay, ps.config.MaxInitialDelay)
			log.Printf("Scheduling job for account %s with initial delay of %v", account.Username, initialDelay)
			time.Sleep(initialDelay)
		}

		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := ps.runAccountJob(ctx, account); err != nil {
				log.Printf("Error in account job for %s: %v", account.Username, err)
			}
		}()
	}

	log.Println("All account jobs have been started")
	wg.Wait()
	return nil
}

func (ps *ParallelScraper) runAccountJob(ctx context.Context, account Account) error {
	log.Printf("Starting job for account %s", account.Username)
	scraper := &AccountScraper{
		account:      account,
		lastActivity: time.Now(),
		stopChan:     make(chan struct{}),
	}

	ps.mu.Lock()
	ps.jobs[account.Username] = scraper
	ps.mu.Unlock()

	defer func() {
		ps.mu.Lock()
		delete(ps.jobs, account.Username)
		ps.mu.Unlock()
		close(scraper.stopChan)
		log.Printf("Job for account %s has finished", account.Username)
	}()

	ticker := time.NewTicker(100 * time.Millisecond) // Fast ticker for responsive shutdown
	defer ticker.Stop()

	resetTimer := time.NewTimer(ps.getRandomDuration(ps.config.MinResetInterval, ps.config.MaxResetInterval))
	defer resetTimer.Stop()

	log.Printf("Job for account %s initialized", account.Username)

	for {
		select {
		case <-ctx.Done():
			log.Printf("Context cancelled for account %s", account.Username)
			return ctx.Err()
		case <-resetTimer.C:
			log.Printf("Scheduled reset triggered for account %s", account.Username)
			if err := ps.resetJob(scraper); err != nil {
				log.Printf("Error resetting job for account %s: %v", account.Username, err)
			}
			resetTimer.Reset(ps.getRandomDuration(ps.config.MinResetInterval, ps.config.MaxResetInterval))
			log.Printf("Waiting for post-reset delay of %v for account %s", ps.config.PostResetDelay, account.Username)
			time.Sleep(ps.config.PostResetDelay)
		case <-ticker.C:
			if time.Since(scraper.lastActivity) > ps.config.HeartbeatTimeout {
				log.Printf("Heartbeat timeout detected for account %s. Last activity: %v", account.Username, scraper.lastActivity)
				if err := ps.resetJob(scraper); err != nil {
					log.Printf("Error resetting job for account %s: %v", account.Username, err)
				}
				resetTimer.Reset(ps.getRandomDuration(ps.config.MinResetInterval, ps.config.MaxResetInterval))
				log.Printf("Waiting for post-reset delay of %v for account %s", ps.config.PostResetDelay, account.Username)
				time.Sleep(ps.config.PostResetDelay)
				continue
			}

			if err := runAccount(scraper, ps.config.IterationInterval); err != nil {
				log.Printf("Error running account job for %s: %v", account.Username, err)
				if err := ps.resetJob(scraper); err != nil {
					log.Printf("Error resetting job for account %s: %v", account.Username, err)
				}
				resetTimer.Reset(ps.getRandomDuration(ps.config.MinResetInterval, ps.config.MaxResetInterval))
				log.Printf("Waiting for post-reset delay of %v for account %s", ps.config.PostResetDelay, account.Username)
				time.Sleep(ps.config.PostResetDelay)
				continue
			}
			log.Printf("Successfully completed iteration for account %s", account.Username)
		}
	}
}

func (ps *ParallelScraper) resetJob(scraper *AccountScraper) error {
	log.Printf("Resetting job for account %s", scraper.account.Username)
	if scraper.browser != nil {
		scraper.browser.Close()
		scraper.browser = nil
	}

	newBrowser, err := initializeBrowser()
	if err != nil {
		return fmt.Errorf("failed to initialize new browser: %w", err)
	}

	scraper.browser = newBrowser
	scraper.page = nil
	scraper.lastActivity = time.Now()
	log.Printf("Job reset complete for account %s", scraper.account.Username)

	return nil
}

func (ps *ParallelScraper) getRandomDuration(min, max time.Duration) time.Duration {
	return min + time.Duration(rand.Int63n(int64(max-min)))
}
