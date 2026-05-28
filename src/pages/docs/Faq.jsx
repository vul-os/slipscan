import { DocsContent } from "@/components/docs/DocsContent";
import { Link } from "react-router-dom";

export default function Faq() {
  return (
    <DocsContent>
      <h1>Frequently asked questions</h1>

      <p className="lead">
        Quick answers to the things people ask before signing up. For anything that isn&apos;t
        here, email <a href="mailto:hello@slipscan.app">hello@slipscan.app</a>.
      </p>

      <h2 id="setup">Setup &amp; onboarding</h2>
      <ul>
        <li>
          <strong>How long does onboarding take?</strong> Under five minutes. Sign up, name your
          org, choose Personal or Business, and you&apos;re ready to drop in your first document.
          Connecting Xero or Stitch adds another two to three minutes each.
        </li>
        <li>
          <strong>Can I run personal and business from one login?</strong> Yes. A single login can
          own or be a member of multiple organisations. Switch between them from the org switcher
          in the top navigation.
        </li>
        <li>
          <strong>Can I import historical receipts?</strong> Yes — drag-and-drop a batch of PDFs
          or photos onto <Link to="/receipts">/receipts</Link>. The extraction pipeline processes
          them in the background; you&apos;ll get a notification when the queue is clear.
        </li>
        <li>
          <strong>What file formats are supported?</strong> JPEG, PNG, WebP, HEIC (iOS), PDF
          (multi-page), and HTML (forwarded email bodies). Maximum file size is 25 MB per
          document.
        </li>
      </ul>

      <h2 id="extraction">Extraction &amp; classification</h2>
      <ul>
        <li>
          <strong>How accurate is the extraction?</strong> For clean printed receipts and
          invoices, field-level accuracy is above 97%. Handwritten receipts and low-resolution
          photos are lower — confidence scores flag these for your review.
        </li>
        <li>
          <strong>What fields do you extract?</strong> Vendor name, vendor address, document date,
          due date (invoices), currency, exchange rate, subtotal, tax (VAT/GST), total, and
          individual line items (description, quantity, unit price, line total).
        </li>
        <li>
          <strong>How do confidence scores work?</strong> Each field carries a 0–1 score. Fields
          below 0.85 are highlighted in the review UI. The threshold is configurable per org.
        </li>
        <li>
          <strong>How do I correct a mistake?</strong> Click the field in the review UI and type
          the correct value. The correction is stored against the vendor and applied automatically
          to future documents from that vendor.
        </li>
        <li>
          <strong>How does the learning loop work in practice?</strong> After your first correction
          for a given vendor/category pair, the model applies that preference to all subsequent
          documents from the same vendor within your org. After several consistent corrections
          across multiple orgs, the cross-tenant signal updates too — benefiting everyone.
        </li>
      </ul>

      <h2 id="integrations">Integrations &amp; data flow</h2>
      <ul>
        <li>
          <strong>Do I have to leave Xero?</strong> No. slip/scan enhances Xero rather than
          replacing it — your accountant keeps working in Xero, you just stop manually capturing
          documents.
        </li>
        <li>
          <strong>What data does Stitch access?</strong> Stitch provides read-only access to your
          transaction history and account balances. slip/scan stores transaction amounts, dates,
          descriptions, and reference numbers. No credentials are stored.
        </li>
        <li>
          <strong>Where are my documents stored?</strong> Document files are stored encrypted at
          rest on Cloudflare R2 (geographically distributed). Extracted data lives in a
          row-level-security Neon Postgres database. See{" "}
          <Link to="/docs/security">Security</Link> for full details.
        </li>
        <li>
          <strong>Can I export everything?</strong> Yes. Every report has a CSV export. You can
          also export the full ledger from Settings, and request a complete data archive at any
          time.
        </li>
        <li>
          <strong>Can I delete an org?</strong> Yes, from <strong>Settings → Danger Zone</strong>.
          Deletion is irreversible and removes all documents, extracted data, and ledger entries
          after a 30-day grace period.
        </li>
      </ul>

      <h2 id="pricing">Pricing &amp; support</h2>
      <ul>
        <li>
          <strong>What&apos;s the early-access pricing?</strong> During early access, slip/scan is
          free for up to 100 documents per month. Paid tiers with higher limits and team features
          are coming soon.
        </li>
        <li>
          <strong>When does billing turn on?</strong> We&apos;ll give at least 30 days&apos; notice before
          any charges. Current users will receive a grandfathered rate.
        </li>
        <li>
          <strong>What&apos;s the refund policy?</strong> If you&apos;re ever charged for something you
          didn&apos;t intend, email us and we&apos;ll refund it, no questions asked.
        </li>
        <li>
          <strong>What&apos;s the support response time?</strong> Email{" "}
          <a href="mailto:hello@slipscan.app">hello@slipscan.app</a>. We aim to respond within
          one business day. Critical issues (data loss, billing errors) are handled within 4 hours.
        </li>
        <li>
          <strong>Where do I follow the changelog?</strong> At{" "}
          <Link to="/docs/changelog">/docs/changelog</Link>. Notable changes are also announced
          in the in-app notification feed.
        </li>
      </ul>

      <h2 id="security">Security &amp; compliance</h2>
      <p>
        Documents are stored encrypted at rest (AES-256) on Cloudflare R2. Database access is
        controlled via Neon row-level security — your data is never readable by another
        organisation. We do not train any models on your document content without explicit consent.
        Full details live in <Link to="/docs/security">/docs/security</Link> and our legal pages.
      </p>
    </DocsContent>
  );
}
