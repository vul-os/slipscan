import React, { useState, useRef, useEffect, useContext } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { Menu, User, ChevronDown } from 'lucide-react';
import { AuthContext } from '../../context/use-auth';

const TopBar = ({ onMenuClick }) => {
  const { user, signOut, merchants, activeMerchantId, setActiveMerchantId } = useContext(AuthContext);
  const [userDropdownOpen, setUserDropdownOpen] = useState(false);
  const [merchantDropdownOpen, setMerchantDropdownOpen] = useState(false);
  const userDropdownRef = useRef(null);
  const merchantDropdownRef = useRef(null);

  // Toggle the user dropdown
  const toggleUserDropdown = () => {
    setUserDropdownOpen(!userDropdownOpen);
  };

  // Toggle the merchant dropdown
  const toggleMerchantDropdown = () => {
    setMerchantDropdownOpen(!merchantDropdownOpen);
  };

  // Handle clicking outside the dropdowns to close them
  const handleClickOutside = (event) => {
    if (userDropdownRef.current && !userDropdownRef.current.contains(event.target)) {
      setUserDropdownOpen(false);
    }
    if (merchantDropdownRef.current && !merchantDropdownRef.current.contains(event.target)) {
      setMerchantDropdownOpen(false);
    }
  };

  useEffect(() => {
    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, []);

  const handleSignOut = () => {
    signOut();
    setUserDropdownOpen(false);
  };

  const handleMerchantChange = (merchantId) => {
    setActiveMerchantId(merchantId);
    setMerchantDropdownOpen(false);
  };

  const activeMerchant = merchants.find(m => m.id === activeMerchantId);

  return (
    <nav className="fixed top-0 left-0 right-0 z-50 bg-gray-900 text-white shadow-md h-16 flex justify-between items-center px-6 border-b border-gray-700">
      <div className="flex items-center">
        <button
          className="mr-2 text-white hover:text-primary focus:outline-none md:hidden"
          onClick={onMenuClick}
          aria-label="Open navigation menu"
        >
          <Menu size={24} />
        </button>
      </div>

      <div className="flex items-center relative">
        {user && (
          <div className="mr-4 relative">
            <button
              onClick={toggleMerchantDropdown}
              className="flex items-center gap-2 focus:outline-none hover:text-primary"
              aria-label="Select merchant"
            >
              <span>{activeMerchant ? activeMerchant.name : 'Select Merchant'}</span>
              <ChevronDown size={16} />
            </button>
            {merchantDropdownOpen && (
              <div
                ref={merchantDropdownRef}
                className="absolute mt-1 w-48 bg-white border border-gray-200 shadow-lg rounded-md z-10"
                style={{ top: 'calc(100% + 16px)', right: '0' }}
              >
                {merchants.map(merchant => (
                  <button
                    key={merchant.id}
                    onClick={() => handleMerchantChange(merchant.id)}
                    className="w-full text-left px-4 py-2 text-gray-800 hover:bg-gray-100"
                  >
                    {merchant.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        
        {user ? (
          <>
            <button
              onClick={toggleUserDropdown}
              className="flex items-center gap-2 focus:outline-none hover:text-primary"
              aria-label="User menu"
            >
              <User size={24} className="text-white" />
            </button>
            {userDropdownOpen && (
              <div
                ref={userDropdownRef}
                className="absolute mt-1 w-48 bg-white border border-gray-200 shadow-lg rounded-md z-10"
                style={{ top: 'calc(100% + 16px)', right: '0' }}
              >
                <div className="px-4 py-2 text-gray-800 font-medium">
                  {user.email}
                </div>
                {/* <RouterLink
                  to="/account"
                  className="block px-4 py-2 text-gray-800 hover:bg-gray-100"
                  onClick={() => setUserDropdownOpen(false)}
                >
                  Account
                </RouterLink> */}
                <button
                  onClick={handleSignOut}
                  className="w-full text-left px-4 py-2 text-gray-800 hover:bg-gray-100"
                >
                  Sign Out
                </button>
              </div>
            )}
          </>
        ) : (
          <RouterLink
            to="/login"
            className="flex items-center gap-2 hover:text-primary"
          >
            Login
          </RouterLink>
        )}
      </div>
    </nav>
  );
};

export default TopBar;