import { LandingHeader } from "@/components/landing/LandingHeader";
import { ScrollProgress } from "@/components/landing/motion";
import Hero from "@/components/landing/sections/Hero";
import HowItWorks from "@/components/landing/sections/HowItWorks";
import Features from "@/components/landing/sections/Features";
import LiveDemo from "@/components/landing/sections/LiveDemo";
import Integrations from "@/components/landing/sections/Integrations";
import Pricing from "@/components/landing/sections/Pricing";
import Faq from "@/components/landing/sections/Faq";
import FinalCta from "@/components/landing/sections/FinalCta";
import Footer from "@/components/landing/Footer";

export default function LandingPage() {
  return (
    <>
      <ScrollProgress />
      <LandingHeader />
      <main className="bg-ink-0 text-ink-900 overflow-x-hidden">
        <Hero />
        <HowItWorks />
        <Features />
        <LiveDemo />
        <Integrations />
        <Pricing />
        <Faq />
        <FinalCta />
      </main>
      <Footer />
    </>
  );
}
