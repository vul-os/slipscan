import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from "@/components/ui/button";

const HeroContent = () => {
  const navigate = useNavigate();

  return (
    <>
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
    </>
  );
};

export default HeroContent;