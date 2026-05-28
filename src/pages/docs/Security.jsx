import { DocsContent } from "@/components/docs/DocsContent";
import { Callout } from "@/components/docs/Callout";

export default function Security() {
  return (
    <DocsContent>
      <h1>Security &amp; Compliance</h1>

      <p className="lead">
        slip/scan is built on infrastructure designed for financial data: document files are stored
        encrypted at rest on Cloudflare R2, bank feeds flow through Stitch&apos;s regulated OAuth
        layer, and every database query is gated by Neon row-level security so no organisation can
        ever read another&apos;s data.
      </p>

      <Callout variant="tip">
        A full security white-paper — covering encryption standards, audit controls, data
        residency, penetration testing, and compliance certifications — is being finalised and will
        appear on this page shortly.
      </Callout>
    </DocsContent>
  );
}
