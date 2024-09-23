import React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Camera, Shield, Lock, EyeOff, TrendingUp, PieChart } from 'lucide-react';

const LandingPage = () => {
  const navigate = useNavigate();

  return (
    <div className="flex flex-col min-h-screen font-sans bg-gray-50">
      <div className="container mx-auto px-4 py-8">
        {/* Header */}
        <header className="flex justify-between items-center mb-16">
          <div className="flex items-center">
            <Camera size={32} className="text-blue-600 mr-2" />
            <span className="text-2xl font-bold text-gray-800">SlipScan</span>
          </div>
          <nav>
            <ul className="flex space-x-8 items-center">
              <li><Link to="#" className="text-gray-600 hover:text-blue-600 transition-colors">Features</Link></li>
              <li><Link to="#" className="text-gray-600 hover:text-blue-600 transition-colors">FAQ</Link></li>
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
        </header>

        {/* Main Content */}
        <main>
          {/* Hero Section */}
          <section className="text-center mb-24">
            <h1 className="text-6xl font-bold mb-6 text-gray-800">Snap Your Way to Smart Spending</h1>
            <p className="text-xl text-gray-600 mb-4 max-w-3xl mx-auto">
              SlipSnap uses AI to analyze your receipt photos, giving you instant insights 
              into your spending habits and helping you make smarter financial decisions.
            </p>
            <p className="text-3xl font-bold text-blue-600 mb-10">100% Free to Use!</p>
          </section>

          {/* Features Section */}
          <section className="grid grid-cols-1 md:grid-cols-3 gap-12 mb-24">
            <Card className="bg-white shadow-lg hover:shadow-xl transition-shadow">
              <CardContent className="pt-8 flex flex-col items-center">
                <Camera size={64} className="text-blue-600 mb-6" />
                <h3 className="text-2xl font-semibold mb-4 text-gray-800">Easy Receipt Capture</h3>
                <p className="text-gray-600 text-center">Simply snap a photo of your receipt and let our AI do the rest.</p>
              </CardContent>
            </Card>
            <Card className="bg-white shadow-lg hover:shadow-xl transition-shadow">
              <CardContent className="pt-8 flex flex-col items-center">
                <TrendingUp size={64} className="text-blue-600 mb-6" />
                <h3 className="text-2xl font-semibold mb-4 text-gray-800">Spending Analysis</h3>
                <p className="text-gray-600 text-center">Get detailed breakdowns of your spending habits across categories.</p>
              </CardContent>
            </Card>
            <Card className="bg-white shadow-lg hover:shadow-xl transition-shadow">
              <CardContent className="pt-8 flex flex-col items-center">
                <PieChart size={64} className="text-blue-600 mb-6" />
                <h3 className="text-2xl font-semibold mb-4 text-gray-800">Smart Insights</h3>
                <p className="text-gray-600 text-center">Receive personalized tips to optimize your budget and save money.</p>
              </CardContent>
            </Card>
          </section>

          {/* Security Section */}
          <section className="py-24 bg-white rounded-3xl shadow-lg">
            <div className="container mx-auto px-8">
              <div className="flex flex-col md:flex-row items-center justify-between">
                <div className="md:w-1/2 mb-12 md:mb-0">
                  <h2 className="text-5xl font-bold mb-6 text-gray-800">Multilayered Privacy</h2>
                  <p className="text-xl text-gray-600 mb-8 leading-relaxed">
                    Our receipt analysis system prioritizes your privacy with state-of-the-art 
                    image processing and data handling techniques. By not storing original receipt 
                    images, we significantly reduce the risk of sensitive data exposure, setting 
                    a new standard in personal finance management security.
                  </p>
                </div>
                <div className="md:w-5/12">
                  <img src="/api/placeholder/500/300" alt="SlipSnap Dashboard" className="rounded-2xl shadow-2xl" />
                </div>
              </div>

              <div className="grid md:grid-cols-3 gap-12 mt-24">
                {[
                  { icon: Shield, title: "Advanced Analysis", description: "We employ cutting-edge techniques to ensure your financial data remains secure and private, giving you peace of mind with every scan." },
                  { icon: Lock, title: "Secure Data Handling", description: "Your data is protected with industry-standard encryption and secure storage practices, keeping your financial information safe at all times." },
                  { icon: EyeOff, title: "Privacy-First Approach", description: "We prioritize your privacy by minimizing data retention and implementing strict access controls, ensuring your information stays confidential." }
                ].map((feature, index) => (
                  <div key={index} className="flex flex-col items-center text-center">
                    <div className={`p-4 bg-${feature.title === "Advanced Analysis" ? "blue" : feature.title === "Secure Data Handling" ? "green" : "purple"}-100 rounded-full mb-6`}>
                      <feature.icon className={`text-${feature.title === "Advanced Analysis" ? "blue" : feature.title === "Secure Data Handling" ? "green" : "purple"}-600`} size={32} />
                    </div>
                    <h3 className="text-2xl font-semibold mb-4 text-gray-800">{feature.title}</h3>
                    <p className="text-gray-600 leading-relaxed">{feature.description}</p>
                  </div>
                ))}
              </div>
            </div>
          </section>
        </main>
      </div>

      {/* Footer */}
      <footer className="bg-gray-800 text-white py-16 mt-24">
        <div className="container mx-auto px-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-12">
            <div>
              <div className="flex items-center mb-6">
                <Camera size={32} className="text-blue-400 mr-3" />
                <span className="text-2xl font-semibold">SlipSnap</span>
              </div>
              <p className="text-gray-400">A free product by Exolution Technologies</p>
            </div>
            <div>
              <h3 className="font-semibold text-xl mb-6">All pages</h3>
              <ul className="space-y-3">
                {["Home", "FAQ", "Terms", "Privacy", "Sign up", "Sign In"].map((item, index) => (
                  <li key={index}><Link to="#" className="text-gray-400 hover:text-blue-400 transition-colors">{item}</Link></li>
                ))}
              </ul>
            </div>
            <div>
              <h3 className="font-semibold text-xl mb-6">Socials</h3>
              <ul className="space-y-3">
                {["@slipsnapapp", "@slipsnapapp"].map((item, index) => (
                  <li key={index}><a href="#" className="text-gray-400 hover:text-blue-400 transition-colors">{item}</a></li>
                ))}
              </ul>
            </div>
          </div>
          <div className="mt-16 pt-8 border-t border-gray-700 text-sm text-gray-400">
            © 2024 Exolution Technologies Pty Ltd. All rights reserved. SlipSnap is a free product of Exolution Technologies Pty Ltd. SlipSnap is not affiliated with or endorsed by any other receipt scanning or financial management system. Our free service uses AI to analyze receipt images and provide spending insights to help users make informed financial decisions.
          </div>
        </div>
      </footer>
    </div>
  );
};

export default LandingPage;