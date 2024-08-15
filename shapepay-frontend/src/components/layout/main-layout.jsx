import React, { useState } from 'react';
import { Outlet } from 'react-router-dom';
import { useMediaQuery } from 'react-responsive';
import { cn } from "@/lib/utils";
import SideNav from '../nav/side-nav';
import TopBar from '../nav/top-bar';

const DRAWER_WIDTH = 250;

const MainLayout = () => {
  const isMobile = useMediaQuery({ maxWidth: 640 });
  const [isExpanded, setIsExpanded] = useState(false);

  const handleDrawerToggle = () => {
    setIsExpanded(!isExpanded);
  };

  return (
    <div className="flex flex-col min-h-screen">
      <TopBar onMenuClick={handleDrawerToggle} />
      
      <div className="flex flex-1">
        <SideNav
          isExpanded={isExpanded || !isMobile}
          setIsExpanded={setIsExpanded}
          isMobile={isMobile}
        />
        
        <main
          className={cn(
            "flex-grow transition-all duration-300 ease-in-out bg-gray-900 text-black",
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