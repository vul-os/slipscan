import { Link } from "react-router-dom";
import { DocsContent } from "@/components/docs/DocsContent";
import { Callout } from "@/components/docs/Callout";

export default function Concepts() {
  return (
    <DocsContent>
      <h1>Concepts</h1>

      <p className="lead">
        The core mental model behind slip/scan: organisations, members, document kinds, the
        classification engine, and how they interact. Understanding these concepts makes the rest of
        the product click into place.
      </p>

      <Callout variant="info">
        This page is being expanded with full diagrams and worked examples. In the meantime,
        the <Link to="/docs/quickstart">Quickstart</Link> covers the practical surface — you can
        start using slip/scan effectively without reading this page first.
      </Callout>
    </DocsContent>
  );
}
