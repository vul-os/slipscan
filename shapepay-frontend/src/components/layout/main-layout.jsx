import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Outlet } from 'react-router-dom';
import { useMediaQuery } from 'react-responsive';
import { cn } from "@/lib/utils";
import SideNav from '../nav/side-nav';
import TopBar from '../nav/top-bar';

const DRAWER_WIDTH = 250;

const MainLayout = () => {
  const isMobile = useMediaQuery({ maxWidth: 640 });
  const [isExpanded, setIsExpanded] = useState(false);
  const sidenavRef = useRef(null);
  const toggleButtonRef = useRef(null);

  const handleDrawerToggle = useCallback((event) => {
    if (isMobile) {
      event.stopPropagation();
      setIsExpanded((prev) => !prev);
    }
  }, [isMobile]);

  useEffect(() => {
    const handleClick = (event) => {
      if (isMobile) {
        const clickedSidenav = sidenavRef.current && sidenavRef.current.contains(event.target);
        const clickedToggle = toggleButtonRef.current && toggleButtonRef.current.contains(event.target);

        if (!clickedSidenav && !clickedToggle) {
          setIsExpanded(false);
        }
      }
    };

    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, [isMobile]);

  useEffect(() => {
    setIsExpanded(false);
  }, [isMobile]);

  return (
    <div className="flex flex-col h-screen">
      <TopBar onMenuClick={handleDrawerToggle} toggleButtonRef={toggleButtonRef} />
      
      <div className="flex flex-1 overflow-hidden">
        {!isMobile && (
          <aside 
            className="w-[250px] h-full overflow-y-auto bg-gray-800 shadow-lg"
            style={{ top: '4rem' }}
          >
            <SideNav isExpanded={true} isMobile={false} />
          </aside>
        )}

        <main 
          className="flex-grow overflow-y-auto transition-all duration-300 ease-in-out bg-gray-900 text-black"
        >
          <Outlet />
        </main>

        {isMobile && (
          <aside 
            ref={sidenavRef}
            className={cn(
              "fixed inset-y-0 left-0 z-20 h-full overflow-y-auto transition-all duration-300 ease-in-out bg-white shadow-lg",
              isExpanded ? "w-full" : "w-0"
            )}
            style={{ top: '3.5rem' }}
          >
            <SideNav isExpanded={isExpanded} isMobile={true} />
          </aside>
        )}
      </div>
    </div>
  );
};

export default MainLayout;