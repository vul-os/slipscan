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
  Banknote
} from 'lucide-react';
import { NavItem } from './nav-item';

const navItems = [
  { to: '/dashboard', icon: LayoutDashboard, text: 'Dashboard' },
  { to: '/payments', icon: CreditCard, text: 'Payments' },
  { to: '/payouts', icon: Banknote, text: 'Payouts' },
  { to: '/refunds', icon: RefreshCcw, text: 'Refunds' },
  { to: '/customers', icon: Users, text: 'Customers' },
  { to: '/webhooks', icon: Webhook, text: 'Webhooks' },
  { to: '/apikeys', icon: Key, text: 'API Keys' },
  { to: '/settings', icon: Settings, text: 'Settings' },
];

const SideNav = ({ isExpanded, isMobile }) => {
  return (
    <div
      className={`fixed top-16 left-0 h-[calc(100vh-4rem)] bg-gray-800 text-white shadow-md transition-all duration-300 ${
        isExpanded ? 'w-60' : isMobile ? 'w-0' : 'w-16'
      }`}
    >
      <div className="mt-9">
        <ul className="space-y-1">
          {navItems.map((item) => (
            <NavItem 
              key={item.to} 
              {...item} 
              isExpanded={isExpanded} 
              isMobile={isMobile}
            />
          ))}
        </ul>
      </div>
    </div>
  );
};

export default SideNav;