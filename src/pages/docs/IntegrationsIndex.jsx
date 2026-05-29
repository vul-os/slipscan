import { DocsContent } from "@/components/docs/DocsContent";
import { Callout } from "@/components/docs/Callout";

export default function IntegrationsIndex() {
  return (
    <DocsContent>
      <h1>Integrations</h1>

      <p className="lead">
        slip/scan plays inside the stack you already run. Push to your ledger, pull in your feeds,
        forward slips by email. This page covers every supported integration with its setup steps
        and capabilities.
      </p>

      <h2 id="xero">Xero <span className="text-[13px] font-normal text-ink-400 ml-2">Live</span></h2>
      <p>
        Two-way OAuth connection with your Xero organisation. Posting a document pushes a bill or
        journal entry to Xero with the original document attached as a file. Supports a default
        chart-of-accounts mapping that can be overridden per vendor. Required Xero scopes:{" "}
        <code>accounting.transactions</code>, <code>accounting.attachments</code>,{" "}
        <code>accounting.settings.read</code>.
      </p>
      <ol>
        <li>Go to <strong>Settings → Integrations → Xero</strong> and click <strong>Connect Xero</strong>.</li>
        <li>Sign in to your Xero account and select the organisation to link.</li>
        <li>Approve the requested scopes — slip/scan requests the minimum needed to push bills and attachments.</li>
        <li>Back in slip/scan, set your default chart-of-accounts mapping under <strong>Xero Settings → Default Account</strong>.</li>
        <li>Post any document — the bill will appear in Xero within seconds, with the original file attached.</li>
      </ol>

      <h2 id="stitch">Stitch bank feeds <span className="text-[13px] font-normal text-ink-400 ml-2">Live · SA</span></h2>
      <p>
        Read-only bank-account linking via Stitch&apos;s OAuth. Supported South African banks:
        Standard Bank, FNB, ABSA, Nedbank, Capitec, Investec, Discovery, and TymeBank. We never
        see your banking credentials — Stitch issues a consent token scoped to read-only
        transaction data. Feed transactions are pulled 4&times; per day and matched to your
        posted documents in the Reconcile queue.
      </p>
      <ol>
        <li>Go to <strong>Settings → Integrations → Stitch</strong> and click <strong>Connect bank account</strong>.</li>
        <li>Select your bank from the Stitch modal and complete your bank&apos;s own authentication flow.</li>
        <li>Approve read-only access. Stitch will redirect you back to slip/scan once consent is granted.</li>
        <li>Initial sync can take up to 24 hours. After that, feeds refresh four times daily automatically.</li>
        <li>Open the <strong>Reconcile</strong> page to review match suggestions. A single keystroke accepts a match.</li>
      </ol>

      <h2 id="gmail">Gmail forward-in <span className="text-[13px] font-normal text-ink-400 ml-2">Live</span></h2>
      <p>
        Every org gets a unique inbox alias: <code>&lt;your-slug&gt;@mail.slipscan.app</code>.
        Forwarded emails are fully parsed — the email body, every attachment (PDF, PNG, JPG), and
        inline images are all extracted. Practical tip: set up a Gmail filter that auto-forwards
        receipts from known senders (e.g. <code>@uber.com</code>, <code>@checkers.co.za</code>,
        your electricity provider) so they land in slip/scan without any manual step.
      </p>
      <ol>
        <li>Find your inbox alias under <strong>Settings → Integrations → Email inbox</strong>. Copy it.</li>
        <li>In Gmail, open <strong>Settings → Filters and Blocked Addresses → Create a new filter</strong>.</li>
        <li>Set <em>From</em> to the sender domains you want to forward (e.g. <code>@uber.com</code>).</li>
        <li>Choose <strong>Forward to</strong> and paste your slip/scan inbox alias. Save the filter.</li>
        <li>Gmail will ask you to confirm the forwarding address — click the link in the confirmation email that slip/scan sends back.</li>
      </ol>

      <h2 id="api">API &amp; Tokens</h2>
      <p>
        The public REST API lets you ingest documents programmatically, query the ledger, and
        trigger reconciliation runs. Authentication uses long-lived bearer tokens.
      </p>
      <ol>
        <li>Go to <strong>Settings → Integrations → API</strong> and click <strong>Generate token</strong>.</li>
        <li>Name the token (e.g. &quot;CI pipeline&quot;) and copy it — it is only shown once.</li>
        <li>Pass the token as a <code>Bearer</code> header: <code>Authorization: Bearer &lt;token&gt;</code>.</li>
        <li>
          To ingest a document: <code>POST /v1/documents</code> with the file as{" "}
          <code>multipart/form-data</code>. The response includes a <code>document_id</code> you
          can poll for extraction status.
        </li>
        <li>Revoke tokens at any time from <strong>Settings → Integrations → API</strong>.</li>
      </ol>

      <Callout variant="info">
        Don&apos;t see an integration you need? Email{" "}
        <a href="mailto:hello@slipscan.app">hello@slipscan.app</a> — we prioritise integrations
        by demand.
      </Callout>
    </DocsContent>
  );
}
