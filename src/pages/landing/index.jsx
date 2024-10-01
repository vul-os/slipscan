import React, { useState, useEffect, useRef, lazy, Suspense } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Camera, TrendingUp, PieChart, ShieldCheck, Zap, Store, Menu, X, Facebook } from 'lucide-react';

// Lazy loaded components
const Features = lazy(() => import('./features'));
const Retailers = lazy(() => import('./retailers'));
const FAQ = lazy(() => import('./faq'));
const Footer = lazy(() => import('./footer'));

const LandingPage = () => {
  const navigate = useNavigate();
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const featuresRef = useRef(null);
  const retailersRef = useRef(null);
  const faqRef = useRef(null);

  useEffect(() => {
    if (window.location.href.startsWith(`${window.location.origin}/#`)) {
      navigate('/dashboard', { replace: true });
    }
  }, [navigate]);

  const scrollToSection = (elementRef) => {
    window.scrollTo({
      top: elementRef.current.offsetTop - 80,
      behavior: 'smooth'
    });
    setIsMenuOpen(false);
  };

  return (
    <div className="flex flex-col min-h-screen font-sans bg-gradient-to-b from-blue-50 to-white">
      <div className="container mx-auto px-4 py-4 sm:py-8">
        {/* Header */}
        <header className="flex justify-between items-center mb-8 sm:mb-16">
          <div className="flex items-center">
            <Camera size={32} className="text-blue-600 mr-2" />
            <span className="text-2xl font-bold text-gray-800">SlipSnap</span>
          </div>
          <nav className="hidden sm:block">
            <ul className="flex space-x-8 items-center">
              <li><button onClick={() => scrollToSection(featuresRef)} className="text-gray-600 hover:text-blue-600 transition-colors">Features</button></li>
              <li><button onClick={() => scrollToSection(retailersRef)} className="text-gray-600 hover:text-blue-600 transition-colors">Retailers</button></li>
              <li><button onClick={() => scrollToSection(faqRef)} className="text-gray-600 hover:text-blue-600 transition-colors">FAQ</button></li>
              <li>
                <Button 
                  variant="outline" 
                  onClick={() => navigate('/login')} 
                  className="bg-blue-600 text-white border-blue-600 hover:bg-blue-700 hover:border-blue-700 transition-colors"
                >
                  Log in
                </Button>
              </li>
            </ul>
          </nav>
          <button onClick={() => setIsMenuOpen(!isMenuOpen)} className="sm:hidden">
            {isMenuOpen ? <X size={24} /> : <Menu size={24} />}
          </button>
        </header>

        {/* Mobile Menu */}
        {isMenuOpen && (
          <div className="sm:hidden bg-white fixed inset-0 z-50 flex flex-col items-center justify-center">
            <button onClick={() => setIsMenuOpen(false)} className="absolute top-4 right-4">
              <X size={24} />
            </button>
            <ul className="space-y-6 text-center">
              <li><button onClick={() => scrollToSection(featuresRef)} className="text-xl text-gray-800 hover:text-blue-600 transition-colors">Features</button></li>
              <li><button onClick={() => scrollToSection(retailersRef)} className="text-xl text-gray-800 hover:text-blue-600 transition-colors">Supported Retailers</button></li>
              <li><button onClick={() => scrollToSection(faqRef)} className="text-xl text-gray-800 hover:text-blue-600 transition-colors">FAQ</button></li>
              <li>
                <Button 
                  variant="outline" 
                  onClick={() => navigate('/login')} 
                  className="bg-blue-600 text-white border-blue-600 hover:bg-blue-700 hover:border-blue-700 transition-colors"
                >
                  Log in
                </Button>
              </li>
            </ul>
          </div>
        )}

        {/* Main Content */}
        <main>
          {/* Hero Section */}
          <section className="text-center mb-16 sm:mb-24">
            <h1 className="text-4xl sm:text-6xl font-bold mb-6 text-gray-800 leading-tight">Transform Your <span className="text-blue-600">Receipts</span> into Financial Insights</h1>
            <p className="text-lg sm:text-xl text-gray-600 mb-8 max-w-3xl mx-auto leading-relaxed">
              SlipSnap uses advanced AI to analyze your receipt photos, providing instant insights 
              into your spending habits and empowering you to make smarter financial decisions.
            </p>
            <p className="text-2xl sm:text-3xl font-bold text-blue-600 mb-10">Completely Free, Forever!</p>
            <Button 
              onClick={() => navigate('/signup')} 
              className="bg-blue-600 text-white text-lg py-4 px-8 sm:py-6 sm:px-10 rounded-full hover:bg-blue-700 transition-colors"
            >
              Start Scanning for Free
            </Button>
          </section>

          {/* Features Section */}
          <Suspense fallback={<div>Loading...</div>}>
            <Features ref={featuresRef} />
          </Suspense>

          {/* Supported Retailers Section */}
          <Suspense fallback={<div>Loading...</div>}>
            <Retailers ref={retailersRef} />
          </Suspense>

          {/* Security Section */}
          <section className="mb-16 sm:mb-24">
            <div className="bg-blue-50 rounded-3xl p-8 sm:p-12">
              <h2 className="text-3xl sm:text-4xl font-bold text-center mb-8 text-gray-800">Your Security is Our Priority</h2>
              <div className="max-w-3xl mx-auto">
                <p className="text-lg sm:text-xl text-gray-600 mb-6 leading-relaxed text-center">
                  At SlipSnap, we take your privacy and data security seriously. Our multi-layered security approach ensures that your financial information remains safe and confidential.
                </p>
                <ul className="space-y-4">
                  <li className="flex items-start justify-center">
                    <ShieldCheck className="text-green-500 mr-2 mt-1 flex-shrink-0" size={24} />
                    <span className="text-gray-700">Advanced encryption for all data transmissions</span>
                  </li>
                  <li className="flex items-start justify-center">
                    <ShieldCheck className="text-green-500 mr-2 mt-1 flex-shrink-0" size={24} />
                    <span className="text-gray-700">No storage of original receipt images</span>
                  </li>
                  <li className="flex items-start justify-center">
                    <ShieldCheck className="text-green-500 mr-2 mt-1 flex-shrink-0" size={24} />
                    <span className="text-gray-700">Regular security audits and updates</span>
                  </li>
                </ul>
              </div>
            </div>
          </section>

          {/* FAQ Section */}
          <Suspense fallback={<div>Loading...</div>}>
            <FAQ ref={faqRef} />
          </Suspense>
        </main>
      </div>

      {/* Footer */}
      <Suspense fallback={<div>Loading...</div>}>
        <Footer />
      </Suspense>
    </div>
  );
};

export default LandingPage;