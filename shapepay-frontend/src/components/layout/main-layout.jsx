// MainLayout.js
import React, { useState } from 'react';
import { Outlet } from 'react-router-dom';
import { useMediaQuery } from 'react-responsive';
import { cn } from "@/lib/utils"; // Ensure this utility function is correctly defined
import SideNav from '../nav/side-nav';
import TopBar from '../nav/top-bar';

const DRAWER_WIDTH = 250; // Width in pixels

const MainLayout = () => {
  const isMobile = useMediaQuery({ maxWidth: 640 });
  const [isExpanded, setIsExpanded] = useState(false);

  const handleDrawerToggle = () => {
    setIsExpanded(!isExpanded); // Toggle sidebar for mobile
  };

  return (
    <div className="flex flex-col min-h-screen">
      {/* TopBar */}
      <TopBar onMenuClick={handleDrawerToggle} />

      {/* Layout Wrapper */}
      <div className="flex flex-1">
        {/* SideNav */}
        <SideNav
          isExpanded={isExpanded || !isMobile} // Keep sidebar expanded on desktop
          setIsExpanded={setIsExpanded} // Allow SideNav to manage expanded state
          isMobile={isMobile} // Pass down isMobile state for conditionals
        />

        {/* Main Content */}
        <main
          className={cn(
            "flex-grow p-6 transition-all duration-300 ease-in-out bg-gray-100 text-black",
            isMobile ? "mt-14" : "mt-16",
            isExpanded || !isMobile ? `ml-[${DRAWER_WIDTH}px]` : 'ml-16'
          )}
        >
          <Outlet />
        </main>
      </div>
    </div>
  );
};

export default MainLayout;
