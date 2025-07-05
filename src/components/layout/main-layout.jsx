import React, { useState, useEffect } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { useMediaQuery } from 'react-responsive';
import TopBar from '../nav/top-bar';
import Sidebar from '../nav/side-bar';
import BistroSetupPopup from '../setup/bistro-setup-popup';
import { useAuth } from '@/context/auth-context';

const TOP_BAR_HEIGHT = '4rem';

const MainLayout = () => {
  const isMobile = useMediaQuery({ maxWidth: 768 });
  const location = useLocation();
  const isLandingPage = location.pathname === '/';
  const isProtectedRoute = !isLandingPage && (
    location.pathname.startsWith('/dashboard') ||
    location.pathname.startsWith('/documents') ||
    location.pathname.startsWith('/reports') ||
    location.pathname.startsWith('/settings')
  );
  
  const { user, activeBistro, bistroSetupCompleted, loading } = useAuth();
  const [isSetupPopupOpen, setIsSetupPopupOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(isMobile);

  // Collapse sidebar on mobile by default
  useEffect(() => {
    if (isMobile) {
      setSidebarCollapsed(true);
    }
  }, [isMobile]);

  // Show setup popup when:
  // - User is logged in
  // - Has an active bistro
  // - Setup is not completed
  // - Not on landing page
  // - Auth is not loading
  const shouldShowSetupPopup = user && 
                                activeBistro && 
                                !bistroSetupCompleted && 
                                !isLandingPage && 
                                !loading;

  // Auto-open setup popup when conditions are met
  useEffect(() => {
    if (shouldShowSetupPopup) {
      setIsSetupPopupOpen(true);
    }
  }, [shouldShowSetupPopup]);

  const handleCloseSetupPopup = () => {
    setIsSetupPopupOpen(false);
    // Note: Users can close the popup, but it will reopen on page refresh
    // until setup is actually completed
  };

  const handleToggleSidebar = () => {
    setSidebarCollapsed(!sidebarCollapsed);
  };

  return (
    <div className="flex flex-col min-h-screen">
      <TopBar 
        onToggleSidebar={handleToggleSidebar}
        showSidebarToggle={isProtectedRoute}
      />
      
      <div className="flex flex-1 relative" style={{ marginTop: TOP_BAR_HEIGHT, height: 'calc(100vh - 4rem)' }}>
        {/* Sidebar for protected routes */}
        {isProtectedRoute && (
          <Sidebar 
            isCollapsed={sidebarCollapsed}
            onToggleCollapse={handleToggleSidebar}
          />
        )}

        {/* Main content */}
        {isLandingPage ? (
          <main className="flex-1 min-w-0">
            <Outlet />
          </main>
        ) : (
          <main 
            className={`flex-1 min-w-0 transition-all duration-300 ${
              isProtectedRoute 
                ? 'bg-gradient-to-br from-gray-50/30 via-white to-purple-50/10' 
                : 'bg-gray-50'
            } ${
              isProtectedRoute && !sidebarCollapsed && !isMobile ? 'ml-72' : ''
            } ${
              isProtectedRoute && sidebarCollapsed && !isMobile ? 'ml-16' : ''
            }`}
          >
            {isProtectedRoute ? (
              <div className="h-full overflow-auto">
                <div className="max-w-7xl mx-auto py-4 sm:py-6 px-2 sm:px-4 md:px-6 lg:px-8">
                  <Outlet />
                </div>
              </div>
            ) : (
              <div className="max-w-7xl mx-auto py-4 sm:py-6 px-2 sm:px-4 md:px-6 lg:px-8">
                <Outlet />
              </div>
            )}
          </main>
        )}
      </div>

      {/* Bistro Setup Popup */}
      <BistroSetupPopup 
        isOpen={isSetupPopupOpen}
        onClose={handleCloseSetupPopup}
      />
    </div>
  );
};

export default MainLayout;