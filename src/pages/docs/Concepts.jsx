import { Link } from "react-router-dom";
import { DocsContent } from "@/components/docs/DocsContent";
import { Callout } from "@/components/docs/Callout";

export default function Concepts() {
  return (
    <DocsContent>
      <h1>Concepts</h1>

      <p className="lead">
        This page covers the data model and the building blocks every other feature is built on.
        Understanding organisations, roles, the document-to-transaction flow, and the classification
        engine will make the rest of slip/scan click into place.
      </p>

      <h2 id="organisations">Organisations</h2>
      <p>
        An <strong>Organisation</strong> (Org) is slip/scan&apos;s fundamental unit of isolation. Every
        document, transaction, feed connection, and user preference is scoped to exactly one Org. At
        the database layer, Neon Postgres enforces Row-Level Security keyed by{" "}
        <code>org_id</code> — a query running in one Org&apos;s context cannot return rows from
        another, even if the underlying tables are shared.
      </p>
      <p>
        A single user account can belong to multiple Orgs simultaneously. Switching Orgs is
        instant and takes effect in the top-left selector without a full page reload. There are two
        Org kinds: <strong>Personal</strong> and <strong>Business</strong>. Personal Orgs expose the
        household budget and net-worth surface; Business Orgs expose the double-entry ledger, Chart
        of Accounts, and the Xero push integration. Both kinds share the same document capture
        pipeline, extraction engine, and bank-feed reconciler — only the reporting and accounting
        surface differs. An Org Owner can invite Members at any time from{" "}
        <strong>Settings → Members</strong>.
      </p>

      <h2 id="members-roles">Members and roles</h2>
      <p>
        Each Org has exactly one <strong>Owner</strong> (the creator, or a transferred ownership).
        The Owner can assign two additional roles — <strong>Admin</strong> and{" "}
        <strong>Member</strong> — to invited users.
      </p>
      <ul>
        <li>
          <strong>Owner</strong>: Full control. Can invite and remove users, modify the Chart of
          Accounts, approve and delete transactions, connect or disconnect integrations, and close
          the Org.
        </li>
        <li>
          <strong>Admin</strong>: Can invite Members, modify the Chart of Accounts, approve and
          post transactions, and read the audit log. Cannot remove the Owner or change billing.
        </li>
        <li>
          <strong>Member</strong>: Can upload documents, correct extractions, and post transactions.
          Cannot invite users, change account settings, or read the audit log.
        </li>
      </ul>
      <p>
        Role checks are enforced server-side on every write endpoint — they are not just a UI
        affordance. Every role change is recorded in the audit log with the acting user&apos;s ID and
        session.
      </p>

      <Callout variant="info">
        A per-action audit log viewable by Admins is available in-app. A dedicated{" "}
        <strong>/docs/features/audit</strong> page is in the works with full details on filtering
        and export.
      </Callout>

      <h2 id="documents-transactions">Documents and transactions</h2>
      <p>
        Every captured slip, invoice, or receipt becomes a <strong>Document</strong>. The Document
        is the primary artefact: it holds the original file (stored in Cloudflare R2), the raw
        extraction output, and the full correction history. A Document moves through a lifecycle:{" "}
        <em>processing → extracted → reviewed → posted</em>. Posting is the transition that
        matters for accounting.
      </p>
      <p>
        Once a Document is posted, the system creates one or more <strong>Transactions</strong> —
        the ledger entries that represent the financial event. A single receipt from a mixed
        supplier might produce two Transactions (goods + VAT, for example). The Transaction is
        what appears in reports, feeds reconciliation, and Xero sync. The original Document stays
        permanently attached to its Transactions so you can always trace a ledger entry back to
        the source image.
      </p>
      <p>
        Documents are never deleted from the ledger path once posted. Corrections at the
        Transaction level create amendment records, not overwrites, so the audit trail is always
        intact.
      </p>

      <h2 id="classification-engine">Classification engine</h2>
      <p>
        Classification assigns a ledger account or spending category to each Transaction. It runs
        in three layers, applied in order:
      </p>
      <ol>
        <li>
          <strong>Per-org rules (deterministic):</strong> Rules you define explicitly — e.g.{" "}
          &quot;vendor name contains &apos;Uber&apos; → Travel.&quot; Rules always win. You define them in{" "}
          <strong>Settings → Classification Rules</strong>.
        </li>
        <li>
          <strong>Org-learned patterns (probabilistic):</strong> As you correct classifications,
          the system records the vendor ↔ category preference for your Org. Future documents from
          that vendor inherit the preference automatically, with a high-confidence score.
        </li>
        <li>
          <strong>Platform-wide priors (probabilistic):</strong> When there is no local signal —
          a new vendor, a new Org — the engine falls back to cross-tenant merchant signals
          accumulated (with consent) across the platform. This means a new Org gets reasonable
          first-guess classifications immediately, without any training period.
        </li>
      </ol>
      <p>
        Each prediction is labelled with its source layer in the review UI, so you always know
        whether a suggestion came from your own rules, your org&apos;s history, or the platform prior.
        You can pin any vendor-to-category mapping to promote it from a learned pattern to a hard
        rule.
      </p>

      <h2 id="confidence-scores">Confidence scores</h2>
      <p>
        Every field extracted from a Document — vendor name, date, total, line items, VAT amount,
        currency — carries a <strong>confidence score</strong> between 0 and 1. The score reflects
        how certain the extraction model is about that specific value. The system has two default
        thresholds:
      </p>
      <ul>
        <li>
          <strong>≥ 0.95:</strong> Auto-accepted. The field is treated as correct without requiring
          a human review step.
        </li>
        <li>
          <strong>&lt; 0.80:</strong> Flagged for human review. The field is highlighted in the
          review UI and the Document will not auto-post until it is confirmed or corrected.
        </li>
      </ul>
      <p>
        Both thresholds are configurable per-Org from <strong>Settings → Extraction</strong>. A
        high-trust Org processing predictable invoice formats might raise the auto-accept threshold
        to 0.98; a lower-volume Org that wants to review everything can set it to 1.0 to force a
        human step on every document.
      </p>

      <h2 id="bank-feeds-reconciliation">Bank feeds and reconciliation</h2>
      <p>
        Bank feeds connect your actual bank account to slip/scan using <strong>Stitch</strong>, a
        regulated South African Open Finance provider. The connection is read-only OAuth — slip/scan
        never sees your banking credentials and cannot initiate transactions. You authorise Stitch
        from your bank&apos;s own authentication flow, and Stitch issues a consent token that we use
        to pull transaction data.
      </p>
      <p>
        Feed transactions sync four times per day. Each sync runs the{" "}
        <strong>reconciler</strong>, which tries to match every incoming feed transaction to a posted
        Document using three signals: amount (exact match), date (within a configurable window, default
        ±3 days), and merchant name similarity (fuzzy string match with a minimum threshold).
        When all three signals agree, the reconciler creates a high-confidence match suggestion.
        Confirming a match closes both the feed transaction and the Document&apos;s open reconciliation
        status. Unmatched feed transactions appear as candidates in the Reconcile queue and can be
        linked manually to any Document, or used to create a new journal entry for spend that was
        never captured as a receipt.
      </p>

      <Callout variant="tip">
        New to slip/scan? The <Link to="/docs/quickstart">Quickstart</Link> walks you through
        capturing your first document and posting a transaction in under a minute.
      </Callout>
    </DocsContent>
  );
}
