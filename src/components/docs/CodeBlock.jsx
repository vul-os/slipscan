import { useState } from "react";
import { Copy, Check } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * CodeBlock — styled <pre> with lang badge and copy button.
 * No syntax highlighting in v1 (keeps bundle small — no Prism/Shiki).
 *
 * @param {string}  lang      - language label shown in the badge
 * @param {string}  children  - raw code string
 * @param {boolean} showLines - prefix each line with its number
 */
export function CodeBlock({ lang, children = "", showLines = false, className }) {
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    navigator.clipboard.writeText(children).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  const lines = String(children).split("\n");
  // strip trailing blank line that comes from template literals
  if (lines[lines.length - 1] === "") lines.pop();

  return (
    <div className={cn("relative my-6 rounded-lg overflow-hidden", className)}>
      {/* lang badge */}
      {lang && (
        <span className="absolute top-2 right-10 text-[10px] uppercase tracking-wider text-ink-400 font-mono select-none pointer-events-none">
          {lang}
        </span>
      )}

      {/* copy button */}
      <button
        onClick={handleCopy}
        aria-label="Copy code"
        className="absolute top-2 right-2 p-1.5 rounded text-ink-500 hover:text-ink-200 hover:bg-ink-800 transition-colors"
      >
        {copied ? <Check size={14} /> : <Copy size={14} />}
      </button>

      <pre className="bg-ink-950 text-ink-100 rounded-lg p-4 pt-8 overflow-x-auto">
        <code className="font-mono text-[13px] leading-relaxed">
          {showLines
            ? lines.map((line, i) => (
                <span key={i} className="flex">
                  <span className="select-none text-ink-600 w-8 shrink-0 text-right mr-4">
                    {i + 1}
                  </span>
                  <span>{line}</span>
                </span>
              ))
            : lines.join("\n")}
        </code>
      </pre>
    </div>
  );
}
