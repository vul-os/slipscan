import React from 'react';
import { Link } from 'react-router-dom';
import { Camera, X, Facebook } from 'lucide-react';

const Footer = () => {
  return (
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
              <li><Link to="/#features" className="text-gray-400 hover:text-blue-400 transition-colors">Features</Link></li>
              <li><Link to="/#retailers" className="text-gray-400 hover:text-blue-400 transition-colors">Supported Retailers</Link></li>
              <li><Link to="/#faq" className="text-gray-400 hover:text-blue-400 transition-colors">FAQ</Link></li>
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
                  <span>X (Twitter): @exolutionza</span>
                </a>
              </li>
            </ul>
          </div>
        </div>
        <div className="mt-12 sm:mt-16 pt-8 border-t border-gray-700 text-sm text-gray-400">
          © {new Date().getFullYear()} Exolution Technologies Pty Ltd. All rights reserved. SlipSnap is a free product of Exolution Technologies Pty Ltd. SlipSnap is not affiliated with or endorsed by any other receipt scanning or financial management system.
        </div>
      </div>
    </footer>
  );
};

export default Footer;