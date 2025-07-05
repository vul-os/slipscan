import React from 'react';

const Logo = ({ className = "", variant = "default" }) => {
  if (variant === "minimal") {
    return (
      <div className={`flex items-center ${className}`}>
        <div className="relative">
          <div className="w-10 h-10 bg-white rounded-xl shadow-md flex items-center justify-center border border-gray-200">
            <img 
              src="/icon.svg" 
              alt="SlipScan" 
              className="w-6 h-6"
            />
          </div>
        </div>
        <span className="ml-3 text-2xl font-bold">
          <span className="text-gray-900">Slip</span>
          <span className="bg-gradient-to-r from-purple-600 to-blue-600 bg-clip-text text-transparent">Scan</span>
        </span>
      </div>
    );
  }

  return (
    <div className={`text-center ${className}`}>
      <div className="flex justify-center items-center mb-4">
        <div className="relative">
          {/* Main logo with icon.svg */}
          <div className="w-20 h-20 bg-gradient-to-r from-purple-500 to-blue-500 rounded-2xl flex items-center justify-center shadow-xl transform hover:scale-105 transition-transform duration-300 border-4 border-white">
            <img 
              src="/icon.svg" 
              alt="SlipScan AI Icon" 
              className="w-12 h-12 filter brightness-0 invert"
            />
            {/* Small AI indicator dot */}
            <div className="absolute -top-1 -right-1 w-4 h-4 bg-green-500 rounded-full animate-pulse shadow-lg"></div>
          </div>
        </div>
      </div>
      
      <div className="space-y-2">
        <h1 className="text-4xl sm:text-5xl font-bold tracking-tight">
          <span className="bg-gradient-to-r from-purple-600 to-blue-600 bg-clip-text text-transparent">Slip</span>
          <span className="text-gray-900">Scan</span>
        </h1>
        <p className="text-sm sm:text-base text-gray-600 font-semibold tracking-wide uppercase">
          AI Financial Document Processing
        </p>
      </div>
    </div>
  );
};

export default Logo; 