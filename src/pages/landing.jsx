import React, { useState, useEffect, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Camera, TrendingUp, PieChart, ShieldCheck, Zap, Store, Menu, X, Facebook, Receipt, ArrowRight } from 'lucide-react';

const LandingPage = () => {
  const navigate = useNavigate();
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const featuresRef = useRef(null);
  const faqRef = useRef(null);
  const retailersRef = useRef(null);

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
          <section ref={featuresRef} className="mb-16 sm:mb-24">
            <h2 className="text-3xl sm:text-4xl font-bold text-center mb-8 sm:mb-12 text-gray-800">How SlipSnap Works</h2>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-8 sm:gap-12">
              <Card className="bg-white shadow-lg hover:shadow-xl transition-shadow">
                <CardContent className="pt-8 flex flex-col items-center">
                  <Camera size={48} className="text-blue-600 mb-6" />
                  <h3 className="text-xl sm:text-2xl font-semibold mb-4 text-gray-800">Snap Your Receipts</h3>
                  <p className="text-gray-600 text-center">Simply take a photo of your receipt or slip, and our AI will do the rest.</p>
                </CardContent>
              </Card>
              <Card className="bg-white shadow-lg hover:shadow-xl transition-shadow">
                <CardContent className="pt-8 flex flex-col items-center">
                  <Zap size={48} className="text-blue-600 mb-6" />
                  <h3 className="text-xl sm:text-2xl font-semibold mb-4 text-gray-800">Instant Analysis</h3>
                  <p className="text-gray-600 text-center">Our AI quickly extracts and categorizes your spending data.</p>
                </CardContent>
              </Card>
              <Card className="bg-white shadow-lg hover:shadow-xl transition-shadow">
                <CardContent className="pt-8 flex flex-col items-center">
                  <PieChart size={48} className="text-blue-600 mb-6" />
                  <h3 className="text-xl sm:text-2xl font-semibold mb-4 text-gray-800">Smart Insights</h3>
                  <p className="text-gray-600 text-center">Get personalized spending breakdowns and money-saving tips.</p>
                </CardContent>
              </Card>
            </div>
          </section>

          {/* Supported Retailers Section */}
          <section ref={retailersRef} className="py-16 sm:py-24 bg-white rounded-3xl shadow-lg mb-16 sm:mb-24">
            <div className="container mx-auto px-4 sm:px-8">
              <h2 className="text-3xl sm:text-4xl font-bold text-center mb-8 sm:mb-12 text-gray-800">Supported Retailers</h2>
              <p className="text-lg sm:text-xl text-center text-gray-600 mb-8 sm:mb-12">
                SlipSnap works with receipts from all major retailers. Here are just a few we support:
              </p>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 sm:gap-8">
                {['Pick n Pay', 'Spar', 'Makro', 'Woolworths', 'Checkers', 'Shoprite', 'Game', 'Dis-Chem'].map((retailer, index) => (
                  <div key={index} className="flex items-center justify-center bg-gray-100 rounded-lg p-4">
                    <Store className="text-blue-600 mr-2" size={20} />
                    <span className="font-semibold text-gray-800 text-sm sm:text-base">{retailer}</span>
                  </div>
                ))}
              </div>
              <p className="text-center mt-8 sm:mt-12 text-gray-600">
                Don't see your favorite store? Don't worry! SlipSnap works with virtually any receipt.
              </p>
            </div>
          </section>

          {/* New Dashboard Preview Section */}
          <section className="mb-16 sm:mb-24">
            <div className="container mx-auto px-4">
              <h2 className="text-3xl sm:text-4xl font-bold text-center mb-8 sm:mb-12 text-gray-800">Powerful Analytics at Your Fingertips</h2>
              <div className="flex flex-col md:flex-row items-center justify-between">
                <div className="md:w-1/2 mb-8 md:mb-0 md:pr-8">
                  <h3 className="text-2xl sm:text-3xl font-semibold mb-4 text-gray-800">Gain Insights from Your Spending</h3>
                  <p className="text-lg text-gray-600 mb-6 leading-relaxed">
                    Our intuitive dashboard provides a comprehensive overview of your financial habits. With SlipSnap, you can:
                  </p>
                  <ul className="space-y-4">
                    <li className="flex items-start">
                      <TrendingUp className="text-blue-500 mr-2 mt-1 flex-shrink-0" size={24} />
                      <span className="text-gray-700">Track spending trends over time</span>
                    </li>
                    <li className="flex items-start">
                      <PieChart className="text-blue-500 mr-2 mt-1 flex-shrink-0" size={24} />
                      <span className="text-gray-700">Visualize expense categories with interactive charts</span>
                    </li>
                    <li className="flex items-start">
                      <Zap className="text-blue-500 mr-2 mt-1 flex-shrink-0" size={24} />
                      <span className="text-gray-700">Receive personalized savings recommendations</span>
                    </li>
                  </ul>
                </div>
                <div className="md:w-1/2">
                  <div className="bg-white p-4 rounded-xl shadow-2xl">
                    <img 
                      src="/dashboard.png" 
                      alt="SlipSnap Dashboard Preview" 
                      className="rounded-lg w-full"
                    />
                  </div>
                </div>
              </div>
            </div>
          </section>


        {/* New Slip Details Section */}
        <section className="mb-16 sm:mb-24">
          <div className="container mx-auto px-4">
            <h2 className="text-3xl sm:text-4xl font-bold text-center mb-8 sm:mb-12 text-gray-800">Detailed Insights at Your Fingertips</h2>
            <div className="flex flex-col md:flex-row items-center justify-between">
              <div className="md:w-1/2 mb-8 md:mb-0 md:pr-8">
                <h3 className="text-2xl sm:text-3xl font-semibold mb-4 text-gray-800">Every Purchase, Crystal Clear</h3>
                <p className="text-lg text-gray-600 mb-6 leading-relaxed">
                  SlipScan doesn't just capture totals. We break down each receipt into individual line items, giving you unprecedented visibility into your spending habits.
                </p>
                <ul className="space-y-4">
                  <li className="flex items-start">
                    <Receipt className="text-blue-500 mr-2 mt-1 flex-shrink-0" size={24} />
                    <span className="text-gray-700">View detailed breakdowns of each receipt</span>
                  </li>
                  <li className="flex items-start">
                    <PieChart className="text-blue-500 mr-2 mt-1 flex-shrink-0" size={24} />
                    <span className="text-gray-700">Categorize items automatically for better insights</span>
                  </li>
                  <li className="flex items-start">
                    <TrendingUp className="text-blue-500 mr-2 mt-1 flex-shrink-0" size={24} />
                    <span className="text-gray-700">Track price changes for individual products over time</span>
                  </li>
                </ul>
                <Button 
                  onClick={() => navigate('/signup')} 
                  className="mt-8 bg-blue-600 text-white text-lg py-3 px-6 rounded-full hover:bg-blue-700 transition-colors flex items-center"
                >
                  Start Scanning Now
                  <ArrowRight className="ml-2" size={20} />
                </Button>
              </div>
              <div className="md:w-1/2">
                <div className="bg-white p-4 rounded-xl shadow-2xl">
                  <img 
                    src="/slip-details.png" 
                    alt="SlipScan Detailed Receipt View" 
                    className="rounded-lg w-full"
                  />
                </div>
              </div>
            </div>
          </div>
        </section>

          {/* Security Section - Updated without image */}
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
          <section ref={faqRef} className="mb-16 sm:mb-24">
            <h2 className="text-3xl sm:text-4xl font-bold text-center mb-8 sm:mb-12 text-gray-800">Frequently Asked Questions</h2>
            <div className="space-y-6 sm:space-y-8">
              {[
                { q: "Is SlipSnap really free?", a: "Yes, SlipSnap is 100% free to use. We believe in making financial management accessible to everyone." },
                { q: "How accurate is the receipt scanning?", a: "Our AI-powered scanning is highly accurate. However, we always recommend reviewing the results for any discrepancies." },
                { q: "Can I export my data?", a: "Absolutely! You can export your data in various formats for use in other financial tools or for your records." },
                { q: "Is my data safe?", a: "We take data security very seriously. Your information is encrypted, and we never store original receipt images. Read more in our security section." }
              ].map((item, index) => (
                <div key={index} className="bg-white rounded-lg shadow-md p-6">
                  <h3 className="text-lg sm:text-xl font-semibold mb-2 text-gray-800">{item.q}</h3>
                  <p className="text-gray-600">{item.a}</p>
                </div>
              ))}
            </div>
          </section>
        </main>
      </div>

      {/* Footer */}
      <footer className="bg-gray-800 text-white py-12 sm:py-16 mt-auto">
        <div className="container mx-auto px-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-8 sm:gap-12">
            <div>
              <div className="flex items-center mb-6">
                <Camera size={32} className="text-blue-400 mr-3" />
                <span className="text-2xl font-semibold">SlipSnap</span>
              </div>
              <p className="text-gray-400">A free product by Exolution Technologies</p>
            </div>
            <div>
              <h3 className="font-semibold text-xl mb-4 sm:mb-6">Quick Links</h3>
              <ul className="space-y-2 sm:space-y-3">
                <li><Link to="/" className="text-gray-400 hover:text-blue-400 transition-colors">Home</Link></li>
                <li><button onClick={() => scrollToSection(featuresRef)} className="text-gray-400 hover:text-blue-400 transition-colors">Features</button></li>
                <li><button onClick={() => scrollToSection(retailersRef)} className="text-gray-400 hover:text-blue-400 transition-colors">Supported Retailers</button></li>
                <li><button onClick={() => scrollToSection(faqRef)} className="text-gray-400 hover:text-blue-400 transition-colors">FAQ</button></li>
                <li><Link to="/signup" className="text-gray-400 hover:text-blue-400 transition-colors">Sign up</Link></li>
                <li><Link to="/login" className="text-gray-400 hover:text-blue-400 transition-colors">Log in</Link></li>
              </ul>
            </div>
            <div>
              <h3 className="font-semibold text-xl mb-4 sm:mb-6">Connect With Us</h3>
              <ul className="space-y-2 sm:space-y-3">
                <li>
                  <a href="https://twitter.com/slipsnapapp" target="_blank" rel="noopener noreferrer" className="flex items-center text-gray-400 hover:text-blue-400 transition-colors">
                    <X size={20} className="mr-2" />
                    <span>X (Twitter): @slipsnapapp</span>
                  </a>
                </li>
                <li>
                  <a href="https://facebook.com/slipsnapapp" target="_blank" rel="noopener noreferrer" className="flex items-center text-gray-400 hover:text-blue-400 transition-colors">
                    <Facebook size={20} className="mr-2" />
                    <span>Facebook: @slipsnapapp</span>
                  </a>
                </li>
              </ul>
            </div>
          </div>
          <div className="mt-12 sm:mt-16 pt-8 border-t border-gray-700 text-sm text-gray-400">
            © 2024 Exolution Technologies Pty Ltd. All rights reserved. SlipSnap is a free product of Exolution Technologies Pty Ltd. SlipSnap is not affiliated with or endorsed by any other receipt scanning or financial management system.
          </div>
        </div>
      </footer>
    </div>
  );
};

export default LandingPage;