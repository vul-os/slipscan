import React, { useState } from 'react';
import { Outlet } from 'react-router-dom';
import { useMediaQuery } from 'react-responsive';
import { cn } from "@/lib/utils"
import SideNav from '../nav/side-nav';
import TopBar from '../nav/top-bar';

const DRAWER_WIDTH = 250; // Width in pixels

export const MainLayout = () => {
  const isMobile = useMediaQuery({ maxWidth: 640 });
  const [mobileOpen, setMobileOpen] = useState(false);
  
  const handleDrawerToggle = () => {
    setMobileOpen(!mobileOpen);
  };
  
  return (
    <div className="min-h-screen flex">
      <TopBar onMenuClick={handleDrawerToggle} />
      <SideNav
        isMobile={isMobile}
        mobileOpen={mobileOpen}
        onClose={handleDrawerToggle}
      />
      <main 
        className={cn(
          "flex-grow p-6 transition-all duration-300 ease-in-out",
          isMobile ? "mt-14" : "mt-16",
          !isMobile && `ml-[${DRAWER_WIDTH}px]`
        )}
      >
        <Outlet />
      </main>
    </div>
  );
};

export default MainLayout;