import { Link } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { Wordmark } from "@/components/Wordmark";

export default function NotFoundPage() {
  return (
    <div className="min-h-screen flex flex-col">
      <header className="px-8 py-6">
        <Link to="/"><Wordmark /></Link>
      </header>
      <main className="flex-1 flex items-center justify-center px-6">
        <div className="text-center">
          <p className="label-eyebrow mb-3">Error · 404</p>
          <h1 className="text-display-xl text-ink-900">Page not found</h1>
          <p className="mt-3 text-ink-500 max-w-md mx-auto">
            The page you're looking for doesn't exist, or it's been moved.
          </p>
          <div className="mt-8 flex flex-col sm:flex-row items-center justify-center gap-3">
            <Button asChild><Link to="/">Back to home</Link></Button>
            <Link
              to="/docs"
              className="text-sm text-ink-500 hover:text-ink-900 underline underline-offset-4 decoration-ink-300 hover:decoration-ink-700 transition-colors"
            >
              Or read the docs →
            </Link>
          </div>
        </div>
      </main>
    </div>
  );
}
