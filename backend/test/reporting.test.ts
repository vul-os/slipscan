/**
 * Reporting module tests — pure unit tests for report math and CSV serialisation.
 * No DB or HTTP; mirrors Go internal/reporting/reports_test.go.
 *
 * MONEY INVARIANT: all amounts are exact strings. We test exact equality, not
 * floating-point proximity.
 */
import { test, expect, describe } from "vitest";
import {
  buildPL,
  buildBalanceSheet,
  buildVAT,
  buildCashFlow,
  buildSpendingTrend,
  buildNetWorth,
  validateReport,
  ErrUnknownReport,
  ErrWrongOrgKind,
} from "../src/modules/reporting/reports";
import { writeCSV } from "../src/modules/reporting/csv";
import type {
  Period,
  PLLine,
  BSLine,
  VATLine,
  CashFlowRow,
  SpendingTrendRow,
  NetWorthInput,
} from "../src/modules/reporting/types";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function period(from: string, to: string): Period {
  return { from, to };
}

// ─── validateReport ──────────────────────────────────────────────────────────

describe("validateReport", () => {
  const businessReports = ["profit-and-loss", "balance-sheet", "vat-summary"];
  const personalReports = ["cash-flow", "spending-trend", "net-worth"];

  for (const name of businessReports) {
    test(`${name} is valid for business`, () => {
      expect(() => validateReport(name, "business")).not.toThrow();
    });
    test(`${name} throws ErrWrongOrgKind for personal`, () => {
      expect(() => validateReport(name, "personal")).toThrow(ErrWrongOrgKind);
    });
  }

  for (const name of personalReports) {
    test(`${name} is valid for personal`, () => {
      expect(() => validateReport(name, "personal")).not.toThrow();
    });
    test(`${name} throws ErrWrongOrgKind for business`, () => {
      expect(() => validateReport(name, "business")).toThrow(ErrWrongOrgKind);
    });
  }

  test("unknown report throws ErrUnknownReport", () => {
    expect(() => validateReport("unknown-report", "business")).toThrow(ErrUnknownReport);
    expect(() => validateReport("unknown-report", "personal")).toThrow(ErrUnknownReport);
  });
});

// ─── Profit & Loss ───────────────────────────────────────────────────────────

describe("buildPL", () => {
  const makeLines = (
    overrides: Partial<PLLine>[] = [],
    defaults: Partial<PLLine> = {},
  ): PLLine[] =>
    overrides.map((o) => ({
      account_id: "a1",
      code: "",
      name: "Account",
      account_type: "income",
      net_balance: "0",
      ...defaults,
      ...o,
    }));

  test("basic income and expense totals", () => {
    const rows: PLLine[] = [
      { account_id: "a1", code: "",     name: "Sales",        account_type: "income",  net_balance: "10000" },
      { account_id: "a2", code: "",     name: "Other Income", account_type: "income",  net_balance: "500"   },
      { account_id: "a3", code: "",     name: "Salaries",     account_type: "expense", net_balance: "6000"  },
      { account_id: "a4", code: "",     name: "Rent",         account_type: "expense", net_balance: "1500"  },
    ];
    const r = buildPL(period("2026-01-01", "2026-03-31"), rows);

    expect(r.total_income).toBe("10500.00");
    expect(r.total_expense).toBe("7500.00");
    expect(r.net_income).toBe("3000.00");
    expect(r.income_lines).toHaveLength(2);
    expect(r.expense_lines).toHaveLength(2);
  });

  test("empty rows produce all zeros", () => {
    const r = buildPL(period("2026-01-01", "2026-01-31"), []);
    expect(r.total_income).toBe("0.00");
    expect(r.total_expense).toBe("0.00");
    expect(r.net_income).toBe("0.00");
    expect(r.income_lines).toHaveLength(0);
    expect(r.expense_lines).toHaveLength(0);
  });

  test("loss scenario: expense > income → negative net_income", () => {
    const rows: PLLine[] = [
      { account_id: "a1", code: "", name: "Revenue", account_type: "income",  net_balance: "1000" },
      { account_id: "a2", code: "", name: "Wages",   account_type: "expense", net_balance: "5000" },
    ];
    const r = buildPL(period("2026-01-01", "2026-01-31"), rows);
    expect(r.net_income).toBe("-4000.00");
  });

  test("account balance strings are 2dp", () => {
    const rows: PLLine[] = [
      { account_id: "a1", code: "", name: "Rev", account_type: "income", net_balance: "1234.5" },
    ];
    const r = buildPL(period("2026-01-01", "2026-01-31"), rows);
    expect(r.income_lines[0].balance).toBe("1234.50");
  });

  test("decimal precision: no float drift", () => {
    // 0.1 + 0.2 in JS float = 0.30000000000000004; Decimal must give 0.30.
    const rows: PLLine[] = [
      { account_id: "a1", code: "", name: "A", account_type: "income", net_balance: "0.1" },
      { account_id: "a2", code: "", name: "B", account_type: "income", net_balance: "0.2" },
    ];
    const r = buildPL(period("2026-01-01", "2026-01-31"), rows);
    expect(r.total_income).toBe("0.30");
  });
});

// ─── Balance Sheet ────────────────────────────────────────────────────────────

describe("buildBalanceSheet", () => {
  test("balanced: assets = liabilities + equity", () => {
    const rows: BSLine[] = [
      { account_id: "a1", code: "", name: "Bank",         account_type: "asset",     balance: "5000" },
      { account_id: "a2", code: "", name: "Receivables",  account_type: "asset",     balance: "3000" },
      { account_id: "a3", code: "", name: "Payables",     account_type: "liability", balance: "2000" },
      { account_id: "a4", code: "", name: "Bank Loan",    account_type: "liability", balance: "1000" },
      { account_id: "a5", code: "", name: "Share Capital",account_type: "equity",    balance: "5000" },
    ];
    const r = buildBalanceSheet("2026-03-31", rows);

    expect(r.total_assets).toBe("8000.00");
    expect(r.total_liabilities).toBe("3000.00");
    expect(r.total_equity).toBe("5000.00");
    expect(r.balanced).toBe(true);
    expect(r.diff).toBe("0.00");
  });

  test("unbalanced: balanced=false, diff correct", () => {
    const rows: BSLine[] = [
      { account_id: "a1", code: "", name: "Bank", account_type: "asset", balance: "1000" },
    ];
    const r = buildBalanceSheet("2026-03-31", rows);
    expect(r.balanced).toBe(false);
    expect(r.diff).toBe("1000.00");
  });

  test("P&L ties through: retained earnings balance keeps sheet balanced", () => {
    // net income 2000 → retained earnings 4000, share capital 3000 = equity 7000
    const rows: BSLine[] = [
      { account_id: "a1", code: "", name: "Bank",               account_type: "asset",     balance: "12000" },
      { account_id: "a2", code: "", name: "Payables",           account_type: "liability", balance: "5000"  },
      { account_id: "a3", code: "", name: "Retained Earnings",  account_type: "equity",    balance: "4000"  },
      { account_id: "a4", code: "", name: "Share Capital",      account_type: "equity",    balance: "3000"  },
    ];
    const r = buildBalanceSheet("2026-06-30", rows);
    expect(r.balanced).toBe(true);
    expect(r.total_assets).toBe("12000.00");
    expect(r.total_liabilities).toBe("5000.00");
    expect(r.total_equity).toBe("7000.00");
  });

  test("empty produces all-zero balanced sheet", () => {
    const r = buildBalanceSheet("2026-01-31", []);
    expect(r.balanced).toBe(true);
    expect(r.diff).toBe("0.00");
    expect(r.asset_lines).toHaveLength(0);
  });
});

// ─── VAT Summary ─────────────────────────────────────────────────────────────

describe("buildVAT", () => {
  test("basic output vs input grouping", () => {
    const rows: VATLine[] = [
      { tax_rate_id: "tr1", code: "VAT15", name: "Standard VAT", rate: "15.0000", net: "5000", tax_amount: "750",  direction: "output" },
      { tax_rate_id: "tr1", code: "VAT15", name: "Standard VAT", rate: "15.0000", net: "2000", tax_amount: "300",  direction: "input"  },
      { tax_rate_id: "tr2", code: "VAT0",  name: "Zero Rated",   rate: "0.0000",  net: "1000", tax_amount: "0",    direction: "output" },
    ];
    const r = buildVAT(period("2026-01-01", "2026-03-31"), rows);

    expect(r.total_output_tax).toBe("750.00");
    expect(r.total_input_tax).toBe("300.00");
    expect(r.net_vat_payable).toBe("450.00");
    expect(r.output_lines).toHaveLength(2);
    expect(r.input_lines).toHaveLength(1);
  });

  test("empty rows produce zero net_vat_payable", () => {
    const r = buildVAT(period("2026-01-01", "2026-01-31"), []);
    expect(r.net_vat_payable).toBe("0.00");
  });

  test("input exceeds output → negative net_vat_payable (refund)", () => {
    const rows: VATLine[] = [
      { tax_rate_id: "tr1", code: "VAT15", name: "VAT", rate: "15.0000", net: "100",  tax_amount: "15",  direction: "output" },
      { tax_rate_id: "tr1", code: "VAT15", name: "VAT", rate: "15.0000", net: "2000", tax_amount: "300", direction: "input"  },
    ];
    const r = buildVAT(period("2026-01-01", "2026-01-31"), rows);
    expect(r.net_vat_payable).toBe("-285.00");
  });
});

// ─── Cash Flow ───────────────────────────────────────────────────────────────

describe("buildCashFlow", () => {
  test("basic monthly aggregation", () => {
    const rows: CashFlowRow[] = [
      { month: "2026-01", direction: "credit",   amount: "3000" },
      { month: "2026-01", direction: "debit",    amount: "2000" },
      { month: "2026-02", direction: "credit",   amount: "4000" },
      { month: "2026-02", direction: "debit",    amount: "1500" },
      { month: "2026-02", direction: "transfer", amount: "500"  }, // must be ignored
      { month: "2026-03", direction: "credit",   amount: "2000" },
      { month: "2026-03", direction: "debit",    amount: "2500" },
    ];
    const r = buildCashFlow(period("2026-01-01", "2026-03-31"), rows);

    expect(r.months).toHaveLength(3);
    expect(r.total_inflow).toBe("9000.00");
    expect(r.total_outflow).toBe("6000.00");
    expect(r.net_cash_flow).toBe("3000.00");
    // Jan net = 1000
    expect(r.months[0].net).toBe("1000.00");
    // Mar net = -500 (outflow > inflow)
    expect(r.months[2].net).toBe("-500.00");
  });

  test("transfers are completely ignored", () => {
    const rows: CashFlowRow[] = [
      { month: "2026-01", direction: "transfer", amount: "999999" },
    ];
    const r = buildCashFlow(period("2026-01-01", "2026-01-31"), rows);
    expect(r.total_inflow).toBe("0.00");
    expect(r.total_outflow).toBe("0.00");
    expect(r.months).toHaveLength(0);
  });

  test("months are sorted lexicographically even when rows arrive unordered", () => {
    const rows: CashFlowRow[] = [
      { month: "2026-03", direction: "credit", amount: "10" },
      { month: "2026-01", direction: "credit", amount: "10" },
      { month: "2026-02", direction: "credit", amount: "10" },
    ];
    const r = buildCashFlow(period("2026-01-01", "2026-03-31"), rows);
    expect(r.months.map((m) => m.month)).toEqual(["2026-01", "2026-02", "2026-03"]);
  });

  test("single-day period (from === to) is valid", () => {
    const rows: CashFlowRow[] = [
      { month: "2026-06", direction: "credit", amount: "100" },
    ];
    const r = buildCashFlow(period("2026-06-01", "2026-06-01"), rows);
    expect(r.total_inflow).toBe("100.00");
  });
});

// ─── Spending Trend ───────────────────────────────────────────────────────────

describe("buildSpendingTrend", () => {
  test("basic matrix build", () => {
    const rows: SpendingTrendRow[] = [
      { category_id: "c1", category_name: "Groceries", month: "2026-01", amount: "500" },
      { category_id: "c1", category_name: "Groceries", month: "2026-02", amount: "450" },
      { category_id: "c2", category_name: "Dining",    month: "2026-01", amount: "200" },
      { category_id: "c2", category_name: "Dining",    month: "2026-03", amount: "300" },
    ];
    const r = buildSpendingTrend(period("2026-01-01", "2026-03-31"), rows);

    expect(r.rows).toHaveLength(4);
    expect(r.months).toHaveLength(3);
    expect(r.months[0]).toBe("2026-01");
    expect(r.months[2]).toBe("2026-03");
  });

  test("months are sorted", () => {
    const rows: SpendingTrendRow[] = [
      { category_id: "c1", category_name: "X", month: "2026-03", amount: "1" },
      { category_id: "c1", category_name: "X", month: "2026-01", amount: "1" },
    ];
    const r = buildSpendingTrend(period("2026-01-01", "2026-03-31"), rows);
    expect(r.months).toEqual(["2026-01", "2026-03"]);
  });

  test("empty rows produce empty output", () => {
    const r = buildSpendingTrend(period("2026-01-01", "2026-01-31"), []);
    expect(r.rows).toHaveLength(0);
    expect(r.months).toHaveLength(0);
  });

  test("amounts are formatted to 2dp", () => {
    const rows: SpendingTrendRow[] = [
      { category_id: "c1", category_name: "Food", month: "2026-01", amount: "123.4" },
    ];
    const r = buildSpendingTrend(period("2026-01-01", "2026-01-31"), rows);
    expect(r.rows[0].amount).toBe("123.40");
  });
});

// ─── Net Worth ────────────────────────────────────────────────────────────────

describe("buildNetWorth", () => {
  test("basic series with net worth calculation", () => {
    const rows: NetWorthInput[] = [
      { date: "2026-01-31", total_assets: "10000", total_debt: "3000" },
      { date: "2026-02-28", total_assets: "10500", total_debt: "2900" },
      { date: "2026-03-31", total_assets: "11000", total_debt: "2800" },
    ];
    const r = buildNetWorth(period("2026-01-01", "2026-03-31"), rows);

    expect(r.series).toHaveLength(3);
    expect(r.series[0].net_worth).toBe("7000.00"); // 10000 - 3000
    expect(r.series[2].net_worth).toBe("8200.00"); // 11000 - 2800
  });

  test("empty rows produce empty series", () => {
    const r = buildNetWorth(period("2026-01-01", "2026-01-31"), []);
    expect(r.series).toHaveLength(0);
  });

  test("net worth strings are 2dp", () => {
    const rows: NetWorthInput[] = [
      { date: "2026-01-31", total_assets: "10000.5", total_debt: "3000.25" },
    ];
    const r = buildNetWorth(period("2026-01-01", "2026-01-31"), rows);
    expect(r.series[0].total_assets).toBe("10000.50");
    expect(r.series[0].total_debt).toBe("3000.25");
    expect(r.series[0].net_worth).toBe("7000.25");
  });
});

// ─── CSV serialisation ────────────────────────────────────────────────────────

describe("writeCSV – P&L", () => {
  const report = buildPL(period("2026-01-01", "2026-01-31"), [
    { account_id: "a1", code: "400", name: "Rev", account_type: "income",  net_balance: "1000" },
    { account_id: "a2", code: "500", name: "Wages", account_type: "expense", net_balance: "600" },
  ]);

  test("header row present", () => {
    const csv = writeCSV(report);
    expect(csv).toContain("section,account_id,code,name,balance");
  });

  test("income section present", () => {
    const csv = writeCSV(report);
    expect(csv).toContain("income,a1,400,Rev,1000.00");
  });

  test("expense section present", () => {
    const csv = writeCSV(report);
    expect(csv).toContain("expense,a2,500,Wages,600.00");
  });

  test("totals and net income rows", () => {
    const csv = writeCSV(report);
    // Go: ["income_total", "", "", "Total Income", moneyStr] — 5 fields, 4 commas.
    expect(csv).toContain("income_total,,,Total Income,1000.00");
    expect(csv).toContain("expense_total,,,Total Expense,600.00");
    expect(csv).toContain("net_income,,,Net Income,400.00");
  });

  test("uses CRLF line endings (RFC 4180)", () => {
    const csv = writeCSV(report);
    expect(csv).toContain("\r\n");
  });
});

describe("writeCSV – Balance Sheet", () => {
  const report = buildBalanceSheet("2026-01-31", [
    { account_id: "a1", code: "", name: "Bank",   account_type: "asset",  balance: "500" },
    { account_id: "a2", code: "", name: "Equity", account_type: "equity", balance: "500" },
  ]);

  test("asset and equity sections present", () => {
    const csv = writeCSV(report);
    expect(csv).toContain("asset,a1");
    expect(csv).toContain("equity,a2");
  });

  test("total rows present", () => {
    const csv = writeCSV(report);
    // Go: ["asset_total", "", "", "Total Assets", moneyStr] — 5 fields, 4 commas.
    expect(csv).toContain("asset_total,,,Total Assets,500.00");
    expect(csv).toContain("equity_total,,,Total Equity,500.00");
  });
});

describe("writeCSV – VAT Summary", () => {
  const report = buildVAT(period("2026-01-01", "2026-03-31"), [
    { tax_rate_id: "tr1", code: "VAT15", name: "Standard", rate: "15.0000", net: "1000", tax_amount: "150", direction: "output" },
    { tax_rate_id: "tr1", code: "VAT15", name: "Standard", rate: "15.0000", net: "500",  tax_amount: "75",  direction: "input"  },
  ]);

  test("header row", () => {
    const csv = writeCSV(report);
    expect(csv).toContain("direction,tax_rate_id,code,name,rate,net,tax_amount");
  });

  test("output and input rows present", () => {
    const csv = writeCSV(report);
    expect(csv).toContain("output,tr1,VAT15,Standard");
    expect(csv).toContain("input,tr1,VAT15,Standard");
  });

  test("net VAT payable row", () => {
    const csv = writeCSV(report);
    // Go: ["net_vat_payable", "", "", "Net VAT Payable", "", "", moneyStr] — 7 fields, 6 commas.
    expect(csv).toContain("net_vat_payable,,,Net VAT Payable,,,75.00");
  });
});

describe("writeCSV – Cash Flow", () => {
  const report = buildCashFlow(period("2026-01-01", "2026-02-28"), [
    { month: "2026-01", direction: "credit", amount: "3000" },
    { month: "2026-01", direction: "debit",  amount: "2000" },
    { month: "2026-02", direction: "credit", amount: "1000" },
  ]);

  test("header and month rows present", () => {
    const csv = writeCSV(report);
    expect(csv).toContain("month,inflow,outflow,net");
    expect(csv).toContain("2026-01,3000.00,2000.00,1000.00");
  });

  test("total row present", () => {
    const csv = writeCSV(report);
    expect(csv).toContain("total,4000.00,2000.00,2000.00");
  });
});

describe("writeCSV – Spending Trend", () => {
  const report = buildSpendingTrend(period("2026-01-01", "2026-01-31"), [
    { category_id: "c1", category_name: "Food", month: "2026-01", amount: "200" },
  ]);

  test("header and data row present", () => {
    const csv = writeCSV(report);
    expect(csv).toContain("category_id,category_name,month,amount");
    expect(csv).toContain("c1,Food,2026-01,200.00");
  });
});

describe("writeCSV – Net Worth", () => {
  const report = buildNetWorth(period("2026-01-01", "2026-01-31"), [
    { date: "2026-01-31", total_assets: "10000", total_debt: "3000" },
  ]);

  test("header and data row present", () => {
    const csv = writeCSV(report);
    expect(csv).toContain("date,total_assets,total_debt,net_worth");
    expect(csv).toContain("2026-01-31,10000.00,3000.00,7000.00");
  });
});

describe("writeCSV – RFC 4180 escaping", () => {
  test("fields containing commas are quoted", () => {
    const report = buildPL(period("2026-01-01", "2026-01-31"), [
      {
        account_id: "a1",
        code: "",
        name: "Sales, Returns & Allowances", // comma in name
        account_type: "income",
        net_balance: "500",
      },
    ]);
    const csv = writeCSV(report);
    expect(csv).toContain('"Sales, Returns & Allowances"');
  });

  test('fields containing double-quotes have them doubled', () => {
    const report = buildPL(period("2026-01-01", "2026-01-31"), [
      {
        account_id: "a1",
        code: "",
        name: 'Sales "Premium"',
        account_type: "income",
        net_balance: "100",
      },
    ]);
    const csv = writeCSV(report);
    expect(csv).toContain('"Sales ""Premium"""');
  });
});
