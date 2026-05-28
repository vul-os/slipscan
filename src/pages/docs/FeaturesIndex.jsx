import { Link } from "react-router-dom";
import { DocsContent } from "@/components/docs/DocsContent";

export default function FeaturesIndex() {
  return (
    <DocsContent>
      <h1>Features</h1>

      <p className="lead">
        Every product surface in slip/scan, with the details that matter. Each section below links
        to a deeper page with full configuration options and worked examples.
      </p>

      <h2 id="receipts-extraction">Receipts &amp; Extraction</h2>
      <p>
        Capture documents from your phone camera, drag-and-drop on the desktop, forwarded email,
        or Google Drive. The extraction pipeline parses photos, PDFs, and HTML receipt bodies —
        pulling out vendor, date, totals, individual line items, VAT/GST, currency, and FX rate.
        Each field carries a confidence score. The side-by-side review UI at{" "}
        <code>/receipts/:id</code> shows the source image alongside the extracted fields so you
        can verify and correct in one pass.{" "}
        <Link to="/docs/features/receipts">Read more →</Link>
      </p>

      <h2 id="classification-learning">Classification &amp; Learning</h2>
      <p>
        Every transaction is classified against a chart of accounts or personal category set. The
        classification engine starts with cross-tenant merchant signals — so a petrol station is
        likely to be &quot;Motor Expenses&quot; before you&apos;ve ever posted one — and then sharpens
        to per-org rules as you correct it. Define hard rules for specific vendors, or let the
        system learn from your corrections. Both modes co-exist; rules take precedence.{" "}
        <Link to="/docs/features/classification">Read more →</Link>
      </p>

      <h2 id="ledger-vault">Ledger &amp; Personal Vault</h2>
      <p>
        Business orgs use a standard double-entry chart of accounts with journals, bills, and
        credit notes. Personal orgs use a category hierarchy designed for household spending and
        net-worth tracking. Both share the same document store, extraction engine, and feed
        reconciliation — but reports and search adapt to the kind. Manual journal entries are
        supported in both modes for adjustments that don&apos;t come from a document.{" "}
        <Link to="/docs/features/ledger">Read more →</Link>
      </p>

      <h2 id="budgets-net-worth">Budgets &amp; Net Worth</h2>
      <p>
        Set monthly spending targets per category and see actuals tracked in real-time as
        transactions are posted. The personal Net Worth roll-up aggregates assets and liabilities
        from connected bank feeds, giving you a single number that updates daily. Recurring income
        — salary deposits, rental income, dividends — is detected automatically and excluded from
        discretionary spending reports.{" "}
        <Link to="/docs/features/budgets">Read more →</Link>
      </p>

      <h2 id="bank-feeds-reconcile">Bank Feeds &amp; Reconcile</h2>
      <p>
        Connect your bank via Stitch (South African banks: Standard Bank, FNB, ABSA, Nedbank,
        Capitec, Investec, Discovery, TymeBank). Stitch provides read-only OAuth access — we
        never see your credentials. Feed transactions are pulled 4&times; per day and matched
        against posted documents using amount, date, and vendor heuristics. The match queue lets
        you accept a suggested match with a single keystroke, or manually link any feed transaction
        to any document.{" "}
        <Link to="/docs/features/reconcile">Read more →</Link>
      </p>

      <h2 id="reports-ask">Reports &amp; Ask</h2>
      <p>
        Predefined kind-aware reports cover Profit &amp; Loss, category spending breakdown, and
        VAT summary — each respects the org&apos;s kind (business vs personal) and reporting
        period. The <strong>Ask</strong> surface lets you query your data in plain English:{" "}
        &quot;How much did I spend on fuel last quarter?&quot; or &quot;Show me all invoices over R5 000
        from Checkers.&quot; Every answer cites the source receipts. CSV export available on all
        reports.{" "}
        <Link to="/docs/features/reports">Read more →</Link>
      </p>

      <h2 id="accountant-workspace">Accountant Workspace</h2>
      <p>
        Accountants managing multiple clients get a unified inbox across all orgs — one queue
        sorted by urgency, not by client. An attention queue surfaces documents that need review,
        unreconciled items, and approaching deadlines. Cross-org intelligence runs anomaly
        detection, tax-readiness checks, and spend forecasts across the full client portfolio —
        without mixing data between clients.{" "}
        <Link to="/docs/features/workspace">Read more →</Link>
      </p>

      <h2 id="audit-compliance">Audit &amp; Compliance</h2>
      <p>
        Every action on every document is recorded in an immutable who-did-what log: uploads,
        extractions, corrections, posts, and deletes. The log is exportable as JSON or CSV for
        external compliance review. Retention rules let you set per-org document lifetimes aligned
        with your jurisdiction&apos;s requirements (e.g. SARS 5-year rule).{" "}
        <Link to="/docs/features/audit">Read more →</Link>
      </p>
    </DocsContent>
  );
}
