import React, { useState } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { 
  Settings, 
  LogOut, 
  ChevronDown, 
  Briefcase, 
  UserCircle,
  Plus,
  Menu,
  LayoutDashboard
} from 'lucide-react';
import { useAuth } from '@/context/auth-context';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuGroup,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import Logo from '@/components/ui/logo';

const TopBar = ({ onToggleSidebar, showSidebarToggle = false }) => {
  const { 
    user, 
    userProfile,
    signOut, 
    entities, 
    activeEntity,
    switchEntity
  } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const handleSignOut = async () => {
    try {
      await signOut();
      navigate('/signin');
    } catch (error) {
      console.error("Error signing out:", error);
    }
  };

  const handleSwitchEntity = (entityId) => {
    try {
      switchEntity(entityId);
    } catch (error) {
      console.error("Error switching entity:", error);
    }
  };

  const getUserInitials = () => {
    if (!user?.email) return 'U';
    return user.email
      .split('@')[0]
      .split('.')
      .map(part => part[0]?.toUpperCase())
      .join('')
      .slice(0, 2);
  };

  return (
    <header className="fixed top-0 left-0 right-0 z-50 bg-white/95 backdrop-blur-lg border-b border-gray-200/50 shadow-sm">
      <nav className="h-16 px-4 sm:px-6 lg:px-8">
        <div className="h-full flex items-center justify-between max-w-7xl mx-auto">
          {/* Left: Hamburger Menu + Logo */}
          <div className="flex items-center gap-3">
            {/* Hamburger Menu Button for Mobile */}
            {showSidebarToggle && (
              <Button
                variant="ghost"
                size="sm"
                onClick={onToggleSidebar}
                className="md:hidden p-2 h-10 w-10 hover:bg-gray-100 transition-colors"
              >
                <Menu className="h-5 w-5 text-gray-600" />
              </Button>
            )}
            
            <Link to="/" className="flex items-center">
              <div className="block sm:hidden">
                {/* Mobile logo - just icon */}
                <div className="w-10 h-10 bg-gradient-to-r from-purple-500 to-blue-500 rounded-xl flex items-center justify-center shadow-lg">
                  <div className="w-6 h-6 bg-white rounded-lg flex items-center justify-center">
                    <div className="w-4 h-4 bg-gradient-to-r from-purple-500 to-blue-500 rounded"></div>
                  </div>
                </div>
              </div>
              <div className="hidden sm:block">
                {/* Desktop logo */}
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 bg-gradient-to-r from-purple-500 to-blue-500 rounded-xl flex items-center justify-center shadow-lg">
                    <div className="w-6 h-6 bg-white rounded-lg flex items-center justify-center">
                      <div className="w-4 h-4 bg-gradient-to-r from-purple-500 to-blue-500 rounded"></div>
                    </div>
                  </div>
                  <div>
                    <h2 className="font-bold text-xl text-gray-900">
                      <span className="bg-gradient-to-r from-purple-600 to-blue-600 bg-clip-text text-transparent">Slip</span>
                      <span className="text-gray-900">Scan</span>
                    </h2>
                  </div>
                </div>
              </div>
            </Link>
          </div>

          {/* Right: Entity Selector and User Menu */}
          <div className="flex items-center gap-3">
            {user ? (
              <>
                {/* Entity Selector - Desktop */}
                <div className="hidden md:block">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button 
                        variant="ghost" 
                        className="h-10 px-3 text-sm font-medium flex items-center gap-2 border border-gray-200 text-gray-700 bg-white hover:bg-gray-50 hover:border-purple-300 transition-all duration-200"
                      >
                        <Briefcase className="h-4 w-4 text-purple-500" />
                        <span className="max-w-[120px] truncate">
                          {activeEntity?.name || "Select Entity"}
                        </span>
                        <ChevronDown className="h-4 w-4 text-gray-400" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-64">
                      <DropdownMenuLabel className="text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Your Entities
                      </DropdownMenuLabel>
                      <DropdownMenuSeparator />
                      {entities && entities.length > 0 ? (
                        <DropdownMenuGroup>
                          {entities.map((entity) => (
                            <DropdownMenuItem
                              key={entity.id}
                              onClick={() => handleSwitchEntity(entity.id)}
                              className={cn(
                                "flex items-center gap-2 py-2",
                                activeEntity?.id === entity.id ? "bg-purple-50 text-purple-900" : ""
                              )}
                            >
                              <Briefcase className="h-4 w-4 text-gray-500" />
                              <div className="flex flex-col">
                                <span className="font-medium">{entity.name}</span>
                                <span className="text-xs text-gray-500">Entity</span>
                              </div>
                            </DropdownMenuItem>
                          ))}
                        </DropdownMenuGroup>
                      ) : (
                        <DropdownMenuItem
                          onClick={() => navigate('/settings')}
                          className="flex items-center gap-2 py-2 text-gray-500"
                        >
                          <Plus className="h-4 w-4" />
                          <div className="flex flex-col">
                            <span className="font-medium">Create Entity</span>
                            <span className="text-xs">Get started with SlipScan</span>
                          </div>
                        </DropdownMenuItem>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>

                {/* Entity Selector - Mobile */}
                <div className="md:hidden">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button 
                        variant="ghost" 
                        className="h-9 px-2 text-sm font-medium flex items-center gap-1 border border-gray-200 text-gray-700 bg-white hover:bg-gray-50 hover:border-purple-300 transition-all duration-200"
                      >
                        <Briefcase className="h-4 w-4 text-purple-500" />
                        <span className="max-w-[60px] truncate text-xs">
                          {activeEntity?.name || "Entity"}
                        </span>
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-64">
                      <DropdownMenuLabel className="text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Your Entities
                      </DropdownMenuLabel>
                      <DropdownMenuSeparator />
                      {entities && entities.length > 0 ? (
                        <DropdownMenuGroup>
                          {entities.map((entity) => (
                            <DropdownMenuItem
                              key={entity.id}
                              onClick={() => handleSwitchEntity(entity.id)}
                              className={cn(
                                "flex items-center gap-2 py-2",
                                activeEntity?.id === entity.id ? "bg-purple-50 text-purple-900" : ""
                              )}
                            >
                              <Briefcase className="h-4 w-4 text-gray-500" />
                              <div className="flex flex-col">
                                <span className="font-medium">{entity.name}</span>
                                <span className="text-xs text-gray-500">Entity</span>
                              </div>
                            </DropdownMenuItem>
                          ))}
                        </DropdownMenuGroup>
                      ) : (
                        <DropdownMenuItem
                          onClick={() => navigate('/settings')}
                          className="flex items-center gap-2 py-2 text-gray-500"
                        >
                          <Plus className="h-4 w-4" />
                          <div className="flex flex-col">
                            <span className="font-medium">Create Entity</span>
                            <span className="text-xs">Get started with SlipScan</span>
                          </div>
                        </DropdownMenuItem>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>

                {/* User Profile Dropdown */}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button 
                      variant="ghost" 
                      className="h-10 w-10 rounded-full border-2 border-gray-200 hover:border-purple-300 transition-all duration-200 p-0"
                    >
                      <Avatar className="h-8 w-8">
                        <AvatarFallback className="bg-gradient-to-r from-purple-500 to-blue-500 text-white font-semibold text-sm">
                          {getUserInitials()}
                        </AvatarFallback>
                      </Avatar>
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-56">
                    <DropdownMenuLabel className="font-normal">
                      <div className="flex flex-col space-y-1">
                        <p className="text-sm font-medium leading-none">
                          {user?.user_metadata?.full_name || user?.email?.split('@')[0] || 'User'}
                        </p>
                        <p className="text-xs leading-none text-muted-foreground">
                          {user?.email}
                        </p>
                      </div>
                    </DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    <DropdownMenuGroup>
                      <DropdownMenuItem onClick={() => navigate('/dashboard')}>
                        <LayoutDashboard className="mr-2 h-4 w-4" />
                        <span>Dashboard</span>
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => navigate('/settings')}>
                        <UserCircle className="mr-2 h-4 w-4" />
                        <span>Profile</span>
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => navigate('/settings')}>
                        <Settings className="mr-2 h-4 w-4" />
                        <span>Settings</span>
                      </DropdownMenuItem>
                    </DropdownMenuGroup>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem 
                      onClick={handleSignOut}
                      className="text-red-600 focus:text-red-600 focus:bg-red-50"
                    >
                      <LogOut className="mr-2 h-4 w-4" />
                      <span>Sign out</span>
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </>
            ) : (
              <div className="flex items-center gap-3">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => navigate('/signin')}
                  className="text-sm font-semibold text-gray-700 hover:text-purple-600 transition-colors"
                >
                  Sign In
                </Button>
                <Button
                  size="sm"
                  className="bg-gradient-to-r from-purple-500 to-blue-500 text-white font-semibold shadow-lg hover:shadow-xl transition-all duration-200"
                  onClick={() => navigate('/signup')}
                >
                  Get Started
                </Button>
              </div>
            )}
          </div>
        </div>
      </nav>
    </header>
  );
};

export default TopBar;