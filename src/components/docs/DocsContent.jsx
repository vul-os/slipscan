import { cn } from "@/lib/cn";

/**
 * DocsContent — prose wrapper with the full Tailwind class chain from
 * Section B.4 of the landing plan.  No @tailwindcss/typography required.
 *
 * Write page content as plain JSX children:
 *   <h1>, <h2 id="...">, <p className="lead">, <ul>, <ol>, <code>, etc.
 *
 * Heading IDs must be set explicitly on h2/h3 so DocsToc can build the TOC.
 */
export function DocsContent({ children, className }) {
  return (
    <main
      className={cn(
        "docs-prose max-w-2xl xl:max-w-3xl w-full min-w-0",
        // base
        "text-[15px] leading-[1.7] text-ink-700",
        // headings
        "[&_h1]:text-[28px] sm:[&_h1]:text-[36px] lg:[&_h1]:text-[40px] [&_h1]:font-medium [&_h1]:tracking-tightest [&_h1]:text-ink-900 [&_h1]:mt-0 [&_h1]:mb-4",
        "[&_h2]:text-[20px] sm:[&_h2]:text-[24px] [&_h2]:font-medium [&_h2]:tracking-tighter [&_h2]:text-ink-900 [&_h2]:mt-10 sm:[&_h2]:mt-12 [&_h2]:mb-3 [&_h2]:scroll-mt-24",
        "[&_h3]:text-[18px] [&_h3]:font-medium [&_h3]:tracking-tight [&_h3]:text-ink-900 [&_h3]:mt-8 [&_h3]:mb-2 [&_h3]:scroll-mt-24",
        // anchor glyph on h2/h3 — low-opacity # that appears on group-hover
        "[&_h2]:relative [&_h3]:relative",
        // lead paragraph
        "[&_p.lead]:text-[18px] [&_p.lead]:leading-[1.6] [&_p.lead]:text-ink-600 [&_p.lead]:mb-8",
        // body paragraphs
        "[&_p]:my-4",
        // lists
        "[&_ul]:my-4 [&_ul]:pl-5 [&_ul]:list-disc [&_ul]:marker:text-ink-400",
        "[&_ol]:my-4 [&_ol]:pl-5 [&_ol]:list-decimal [&_ol]:marker:text-ink-400",
        "[&_li]:my-1.5",
        // inline code
        "[&_code:not(pre_code)]:font-mono [&_code:not(pre_code)]:text-[13px] [&_code:not(pre_code)]:bg-ink-100 [&_code:not(pre_code)]:text-ink-900 [&_code:not(pre_code)]:px-1.5 [&_code:not(pre_code)]:py-0.5 [&_code:not(pre_code)]:rounded",
        // pre
        "[&_pre]:bg-ink-950 [&_pre]:text-ink-100 [&_pre]:rounded-lg [&_pre]:p-4 [&_pre]:my-6 [&_pre]:overflow-x-auto",
        "[&_pre_code]:font-mono [&_pre_code]:text-[13px] [&_pre_code]:leading-relaxed",
        // blockquote
        "[&_blockquote]:border-l-2 [&_blockquote]:border-accent [&_blockquote]:pl-4 [&_blockquote]:italic [&_blockquote]:text-ink-600 [&_blockquote]:my-6",
        // links
        "[&_a]:text-ink-900 [&_a]:underline [&_a]:underline-offset-2 [&_a]:decoration-ink-300 [&_a:hover]:decoration-ink-700",
        // hr
        "[&_hr]:my-10 [&_hr]:border-ink-200",
        // kbd
        "[&_kbd]:font-mono [&_kbd]:text-[11px] [&_kbd]:bg-ink-100 [&_kbd]:text-ink-700 [&_kbd]:border [&_kbd]:border-ink-300 [&_kbd]:rounded [&_kbd]:px-1.5 [&_kbd]:py-0.5",
        className,
      )}
    >
      {children}
    </main>
  );
}
