package recon

import (
	"math"
	"strings"
)

// ─── Scoring ──────────────────────────────────────────────────────────────────

// scoreComponents holds the individual sub-scores for diagnostic purposes.
type scoreComponents struct {
	amountScore   float64 // 0..1
	dateScore     float64 // 0..1
	merchantScore float64 // 0..1
}

// totalScore returns the weighted composite confidence from the sub-scores.
// Weights: amount 45 %, date 30 %, merchant 25 %.
// Rationale: amount is the strongest signal (receipts record exact amounts);
// date is strong (most card settlements clear ≤3 days); merchant is useful
// but bank descriptions are often mangled so it is down-weighted.
func (s scoreComponents) totalScore() float64 {
	return 0.45*s.amountScore + 0.30*s.dateScore + 0.25*s.merchantScore
}

// scoreAmount returns 1.0 when the amounts match exactly, decaying to 0 as
// the absolute difference approaches the tolerance ceiling.  If the difference
// exceeds both absolute and percentage tolerances the score is 0.
func scoreAmount(txAmt, lineAmt float64, cfg Config) float64 {
	diff := math.Abs(txAmt - lineAmt)
	if diff == 0 {
		return 1.0
	}
	base := math.Abs(txAmt)
	if base == 0 {
		base = math.Abs(lineAmt)
	}

	withinAbs := diff <= cfg.AmountToleranceAbs
	withinPct := base > 0 && (diff/base) <= cfg.AmountTolerancePct

	if !withinAbs && !withinPct {
		return 0
	}

	// Linear decay inside the tolerance band.  Use the widest ceiling that
	// applies (the pair qualified via at least one tolerance, so we score
	// relative to whichever band admitted it).
	ceiling := cfg.AmountToleranceAbs
	if base > 0 {
		pctCeiling := base * cfg.AmountTolerancePct
		if pctCeiling > ceiling {
			ceiling = pctCeiling
		}
	}
	if ceiling <= 0 {
		return 1.0
	}
	score := 1.0 - (diff / ceiling)
	if score < 0 {
		score = 0
	}
	return score
}

// scoreDate returns 1.0 for same-day, decaying linearly to 0 at the window
// boundary.  Dates that are both zero (unknown) return 0.5 so they don't
// block matching but don't dominate the score either.
func scoreDate(deltaDays int, cfg Config) float64 {
	if cfg.DateWindowDays <= 0 {
		if deltaDays == 0 {
			return 1.0
		}
		return 0
	}
	if deltaDays > cfg.DateWindowDays {
		return 0
	}
	return 1.0 - float64(deltaDays)/float64(cfg.DateWindowDays)
}

// scoreMerchant returns a similarity score in [0, 1] between two normalized
// merchant strings.  Exact match → 1.0; empty strings on either side → 0.3
// (neutral: neither helpful nor harmful); otherwise a token-overlap ratio
// (Jaccard-like over unigrams).
func scoreMerchant(normA, normB string) float64 {
	if normA == "" || normB == "" {
		// One or both merchants unknown — don't penalise, don't reward.
		return 0.3
	}
	if normA == normB {
		return 1.0
	}
	setA := tokenSet(normA)
	setB := tokenSet(normB)
	intersection := 0
	for tok := range setA {
		if setB[tok] {
			intersection++
		}
	}
	union := len(setA) + len(setB) - intersection
	if union == 0 {
		return 0
	}
	return float64(intersection) / float64(union)
}

// tokenSet splits a normalized string into a set of tokens.
func tokenSet(s string) map[string]bool {
	m := make(map[string]bool)
	for _, t := range strings.Fields(s) {
		m[t] = true
	}
	return m
}

// ─── Candidate generation ─────────────────────────────────────────────────────

// absDays returns the absolute day difference between two times.
// If either time is zero, returns cfg.DateWindowDays+1 so the pair fails the
// window filter.
func absDays(a, b datePair, cfg Config) int {
	if a.isZero || b.isZero {
		return cfg.DateWindowDays + 1
	}
	d := a.days - b.days
	if d < 0 {
		d = -d
	}
	return d
}

type datePair struct {
	days   int  // Unix day (epoch days)
	isZero bool // true when the original time was zero-value
}

func toDatePair(t interface{ IsZero() bool }, epochDays func() int) datePair {
	if t.IsZero() {
		return datePair{isZero: true}
	}
	return datePair{days: epochDays()}
}

// epochDay converts a unix timestamp in seconds to an integer "epoch day"
// (days since 1970-01-01).  This avoids time-zone issues because both values
// are stored as DATE in Postgres (no time component).
func epochDays(t interface {
	Unix() int64
}) int {
	return int(t.Unix() / 86400)
}

// ─── Match generation ─────────────────────────────────────────────────────────

// CandidateMatch is a (tx, line) pair with computed scores, prior to
// persistence.
type CandidateMatch struct {
	Tx            TxCandidate
	Line          LineCandidate
	AmountDelta   float64
	DateDeltaDays int
	MerchantScore float64
	Confidence    float64
}

// GenerateCandidates matches each tx in txs against each line in lines,
// returning scored pairs that exceed SuggestConfidenceThreshold.
// The caller is responsible for applying the no-double-match invariant
// (typically by running this against only unmatched candidates and using the
// DB unique index as the final guard).
func GenerateCandidates(txs []TxCandidate, lines []LineCandidate, cfg Config) []CandidateMatch {
	var out []CandidateMatch

	for _, tx := range txs {
		txEpoch := 0
		txDateZero := tx.PostedDate.IsZero()
		if !txDateZero {
			txEpoch = int(tx.PostedDate.Unix() / 86400)
		}

		for _, line := range lines {
			// Amount score.
			amtScore := scoreAmount(tx.Amount, line.Amount, cfg)
			if amtScore == 0 {
				continue // fast reject on amount mismatch
			}

			// Date delta — hard cutoff when both dates are known.
			delta := cfg.DateWindowDays + 1 // default: outside window
			if !txDateZero && !line.LineDate.IsZero() {
				lineEpoch := int(line.LineDate.Unix() / 86400)
				d := txEpoch - lineEpoch
				if d < 0 {
					d = -d
				}
				delta = d
			}
			// When both dates are known and the delta exceeds the window, reject
			// the pair entirely rather than letting amount+merchant carry it.
			if !txDateZero && !line.LineDate.IsZero() && delta > cfg.DateWindowDays {
				continue
			}
			dateScore := scoreDate(delta, cfg)

			// Merchant score.
			mScore := scoreMerchant(tx.MerchantNormalized, line.Description)

			sc := scoreComponents{
				amountScore:   amtScore,
				dateScore:     dateScore,
				merchantScore: mScore,
			}
			conf := sc.totalScore()

			if conf < cfg.SuggestConfidenceThreshold {
				continue
			}

			out = append(out, CandidateMatch{
				Tx:            tx,
				Line:          line,
				AmountDelta:   math.Abs(tx.Amount - line.Amount),
				DateDeltaDays: delta,
				MerchantScore: mScore,
				Confidence:    conf,
			})
		}
	}

	return out
}
