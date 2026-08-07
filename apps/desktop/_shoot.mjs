import { chromium } from "playwright";

// Scroll the whole page in steps first. The landing reveals sections with an
// IntersectionObserver, and a fullPage screenshot does NOT scroll — so a
// naive capture returns a page of blank gaps that look like a layout bug.
const [outDir, theme = "dark", width = "1600"] = process.argv.slice(2);

const b = await chromium.launch();
const p = await b.newPage({
  viewport: { width: Number(width), height: 1000 },
  deviceScaleFactor: 1,
  colorScheme: theme === "light" ? "light" : "dark",
});
await p.addInitScript((t) => {
  try { localStorage.setItem("slipscan-site-theme", t); } catch {}
}, theme);

await p.goto("http://localhost:8899/index.html", { waitUntil: "networkidle" });
await p.evaluate(async () => {
  const step = window.innerHeight * 0.6;
  for (let y = 0; y < document.body.scrollHeight; y += step) {
    window.scrollTo(0, y);
    await new Promise((r) => setTimeout(r, 120));
  }
  window.scrollTo(0, 0);
  await new Promise((r) => setTimeout(r, 400));
});
await p.waitForTimeout(800);
await p.screenshot({ path: `${outDir}/full-${theme}-${width}.png`, fullPage: true });

// The gallery on its own, since that is what changed most.
const gal = await p.$("#screens");
if (gal) await gal.screenshot({ path: `${outDir}/gallery-${theme}-${width}.png` });

console.log(`captured ${theme} @ ${width}`);
await b.close();
