// SideNav.js
import React from 'react';
import {
  LayoutDashboard,
  Users,
  ShoppingCart,
  CreditCard,
  RefreshCcw,
  Webhook,
  Key,
  Settings,
} from 'lucide-react';
import { NavItem } from './nav-item';

const navItems = [
  { to: '/dashboard', icon: LayoutDashboard, text: 'Dashboard' },
  { to: '/customers', icon: Users, text: 'Customers' },
  { to: '/transactions', icon: ShoppingCart, text: 'Transactions' },
  { to: '/payments', icon: CreditCard, text: 'Payments' },
  { to: '/refunds', icon: RefreshCcw, text: 'Refunds' },
  { to: '/webhooks', icon: Webhook, text: 'Webhooks' },
  { to: '/apikeys', icon: Key, text: 'API Keys' },
  { to: '/settings', icon: Settings, text: 'Settings' },
];

const SideNav = ({ isExpanded, setIsExpanded, isMobile }) => {
  const handleMouseEnter = () => {
    if (!isMobile) {
      setIsExpanded(true); // Expand sidebar on desktop hover
    }
  };

  const handleMouseLeave = () => {
    if (!isMobile) {
      setIsExpanded(false); // Collapse sidebar on desktop mouse leave
    }
  };

  return (
    <div
      className={`fixed top-16 left-0 h-[calc(100vh-4rem)] bg-gray-800 text-white shadow-md transition-all duration-300 ${
        isExpanded ? 'w-60' : 'w-16'
      }`}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <div className="mt-9">
        <ul className="space-y-1">
          {navItems.map((item) => (
            <NavItem key={item.to} {...item} isExpanded={isExpanded} />
          ))}
        </ul>
      </div>
    </div>
  );
};

export default SideNav;
