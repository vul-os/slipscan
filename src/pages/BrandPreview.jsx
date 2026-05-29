// Brand preview — internal route at /_brand.
// Renders all logo concepts at 32 / 64 / 128 px, mark + lockup, on light AND
// dark backgrounds. For picking the winning concept.

import LogoConcept1 from "@/components/brand/LogoConcept1";
import LogoConcept2 from "@/components/brand/LogoConcept2";
import LogoConcept3 from "@/components/brand/LogoConcept3";
import LogoConcept4 from "@/components/brand/LogoConcept4";
import LogoConcept5 from "@/components/brand/LogoConcept5";

const CONCEPTS = [
  {
    id: 1,
    name: "Slash refined",
    blurb: "Scan-window frame + intentional slash. The original slash, dignified.",
    Concept: LogoConcept1,
  },
  {
    id: 2,
    name: "Receipt corner",
    blurb: "Folded paper with a lime scan line. Literal but well-crafted.",
    Concept: LogoConcept2,
  },
  {
    id: 3,
    name: "S monogram",
    blurb: "Geometric S from two diagonal arms. The two S's of slip/scan.",
    Concept: LogoConcept3,
  },
  {
    id: 4,
    name: "Scan reticle",
    blurb: "Camera viewfinder corners + lime slash focal. Technical.",
    Concept: LogoConcept4,
  },
  {
    id: 5,
    name: "Stacked slashes",
    blurb: "Two parallel slashes — the lime one is the capture trail.",
    Concept: LogoConcept5,
  },
];

const SIZES = [32, 64, 128];

function FaviconStrip({ Mark, bg }) {
  // Tiny-size stress test — favicon territory
  return (
    <div className="flex items-center gap-3">
      {[12, 14, 16, 20, 24].map((s) => (
        <div key={s} className="flex flex-col items-center gap-1">
          <Mark size={s} bg={bg} />
          <span className="text-[10px] font-mono text-ink-500">{s}</span>
        </div>
      ))}
    </div>
  );
}

function ConceptCard({ concept }) {
  const { id, name, blurb, Concept } = concept;
  const { Mark, Lockup } = Concept;

  return (
    <section className="border border-ink-200 rounded-xl overflow-hidden bg-white">
      {/* Header */}
      <div className="px-6 py-4 border-b border-ink-200 flex items-baseline justify-between">
        <div>
          <h2 className="text-display text-ink-900">
            <span className="text-ink-400 font-mono text-base mr-3">
              0{id}
            </span>
            {name}
          </h2>
          <p className="text-sm text-ink-500 mt-1">{blurb}</p>
        </div>
      </div>

      {/* Light bg row */}
      <div className="px-6 py-8 bg-ink-50 border-b border-ink-200">
        <div className="label-eyebrow mb-6 text-ink-500">On light</div>
        <div className="grid grid-cols-[auto_1fr] gap-x-12 gap-y-8 items-center">
          {/* Marks at sizes */}
          <div className="text-xs font-mono text-ink-500 uppercase tracking-wider">
            Mark
          </div>
          <div className="flex items-end gap-8">
            {SIZES.map((s) => (
              <div key={s} className="flex flex-col items-center gap-2">
                <Mark size={s} bg="light" />
                <span className="text-[10px] font-mono text-ink-500">
                  {s}px
                </span>
              </div>
            ))}
          </div>

          {/* Lockups */}
          <div className="text-xs font-mono text-ink-500 uppercase tracking-wider">
            Lockup
          </div>
          <div className="flex flex-col items-start gap-6">
            <Lockup size={32} bg="light" />
            <Lockup size={48} bg="light" />
            <Lockup size={64} bg="light" />
          </div>

          {/* Favicon stress */}
          <div className="text-xs font-mono text-ink-500 uppercase tracking-wider">
            Favicon
          </div>
          <FaviconStrip Mark={Mark} bg="light" />
        </div>
      </div>

      {/* Dark bg row */}
      <div className="px-6 py-8 bg-ink-950">
        <div className="label-eyebrow mb-6 text-ink-400">On dark</div>
        <div className="grid grid-cols-[auto_1fr] gap-x-12 gap-y-8 items-center">
          <div className="text-xs font-mono text-ink-400 uppercase tracking-wider">
            Mark
          </div>
          <div className="flex items-end gap-8">
            {SIZES.map((s) => (
              <div key={s} className="flex flex-col items-center gap-2">
                <Mark size={s} bg="dark" />
                <span className="text-[10px] font-mono text-ink-400">
                  {s}px
                </span>
              </div>
            ))}
          </div>

          <div className="text-xs font-mono text-ink-400 uppercase tracking-wider">
            Lockup
          </div>
          <div className="flex flex-col items-start gap-6">
            <Lockup size={32} bg="dark" />
            <Lockup size={48} bg="dark" />
            <Lockup size={64} bg="dark" />
          </div>

          <div className="text-xs font-mono text-ink-400 uppercase tracking-wider">
            Favicon
          </div>
          <FaviconStrip Mark={Mark} bg="dark" />
        </div>
      </div>

      {/* In-context: sidebar simulation */}
      <div className="grid grid-cols-2 border-t border-ink-200">
        <div className="px-6 py-4 bg-white border-r border-ink-200">
          <div className="text-[10px] font-mono text-ink-400 uppercase tracking-wider mb-3">
            Sidebar (light)
          </div>
          <div className="flex items-center gap-2.5">
            <Mark size={26} bg="light" />
            <span
              style={{
                fontFamily: "Inter, sans-serif",
                fontWeight: 500,
                fontSize: 17,
                letterSpacing: "-0.04em",
                color: "#0A0A0A",
              }}
            >
              <span>slip</span>
              <span style={{ color: "#9FCC00" }}>/</span>
              <span>scan</span>
            </span>
          </div>
        </div>
        <div className="px-6 py-4 bg-ink-950">
          <div className="text-[10px] font-mono text-ink-400 uppercase tracking-wider mb-3">
            Sidebar (dark)
          </div>
          <div className="flex items-center gap-2.5">
            <Mark size={26} bg="dark" />
            <span
              style={{
                fontFamily: "Inter, sans-serif",
                fontWeight: 500,
                fontSize: 17,
                letterSpacing: "-0.04em",
                color: "#FAFAFA",
              }}
            >
              <span>slip</span>
              <span style={{ color: "#C8FF00" }}>/</span>
              <span>scan</span>
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}

export default function BrandPreviewPage() {
  return (
    <div className="min-h-screen bg-ink-100">
      <header className="px-8 py-10 max-w-6xl mx-auto">
        <p className="label-eyebrow text-ink-500 mb-2">Internal · /_brand</p>
        <h1 className="text-display-xl text-ink-900">Brand mark explorations</h1>
        <p className="mt-3 text-ink-600 max-w-2xl">
          Five concept directions for the slip/scan mark + lockup. Each is shown
          at 32 / 64 / 128 px, plus a favicon-size stress strip and an in-context
          sidebar mock. Pick a winner.
        </p>
      </header>

      <main className="px-8 pb-20 max-w-6xl mx-auto space-y-10">
        {CONCEPTS.map((c) => (
          <ConceptCard key={c.id} concept={c} />
        ))}
      </main>
    </div>
  );
}
