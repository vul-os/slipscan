import { DocsContent } from "@/components/docs/DocsContent";
import { Callout } from "@/components/docs/Callout";

export default function Security() {
  return (
    <DocsContent>
      <h1>Security &amp; Compliance</h1>

      <p className="lead">
        slip/scan stores financial documents and bank-feed credentials on your behalf. This page
        describes exactly where your data lives, how it is protected in transit and at rest, what
        access controls are in place, and where we are in relation to formal compliance
        certifications. We aim to be specific rather than vague — if something is not yet in place,
        we say so.
      </p>

      <h2 id="data-storage">Where your data lives</h2>
      <p>
        Document files (photos, PDFs, email attachments) are stored on{" "}
        <strong>Cloudflare R2</strong> with regional data residency. Postgres rows — org data,
        transactions, extraction results, audit logs — are stored in{" "}
        <strong>Neon Postgres</strong> with Row-Level Security enforced at the database layer.
        Every query that touches user data is filtered by <code>org_id</code>; there is no API
        path, no background job, and no admin query that can return rows from two different Orgs in
        a single result set. Cross-tenant data access is not possible at the DB layer, not just at
        the application layer.
      </p>
      <p>
        Extracted text, classification results, and metadata are co-located with the document rows
        in Neon. No third-party analytics or data-warehouse service receives your document content
        unless you explicitly enable an integration (e.g. Xero).
      </p>

      <h2 id="encryption">Encryption</h2>
      <p>
        All traffic between your browser or mobile client and slip/scan is encrypted with{" "}
        <strong>TLS 1.2+</strong>. Cloudflare terminates TLS at the edge; traffic between
        Cloudflare and origin workers travels over Cloudflare&apos;s private backbone with its own
        encryption layer.
      </p>
      <p>
        Data at rest is protected with <strong>AES-256</strong> in both R2 (Cloudflare-managed
        keys) and Neon Postgres (transparent data encryption). Document URLs in R2 are
        <strong> signed and time-limited</strong> — a URL returned by the API is valid for a fixed
        window (default 1 hour) and is bound to the requesting session. Sharing or leaking a
        pre-signed URL does not expose the document beyond that window.
      </p>

      <h2 id="bank-feed-credentials">Bank-feed credentials</h2>
      <p>
        slip/scan connects to SA banks via <strong>Stitch</strong>, a regulated Open Finance
        provider. Your banking credentials — username, password, and OTP — are entered into
        Stitch&apos;s own authentication flow, not into slip/scan. We never receive, store, or
        transmit your banking credentials. What we hold is a Stitch OAuth consent token scoped to
        read-only transaction data for the specific account you authorised.
      </p>
      <p>
        To revoke access, go to your Stitch portal (or your bank&apos;s third-party consent manager)
        and revoke the slip/scan consent. Revocation takes effect immediately — no new feed data
        will flow in after that point. Existing feed transactions already synced remain in your
        slip/scan ledger (they are your financial records); only future syncs stop.
      </p>

      <h2 id="authentication">Authentication</h2>
      <p>
        slip/scan supports two sign-in methods:
      </p>
      <ul>
        <li>
          <strong>Email + password:</strong> Passwords are hashed with bcrypt at cost factor 12
          before storage. Plain-text passwords are never stored and cannot be recovered — only
          reset via a time-limited email link.
        </li>
        <li>
          <strong>Sign in with Google:</strong> OAuth2 with PKCE. We receive your Google profile
          email and display name; we do not receive access to your Google account, Drive, or Gmail
          unless you explicitly connect those integrations separately.
        </li>
      </ul>
      <p>
        Sessions are JWTs with a 15-minute access token lifetime and a 7-day sliding refresh
        token. Tokens are currently stored in <code>localStorage</code>. We intend to move to
        HttpOnly cookies when we add SSO support for accountants accessing multiple client orgs —
        that change will be noted in the changelog.
      </p>

      <h2 id="access-controls">Access controls</h2>
      <p>
        Owner, Admin, and Member roles are enforced server-side on every write operation. Role
        checks are not a front-end affordance — the API returns <code>403</code> for operations
        the caller&apos;s role does not permit, regardless of what the UI shows. Every write
        operation (document upload, field correction, transaction post, rule change, user invite) is
        logged in the <strong>audit log</strong> with the user ID, session ID, source IP, action
        type, and a before/after diff of the changed record.
      </p>
      <p>
        Admins and Owners can read the audit log from the in-app Audit page. The log is
        filterable by user, action type, and date range, and exportable to CSV. Audit log entries
        are immutable — no role, including Owner, can delete them.
      </p>

      <h2 id="compliance">Compliance</h2>
      <p>
        slip/scan is based in South Africa and designed to align with the{" "}
        <strong>Protection of Personal Information Act (POPIA)</strong>. We collect only the data
        necessary to provide the service, provide a data deletion request mechanism from{" "}
        <strong>Settings → Account → Delete account</strong>, and do not sell personal data to
        third parties.
      </p>

      <Callout variant="warn">
        slip/scan is not yet SOC 2 Type II or ISO 27001 certified. We are not yet independently
        audited. Business-tier customers who require a security review document for their own
        procurement process can request one at{" "}
        <a href="mailto:security@slipscan.app">security@slipscan.app</a>.
      </Callout>

      <h2 id="responsible-disclosure">Responsible disclosure</h2>
      <p>
        If you discover a security vulnerability in slip/scan, please email{" "}
        <a href="mailto:security@slipscan.app">security@slipscan.app</a>. We respond to all
        reports within 3 business days. Please do not publish a vulnerability publicly until we
        have had a chance to investigate and issue a fix. We do not currently operate a formal bug
        bounty programme, but we will credit researchers in our changelog with their permission.
      </p>
    </DocsContent>
  );
}
