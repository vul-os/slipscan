import { Link } from "react-router-dom";
import { DocsContent } from "@/components/docs/DocsContent";
import { Callout } from "@/components/docs/Callout";

export default function IntegrationsIndex() {
  return (
    <DocsContent>
      <h1>Integrations</h1>

      <p className="lead">
        slip/scan plays inside the stack you already run. Push to your ledger, pull in your feeds,
        loop in your team chat. This page links to every supported integration with its setup
        steps and capabilities.
      </p>

      <h2 id="xero">Xero <span className="text-[13px] font-normal text-ink-400 ml-2">Live</span></h2>
      <p>
        Two-way OAuth connection with your Xero organisation. Posting a document pushes a bill or
        journal entry to Xero with the original document attached as a file. Supports a default
        chart-of-accounts mapping that can be overridden per vendor. Required Xero scopes:{" "}
        <code>accounting.transactions</code>, <code>accounting.attachments</code>,{" "}
        <code>accounting.settings.read</code>. Setup: <strong>Settings → Integrations → Xero</strong>.{" "}
        <Link to="/docs/integrations/xero">Detailed setup guide →</Link>
      </p>

      <h2 id="stitch">Stitch bank feeds <span className="text-[13px] font-normal text-ink-400 ml-2">Live · SA</span></h2>
      <p>
        Read-only bank-account linking via Stitch&apos;s OAuth. Supported South African banks:
        Standard Bank, FNB, ABSA, Nedbank, Capitec, Investec, Discovery, and TymeBank. We never
        see your banking credentials — Stitch issues a consent token scoped to read-only
        transaction data. Feed transactions are pulled 4&times; per day and matched to your
        posted documents in the Reconcile queue. Setup:{" "}
        <strong>Settings → Integrations → Stitch</strong>.{" "}
        <Link to="/docs/integrations/stitch">Detailed setup guide →</Link>
      </p>

      <h2 id="gmail">Gmail forward-in <span className="text-[13px] font-normal text-ink-400 ml-2">Live</span></h2>
      <p>
        Every org gets a unique inbox alias: <code>&lt;your-slug&gt;@mail.slipscan.app</code>.
        Forwarded emails are fully parsed — the email body, every attachment (PDF, PNG, JPG), and
        inline images are all extracted. Practical tip: set up a Gmail filter that auto-forwards
        receipts from known senders (e.g. <code>@uber.com</code>, <code>@checkers.co.za</code>,
        your electricity provider) so they land in slip/scan without any manual step.{" "}
        <Link to="/docs/integrations/gmail">Setup guide →</Link>
      </p>

      <h2 id="slack">Slack <span className="text-[13px] font-normal text-ink-400 ml-2">Beta</span></h2>
      <p>
        A daily digest of new transactions awaiting review is posted to your chosen Slack channel.
        Per-channel approval flows let team members hit <strong>Approve</strong> directly in Slack
        — the action posts the document without opening the web app. Setup: Slack OAuth, pick the
        channel, then choose which event types you want notifications for (new uploads, match
        suggestions, budget alerts).{" "}
        <Link to="/docs/integrations/slack">Setup guide →</Link>
      </p>

      <h2 id="more">QuickBooks, Drive, Zapier &amp; API</h2>
      <p>
        <strong>QuickBooks (Beta)</strong> — same push model as Xero: post a document, it
        creates a bill in QuickBooks with attachment.{" "}
        <Link to="/docs/integrations/quickbooks">Setup guide →</Link>
      </p>
      <p>
        <strong>Google Drive</strong> — coming soon. Watch-folder sync so any receipt dropped
        into a nominated Drive folder is automatically ingested.
      </p>
      <p>
        <strong>Zapier</strong> — coming soon. Trigger flows on document events (posted,
        flagged, matched) and push data to 6 000+ apps.
      </p>
      <p>
        <strong>API &amp; Tokens</strong> — the public REST API lets you ingest documents
        programmatically, query the ledger, and trigger reconciliation runs. Authentication uses
        long-lived bearer tokens issued from <strong>Settings → Integrations → API</strong>.{" "}
        <Link to="/docs/integrations/api">API reference →</Link>
      </p>

      <Callout variant="info">
        Don&apos;t see an integration you need? Email{" "}
        <a href="mailto:hello@slipscan.app">hello@slipscan.app</a> — we prioritise integrations
        by demand.
      </Callout>
    </DocsContent>
  );
}
