import { Link } from "react-router-dom";
import { DocsContent } from "@/components/docs/DocsContent";
import { Callout } from "@/components/docs/Callout";
import { KbdKey } from "@/components/docs/KbdKey";

export default function Quickstart() {
  return (
    <DocsContent>
      <h1>Your first scan in 60 seconds</h1>

      <p className="lead">
        From signup to a posted, categorised transaction in under a minute. This walk-through
        assumes you have a slip on your phone and a free slip/scan account.
      </p>

      <h2 id="step-1-create-your-org">Step 1 — Create your org</h2>
      <p>
        Sign up at <Link to="/register">/register</Link>, then pick <strong>Personal</strong> or{" "}
        <strong>Business</strong> during the onboarding flow (you can run both from the same login
        later). You&apos;ll get a workspace and a unique inbox alias:{" "}
        <code>&lt;your-slug&gt;@mail.slipscan.app</code>.
      </p>

      <h2 id="step-2-drop-in-a-slip">Step 2 — Drop in a slip</h2>
      <p>Three ways to get a document into slip/scan:</p>
      <ol>
        <li>
          <strong>Mobile:</strong> Open the Receipts page on your phone, tap the upload button,
          and take a photo. Processing starts immediately.
        </li>
        <li>
          <strong>Email:</strong> Forward any receipt to your inbox alias. We&apos;ll process it
          in under a minute — attachments, inline images, and HTML receipt bodies all parsed.
        </li>
        <li>
          <strong>Drag-and-drop:</strong> From your desktop, drop a PDF or photo directly onto
          the Receipts page.
        </li>
      </ol>

      <h2 id="step-3-verify-and-post">Step 3 — Verify and post</h2>
      <p>
        Open the new document. Skim the extracted fields — vendor, date, totals, line items, VAT,
        and FX rate if applicable. Confidence chips show what the model is sure of; low-confidence
        fields are highlighted for your attention. Fix anything that&apos;s wrong — we&apos;ll
        remember the correction and apply it to future documents from the same vendor. Then hit{" "}
        <strong>Post</strong> or press <KbdKey>S</KbdKey> on the keyboard. The transaction is now
        in your ledger.
      </p>

      <h2 id="step-4-connect-xero">Step 4 — Connect Xero (optional)</h2>
      <p>
        Go to <strong>Settings → Integrations → Xero</strong>. Pick your Xero organisation and
        set the default chart-of-accounts mapping. From now on, hitting Post also pushes a bill or
        journal entry to Xero — with the original document attached.
      </p>

      <h2 id="step-5-add-a-bank-feed">Step 5 — Add a bank feed (optional)</h2>
      <p>
        Go to <strong>Settings → Integrations → Stitch</strong>. Authorise read-only access to
        your bank account. Initial sync can take up to 24 hours. After that, feeds refresh four
        times daily and matching runs on each refresh. See the Reconcile page for the match
        queue — a single keystroke accepts a match.
      </p>

      <Callout variant="tip">
        Next: read <Link to="/docs/concepts">/docs/concepts</Link> to learn how orgs, members,
        and the classification engine fit together.
      </Callout>
    </DocsContent>
  );
}
