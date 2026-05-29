import { DocsContent } from "@/components/docs/DocsContent";

export default function FeaturesIndex() {
  return (
    <DocsContent>
      <h1>Features</h1>

      <p className="lead">
        Every product surface in slip/scan, with the details that matter.
      </p>

      <h2 id="receipts-extraction">Receipts &amp; Extraction</h2>
      <p>
        Capture documents from your phone camera, drag-and-drop on the desktop, forwarded email,
        or the public API. The extraction pipeline parses photos, PDFs, and HTML receipt bodies —
        pulling out vendor, date, totals, individual line items, VAT/GST, currency, and FX rate.
        Each field carries a confidence score. The side-by-side review UI at{" "}
        <code>/receipts/:id</code> shows the source image alongside the extracted fields so you
        can verify and correct in one pass.
      </p>
      <p>
        Photos, PDFs, emailed scans, and forwarded inbox addresses all flow into the same queue.
        Extracted fields surface alongside the original image so corrections take a click. The
        system remembers the correction for that merchant, this org, and (with consent) across
        the platform.
      </p>

      <h2 id="classification-learning">Classification &amp; Learning</h2>
      <p>
        Every transaction is classified against a chart of accounts or personal category set. The
        classification engine starts with cross-tenant merchant signals — so a petrol station is
        likely to be &quot;Motor Expenses&quot; before you&apos;ve ever posted one — and then sharpens
        to per-org rules as you correct it. Define hard rules for specific vendors, or let the
        system learn from your corrections. Both modes co-exist; rules take precedence.
      </p>
      <p>
        Three layers: hard rules you define (&apos;Uber → Travel&apos;), org-wide patterns learned from
        your corrections, and platform-wide priors when there&apos;s no local signal. Each prediction
        shows its source. You can pin a category to make it deterministic.
      </p>

      <h2 id="ledger-vault">Ledger &amp; Personal Vault</h2>
      <p>
        Business orgs use a standard double-entry chart of accounts with journals, bills, and
        credit notes. Personal orgs use a category hierarchy designed for household spending and
        net-worth tracking. Both share the same document store, extraction engine, and feed
        reconciliation — but reports and search adapt to the kind. Manual journal entries are
        supported in both modes for adjustments that don&apos;t come from a document.
      </p>
      <p>
        Business orgs get a full double-entry ledger with Chart of Accounts, journal entries, and
        a Trial Balance view. Personal orgs get a category-driven spending breakdown with a
        recurring-income detector and a month-over-month delta view. The same captured documents
        flow into both surfaces — only the reporting differs.
      </p>

      <h2 id="budgets-net-worth">Budgets &amp; Net Worth</h2>
      <p>
        Set monthly spending targets per category and see actuals tracked in real-time as
        transactions are posted. The personal Net Worth roll-up aggregates assets and liabilities
        from connected bank feeds, giving you a single number that updates daily. Recurring income
        — salary deposits, rental income, dividends — is detected automatically and excluded from
        discretionary spending reports.
      </p>
      <p>
        Monthly budgets per category with rollover, alerts at 80%/100%, and quick reassignment on
        overspend. Net Worth tracks accounts (assets and liabilities) across feeds plus any manual
        entries, with a 24-month chart and a recurring-cashflow projection.
      </p>

      <h2 id="bank-feeds-reconcile">Bank Feeds &amp; Reconcile</h2>
      <p>
        Connect your bank via Stitch (South African banks: Standard Bank, FNB, ABSA, Nedbank,
        Capitec, Investec, Discovery, TymeBank). Stitch provides read-only OAuth access — we
        never see your credentials. Feed transactions are pulled 4&times; per day and matched
        against posted documents using amount, date, and vendor heuristics. The match queue lets
        you accept a suggested match with a single keystroke, or manually link any feed transaction
        to any document.
      </p>
      <p>
        Connect any SA bank via Stitch OAuth. Feeds sync 4&times; per day; initial sync can take up
        to 24h. The matcher pairs feed transactions to captured documents by amount + date window +
        merchant similarity. Confirm a row to close both sides; the Reconcile page shows everything
        still open.
      </p>

      <h2 id="reports-ask">Reports &amp; Ask</h2>
      <p>
        Predefined kind-aware reports cover Profit &amp; Loss, category spending breakdown, and
        VAT summary — each respects the org&apos;s kind (business vs personal) and reporting
        period. The <strong>Ask</strong> surface lets you query your data in plain English:{" "}
        &quot;How much did I spend on fuel last quarter?&quot; or &quot;Show me all invoices over R5 000
        from Checkers.&quot; Every answer cites the source receipts. CSV export available on all
        reports.
      </p>
      <p>
        Predefined reports — P&amp;L, Spending Breakdown, VAT Summary, Cash Flow, Net Worth
        Statement — all run in &lt;500ms and export to CSV. Ask is a natural-language layer that
        translates &quot;How much on fuel last quarter?&quot; into a SQL query against your ledger,
        with the source receipts cited in the answer.
      </p>

      <h2 id="accountant-workspace">Accountant Workspace</h2>
      <p>
        Accountants managing multiple clients get a unified inbox across all orgs — one queue
        sorted by urgency, not by client. An attention queue surfaces documents that need review,
        unreconciled items, and approaching deadlines. Cross-org intelligence runs anomaly
        detection, tax-readiness checks, and spend forecasts across the full client portfolio —
        without mixing data between clients.
      </p>
      <p>
        One inbox across every client org you have access to. Sort by attention-required
        (low-confidence extractions, pending matches, unposted journals). Forecast and anomaly
        views surface across all clients. Tax-readiness score per client estimates how close their
        books are to filing-ready.
      </p>

      <h2 id="audit-compliance">Audit &amp; Compliance</h2>
      <p>
        Every action on every document is recorded in an immutable who-did-what log: uploads,
        extractions, corrections, posts, and deletes. The log is exportable as JSON or CSV for
        external compliance review. Retention rules let you set per-org document lifetimes aligned
        with your jurisdiction&apos;s requirements (e.g. SARS 5-year rule).
      </p>
      <p>
        Every write is logged: who, what changed, when, from which IP and session. Filterable by
        user, action, and date range. Exportable to CSV for compliance review. Logs are immutable
        — Admins can read, no one can delete.
      </p>
    </DocsContent>
  );
}
