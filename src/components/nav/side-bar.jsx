import React from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useMediaQuery } from 'react-responsive';
import { useAuth } from '@/context/auth-context';
import { Button } from "@/components/ui/button";
import { 
  LayoutDashboard, 
  FileText, 
  Settings, 
  Upload,
  ChevronLeft,
  ChevronRight,
  User,
  Building,
  LogOut,
  X
} from 'lucide-react';

const Sidebar = ({ isCollapsed, onToggleCollapse }) => {
  const navigate = useNavigate();
  const location = useLocation();
  const isMobile = useMediaQuery({ maxWidth: 768 });
  const { activeEntity, user, signOut } = useAuth();

  const navigationItems = [
    {
      label: 'Dashboard',
      icon: LayoutDashboard,
      path: '/dashboard',
      description: 'Overview & insights'
    },
    {
      label: 'Documents',
      icon: FileText,
      path: '/documents',
      description: 'AI-processed files'
    },
    {
      label: 'Settings',
      icon: Settings,
      path: '/settings',
      description: 'Account & preferences'
    }
  ];

  const quickActions = [
    {
      label: 'Upload Document',
      icon: Upload,
      action: () => navigate('/documents'),
      className: 'bg-gradient-to-r from-purple-500 to-blue-500 text-white hover:from-purple-600 hover:to-blue-600'
    }
  ];

  const isActivePath = (path) => {
    return location.pathname === path;
  };

  const handleSignOut = async () => {
    try {
      await signOut();
      navigate('/');
    } catch (error) {
      console.error('Sign out error:', error);
    }
  };

  const handleNavigation = (path) => {
    navigate(path);
    // Close sidebar on mobile after navigation
    if (isMobile && !isCollapsed) {
      onToggleCollapse();
    }
  };

  // Mobile overlay when sidebar is open
  const MobileOverlay = () => (
    <div 
      className="fixed inset-0 bg-black bg-opacity-50 z-20 md:hidden"
      onClick={onToggleCollapse}
    />
  );

  // On mobile, don't show sidebar at all when collapsed
  if (isMobile && isCollapsed) {
    return null;
  }

  if (isCollapsed) {
    return (
      <div className="w-16 bg-white border-r-2 border-gray-200 flex flex-col h-[calc(100vh-4rem)] fixed left-0 top-16 z-30">
        {/* Toggle Button */}
        <Button
          variant="ghost"
          size="sm"
          onClick={onToggleCollapse}
          className="absolute -right-3 top-6 z-10 w-6 h-6 rounded-full bg-white border-2 border-gray-200 hover:border-purple-300 p-0"
        >
          <ChevronRight className="w-3 h-3" />
        </Button>

        {/* Logo - Mobile Only */}
        <div className="p-4 border-b border-gray-200 md:hidden">
          <div className="flex items-center gap-2">
            <img src="/icon.svg" alt="SlipScan" className="w-8 h-8" />
            <div>
              <h2 className="font-bold text-sm text-gray-900">
                <span className="bg-gradient-to-r from-purple-600 to-blue-600 bg-clip-text text-transparent">Slip</span>
                <span className="text-gray-900">Scan</span>
              </h2>
              <p className="text-xs text-gray-500">AI Financial Tracking</p>
            </div>
          </div>
        </div>

        {/* Navigation */}
        <nav className="flex-1 p-2 space-y-1">
          {navigationItems.map((item) => {
            const Icon = item.icon;
            const isActive = isActivePath(item.path);
            
            return (
              <Button
                key={item.path}
                variant="ghost"
                size="sm"
                onClick={() => handleNavigation(item.path)}
                className={`w-full h-12 p-0 relative group ${
                  isActive 
                    ? 'bg-purple-100 text-purple-700 hover:bg-purple-100' 
                    : 'text-gray-600 hover:text-purple-700 hover:bg-purple-50'
                }`}
                title={item.label}
              >
                <Icon className="w-5 h-5" />
                
                {/* Tooltip */}
                <div className="absolute left-full ml-2 px-2 py-1 bg-gray-900 text-white text-xs rounded opacity-0 group-hover:opacity-100 transition-opacity z-50 whitespace-nowrap pointer-events-none">
                  {item.label}
                </div>
              </Button>
            );
          })}
        </nav>

        {/* User */}
        <div className="p-2 border-t border-gray-200">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleSignOut}
            className="w-full h-12 p-0 group relative text-gray-600 hover:text-red-600 hover:bg-red-50"
            title="Sign Out"
          >
            <LogOut className="w-5 h-5" />
            
            {/* Tooltip */}
            <div className="absolute left-full ml-2 px-2 py-1 bg-gray-900 text-white text-xs rounded opacity-0 group-hover:opacity-100 transition-opacity z-50 whitespace-nowrap pointer-events-none">
              Sign Out
            </div>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <>
      {/* Mobile overlay */}
      {isMobile && !isCollapsed && <MobileOverlay />}
      
      <div className="w-72 bg-white border-r-2 border-gray-200 flex flex-col h-[calc(100vh-4rem)] fixed left-0 top-16 z-30">
        {/* Toggle Button */}
        <Button
          variant="ghost"
          size="sm"
          onClick={onToggleCollapse}
          className="absolute -right-3 top-6 z-10 w-6 h-6 rounded-full bg-white border-2 border-gray-200 hover:border-purple-300 p-0"
        >
          <ChevronLeft className="w-3 h-3" />
        </Button>

        {/* Mobile Close Button */}
        {isMobile && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onToggleCollapse}
            className="absolute right-4 top-4 z-10 w-6 h-6 rounded-full bg-gray-100 hover:bg-gray-200 p-0 md:hidden"
          >
            <X className="w-3 h-3" />
          </Button>
        )}

        {/* Header - Mobile Only */}
        <div className="p-6 border-b border-gray-200 md:hidden">
          <div className="flex items-center gap-3 mb-4">
            <img src="/icon.svg" alt="SlipScan" className="w-10 h-10" />
            <div>
              <h2 className="font-bold text-xl text-gray-900">
                <span className="bg-gradient-to-r from-purple-600 to-blue-600 bg-clip-text text-transparent">Slip</span>
                <span className="text-gray-900">Scan</span>
              </h2>
              <p className="text-xs text-gray-500">AI Financial Tracking</p>
            </div>
          </div>

          {/* Entity Selector - Mobile Only */}
          {activeEntity && (
            <div className="bg-purple-50 rounded-lg p-3 border border-purple-200">
              <div className="flex items-center gap-2 mb-1">
                <Building className="w-4 h-4 text-purple-600" />
                <span className="font-medium text-purple-900 text-sm">{activeEntity.name}</span>
              </div>
              <div className="text-xs text-purple-700 font-mono">
                {activeEntity.id}@docs.slipscan.com
              </div>
            </div>
          )}
        </div>

        {/* Quick Actions */}
        <div className="p-4 border-b border-gray-200">
          {quickActions.map((action, index) => {
            const Icon = action.icon;
            return (
              <Button
                key={index}
                onClick={action.action}
                className={`w-full justify-start gap-3 h-11 ${action.className}`}
              >
                <Icon className="w-4 h-4" />
                {action.label}
              </Button>
            );
          })}
        </div>

        {/* Navigation */}
        <nav className="flex-1 p-4 space-y-1">
          <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">
            Navigation
          </h3>
          {navigationItems.map((item) => {
            const Icon = item.icon;
            const isActive = isActivePath(item.path);
            
            return (
              <Button
                key={item.path}
                variant="ghost"
                onClick={() => handleNavigation(item.path)}
                className={`w-full justify-start gap-3 h-11 ${
                  isActive 
                    ? 'bg-purple-100 text-purple-700 hover:bg-purple-100' 
                    : 'text-gray-600 hover:text-purple-700 hover:bg-purple-50'
                }`}
              >
                <Icon className="w-5 h-5" />
                <div className="flex-1 text-left">
                  <div className="font-medium">{item.label}</div>
                  <div className="text-xs text-gray-500">{item.description}</div>
                </div>
              </Button>
            );
          })}
        </nav>

        {/* User Account */}
        <div className="p-4 border-t border-gray-200">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-8 h-8 bg-gradient-to-r from-purple-500 to-blue-500 rounded-full flex items-center justify-center">
              <User className="w-4 h-4 text-white" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="font-medium text-gray-900 text-sm truncate">
                {user?.user_metadata?.full_name || user?.email?.split('@')[0] || 'User'}
              </div>
              <div className="text-xs text-gray-500 truncate">{user?.email}</div>
            </div>
          </div>
          
          <Button
            variant="ghost"
            size="sm"
            onClick={handleSignOut}
            className="w-full justify-start gap-2 h-8 text-gray-600 hover:text-red-600 hover:bg-red-50"
          >
            <LogOut className="w-4 h-4" />
            Sign Out
          </Button>
        </div>
      </div>
    </>
  );
};

export default Sidebar;

