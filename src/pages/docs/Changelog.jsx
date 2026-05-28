import { DocsContent } from "@/components/docs/DocsContent";
import { Callout } from "@/components/docs/Callout";

export default function Changelog() {
  return (
    <DocsContent>
      <h1>Changelog</h1>

      <p className="lead">
        Notable changes to slip/scan, most recent first. For patch-level fixes see the{" "}
        <a href="https://github.com/anthropics/slipscan/releases" target="_blank" rel="noopener noreferrer">
          GitHub releases page
        </a>.
      </p>

      <h2 id="2026-05-28">2026-05-28</h2>
      <ul>
        <li>
          <strong>Docs site launched.</strong> Full /docs surface live at slipscan.app/docs —
          Introduction, Quickstart, Features, Integrations, FAQ, Security, and Changelog pages.
        </li>
        <li>
          <strong>Sign in with Google.</strong> OAuth2 login via Google account is now available
          on the sign-in page alongside email/password.
        </li>
        <li>
          <strong>Outbound email via Resend.</strong> Verification emails and password-reset links
          are now sent through Resend for improved deliverability. Check your spam folder if you
          don&apos;t receive a verification email within 60 seconds.
        </li>
        <li>
          <strong>Cloudflare R2 document storage.</strong> Document files are now stored on
          Cloudflare R2 with global replication and AES-256 encryption at rest.
        </li>
        <li>
          <strong>Email worker inbound pipeline.</strong> The{" "}
          <code>&lt;slug&gt;@mail.slipscan.app</code> inbox now processes forwarded receipts
          end-to-end — attachments, inline images, and HTML email bodies.
        </li>
      </ul>

      <h2 id="2026-04-14">2026-04-14</h2>
      <ul>
        <li>
          <strong>Bank feeds &amp; Reconcile (beta).</strong> Stitch integration live for
          Standard Bank, FNB, ABSA, Nedbank, Capitec, Investec, Discovery, and TymeBank.
          Feed transactions matched 4&times; per day against posted documents.
        </li>
        <li>
          <strong>Accountant Workspace.</strong> Multi-client inbox, attention queue, and
          cross-org anomaly detection rolled out to all accounts.
        </li>
        <li>
          <strong>Reports &amp; Ask.</strong> P&amp;L, spending breakdown, and VAT summary
          reports available for both Business and Personal orgs. Natural-language Ask surface
          with cited-receipt answers.
        </li>
        <li>
          <strong>Xero integration GA.</strong> Two-way Xero sync (bills, journals, attachments)
          promoted from beta to generally available.
        </li>
        <li>
          <strong>Classification learning loop.</strong> Per-vendor correction preferences now
          persist and apply automatically to future documents. Cross-tenant merchant signal
          bootstraps classification for new orgs.
        </li>
      </ul>

      <Callout variant="info">
        Subscribe to changelog notifications from{" "}
        <strong>Settings → Notifications → Product updates</strong> to be notified of new
        releases in-app.
      </Callout>
    </DocsContent>
  );
}
