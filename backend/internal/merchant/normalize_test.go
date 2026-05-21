package merchant

import "testing"

func TestNormalize(t *testing.T) {
	cases := []struct{ in, want string }{
		{"", ""},
		{"WOOLWORTHS PTY LTD #4021  JHB", "woolworths jhb"},
		{"Woolworths", "woolworths"},
		{"woolworths pty ltd", "woolworths"},
		{"Uber *EATS help.uber.com", "uber eats help uber com"},
		{"  Pick n Pay 0123 ", "pick n pay"},
		{"PICK N PAY", "pick n pay"},
		{"Checkers Hyper", "checkers hyper"},
		{"POS PURCHASE CHECKERS", "checkers"},
		{"12345", "12345"},   // only-number falls back, never empty
		{"#$%^&", ""},        // only-punctuation normalizes to nothing
		{"The Coffee Shop", "coffee shop"},
	}
	for _, c := range cases {
		if got := Normalize(c.in); got != c.want {
			t.Errorf("Normalize(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// Stability: the same merchant written two ways must collapse to one key,
// which is what makes a learned rule match future transactions.
func TestNormalizeStability(t *testing.T) {
	a := Normalize("WOOLWORTHS PTY LTD #4021 JHB")
	b := Normalize("Woolworths JHB")
	if a != b {
		t.Errorf("variants should normalize equal: %q vs %q", a, b)
	}
}
