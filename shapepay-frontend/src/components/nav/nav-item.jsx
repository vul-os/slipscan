import React from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { cn } from "@/lib/utils"

export const NavItem = ({ to, icon: Icon, text, isExpanded }) => (
  <li className="list-none">
    <RouterLink
      to={to}
      className="flex items-center p-4 text-gray-700 hover:bg-gray-100 transition-colors duration-200"
    >
      <Icon className="h-6 w-6 text-gray-500 mr-3" />
      <span className={`${isExpanded ? 'block' : 'hidden'} text-sm font-medium`}>
        {text}
      </span>
    </RouterLink>
  </li>
);

export default NavItem;
