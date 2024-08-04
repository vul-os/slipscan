import React, { useState } from 'react';
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
import { NavItem } from './nav-item'

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

const SideNav = () => {
  const [isExpanded, setIsExpanded] = useState(false);

  // Function to handle mouse enter event
  const handleMouseEnter = () => {
    setIsExpanded(true);
  };

  // Function to handle mouse leave event
  const handleMouseLeave = () => {
    setIsExpanded(false);
  };

  return (
    <div
      className={`fixed inset-y-0 left-0 bg-white shadow-md overflow-hidden transition-all duration-300 ${
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
