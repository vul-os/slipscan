import { Outlet, Link, Navigate } from "react-router-dom";
import { Wordmark } from "@/components/Wordmark";
import { useAuthStore } from "@/stores/auth";

// Centred narrow auth layout. The right pane carries the brand "feel" —
// generous space, big quiet headline, anchored by an oversized logo mark
// so the brand is the first thing you see. Already-authed users skip
// straight past the auth screens.
export default function AuthLayout() {
  const isAuthed = !!useAuthStore((s) => s.accessToken);
  if (isAuthed) return <Navigate to="/dashboard" replace />;

  return (
    <div className="min-h-screen grid lg:grid-cols-[minmax(420px,560px)_1fr] bg-ink-0">
      <div className="flex flex-col">
        <header className="px-8 lg:px-12 py-6">
          <Link to="/" className="inline-flex" aria-label="slip/scan home">
            <Wordmark size="md" />
          </Link>
        </header>
        <main className="flex-1 flex items-center justify-center px-8 lg:px-12 pb-16">
          <div className="w-full max-w-sm">
            <Outlet />
          </div>
        </main>
        <footer className="px-8 lg:px-12 py-6 flex items-center justify-between text-[12px] text-ink-400">
          <span>© {new Date().getFullYear()} slip/scan</span>
          <span className="hidden sm:inline">Receipts, structured.</span>
        </footer>
      </div>

      <aside className="hidden lg:flex relative bg-ink-950 text-ink-0 overflow-hidden">
        <div
          className="absolute inset-0 opacity-[0.10]"
          style={{
            backgroundImage:
              "radial-gradient(circle at 78% 22%, rgb(200 255 0 / 1) 0%, transparent 55%)",
          }}
          aria-hidden
        />

        <div
          className="absolute inset-0 opacity-[0.04]"
          style={{
            backgroundImage:
              "linear-gradient(to right, #ffffff 1px, transparent 1px), linear-gradient(to bottom, #ffffff 1px, transparent 1px)",
            backgroundSize: "64px 64px",
          }}
          aria-hidden
        />

        <div className="absolute -right-24 -top-24 select-none pointer-events-none" aria-hidden>
          <img
            src="/images/logo-mark.svg"
            width={520}
            height={520}
            alt=""
            draggable={false}
            className="opacity-[0.14]"
          />
        </div>

        <div className="relative flex flex-col justify-between p-12 lg:p-16 w-full max-w-2xl">
          <Wordmark size="md" tone="dark" />

          <div>
            <p className="label-eyebrow !text-accent">Receipts, structured</p>
            <h1 className="mt-4 text-display-xl text-ink-0">
              Drop in a slip.{" "}
              <span className="text-accent">We'll do the rest.</span>
            </h1>
            <p className="mt-6 text-base text-ink-400 max-w-md leading-relaxed">
              Snap, scan, and verify. slip/scan turns crumpled receipts
              into clean, queryable data your team can actually use.
            </p>

            <ul className="mt-10 space-y-3 text-sm text-ink-300">
              {[
                "Merchant, total, tax & line items extracted automatically.",
                "Shared across your whole organization — one source of truth.",
                "Export to CSV the moment your accountant needs it.",
              ].map((line) => (
                <li key={line} className="flex gap-3">
                  <span className="mt-2 h-1 w-1 rounded-full bg-accent shrink-0" />
                  <span>{line}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </aside>
    </div>
  );
}
