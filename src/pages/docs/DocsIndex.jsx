import { Link } from "react-router-dom";
import { DocsContent } from "@/components/docs/DocsContent";
import { Callout } from "@/components/docs/Callout";

export default function DocsIndex() {
  return (
    <DocsContent>
      <h1>slip/scan — Documentation</h1>

      <p className="lead">
        slip/scan turns documents (receipts, invoices, bank statements) into clean, classified,
        queryable data. This site is the reference for everything you can do with it — from your
        first scan to setting up an accountant&apos;s multi-client workspace.
      </p>

      <h2 id="what-you-can-do">What you can do</h2>
      <ul>
        <li>Capture documents from phone, email, Drive, or paste.</li>
        <li>Extract every field with confidence scores.</li>
        <li>Classify transactions — and have the system learn your preferences.</li>
        <li>Reconcile against your bank feeds (Stitch, SA).</li>
        <li>Push to Xero/QuickBooks or run the ledger natively.</li>
      </ul>

      <h2 id="who-its-for">Who it&apos;s for</h2>
      <p>
        Personal users running a Vault-style spending overview. SMBs running books in-house.
        Accountants managing many clients from a single workspace. One product, three surfaces —
        the same extraction and classification engine underneath.
      </p>

      <h2 id="how-this-site-is-organised">How this site is organised</h2>
      <p>
        <strong>Getting Started</strong> covers setup — from creating your first org to your first
        posted transaction. <strong>Features</strong> documents each of the eight product surfaces
        in detail. <strong>Integrations</strong> covers the third-party connections (Xero, Stitch,
        Gmail, Slack, QuickBooks). <strong>Reference</strong> holds the FAQ, security posture, and
        the changelog.
      </p>

      <h2 id="where-to-start">Where to start</h2>

      <div className="grid sm:grid-cols-2 gap-4 my-6 not-prose">
        <Callout variant="tip">
          <strong>New here?</strong>
          <br />
          Work through the <Link to="/docs/quickstart" className="underline">Quickstart</Link> —
          you&apos;ll have a posted, categorised transaction in under 60 seconds.
        </Callout>

        <Callout variant="info">
          <strong>Migrating from Dext or Hubdoc?</strong>
          <br />
          A dedicated migration guide is on its way. In the meantime, the{" "}
          <Link to="/docs/features" className="underline">Features</Link> page maps each
          capability so you can find your bearings.
        </Callout>
      </div>
    </DocsContent>
  );
}
