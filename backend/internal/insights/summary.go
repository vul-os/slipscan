package insights

import (
	"fmt"
	"strings"
)

// Summaries are deterministic — generated from the actual query result,
// not by asking the model to summarise (which would hallucinate numbers).
// The frontend can layer on richer prose later; this is the safe default.

func summarizeList(f Filters, n int) string {
	var b strings.Builder
	if n == 0 {
		b.WriteString("No receipts found")
	} else if n == 1 {
		b.WriteString("Found 1 receipt")
	} else {
		fmt.Fprintf(&b, "Found %d receipts", n)
	}
	if extra := describeFilter(f); extra != "" {
		b.WriteString(" ")
		b.WriteString(extra)
	}
	b.WriteString(".")
	return b.String()
}

func summarizeSum(f Filters, t *Totals) string {
	if t.Count == 0 {
		return "No matching receipts."
	}
	currency := ""
	if t.Currency != "" {
		currency = t.Currency + " "
	}
	plural := "receipt"
	if t.Count != 1 {
		plural = "receipts"
	}
	amount := 0.0
	if t.Amount != nil {
		amount = *t.Amount
	}
	var b strings.Builder
	fmt.Fprintf(&b, "Total %s%s across %d %s", currency, formatAmount(amount), t.Count, plural)
	if extra := describeFilter(f); extra != "" {
		b.WriteString(" ")
		b.WriteString(extra)
	}
	b.WriteString(".")
	return b.String()
}

func summarizeCount(f Filters, n int) string {
	plural := "receipt"
	if n != 1 {
		plural = "receipts"
	}
	var b strings.Builder
	fmt.Fprintf(&b, "%d %s", n, plural)
	if extra := describeFilter(f); extra != "" {
		b.WriteString(" ")
		b.WriteString(extra)
	}
	b.WriteString(".")
	return b.String()
}

func summarizeGroups(grouping string, f Filters, groups []Group) string {
	if len(groups) == 0 {
		return "No matching receipts."
	}
	var head string
	switch grouping {
	case "merchant":
		head = fmt.Sprintf("Top merchants by spend (%d shown)", len(groups))
	case "category":
		head = fmt.Sprintf("Spend by category (%d shown)", len(groups))
	case "month":
		head = fmt.Sprintf("Spend by month (%d shown)", len(groups))
	default:
		head = fmt.Sprintf("Breakdown (%d rows)", len(groups))
	}
	if extra := describeFilter(f); extra != "" {
		head += " " + extra
	}
	return head + "."
}

// describeFilter renders the active filters as a human phrase. Returns
// empty string if no filters narrowed the search.
func describeFilter(f Filters) string {
	parts := []string{}
	if f.MerchantContains != "" {
		parts = append(parts, fmt.Sprintf(`matching "%s"`, f.MerchantContains))
	}
	if f.Category != "" {
		parts = append(parts, fmt.Sprintf("in %s", f.Category))
	}
	switch {
	case f.DateFrom != "" && f.DateTo != "":
		parts = append(parts, fmt.Sprintf("between %s and %s", f.DateFrom, f.DateTo))
	case f.DateFrom != "":
		parts = append(parts, fmt.Sprintf("from %s", f.DateFrom))
	case f.DateTo != "":
		parts = append(parts, fmt.Sprintf("up to %s", f.DateTo))
	}
	if f.AmountMin != nil && f.AmountMax != nil {
		parts = append(parts, fmt.Sprintf("between %s and %s", formatAmount(*f.AmountMin), formatAmount(*f.AmountMax)))
	} else if f.AmountMin != nil {
		parts = append(parts, fmt.Sprintf("over %s", formatAmount(*f.AmountMin)))
	} else if f.AmountMax != nil {
		parts = append(parts, fmt.Sprintf("under %s", formatAmount(*f.AmountMax)))
	}
	if f.Currency != "" {
		parts = append(parts, fmt.Sprintf("in %s", f.Currency))
	}
	if f.Status != "" {
		parts = append(parts, fmt.Sprintf("(%s)", f.Status))
	}
	return strings.Join(parts, " ")
}

func formatAmount(f float64) string {
	// Tabular two-decimal — the frontend re-formats per locale.
	return fmt.Sprintf("%.2f", f)
}
