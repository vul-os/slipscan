import React, { useContext } from "react";
import { Link as RouterLink } from "react-router-dom";
import { Menu, LogIn, LogOut } from "lucide-react";
import { Button } from "@/components/ui/button"; // Ensure this path is correct
import AuthContext from "../../context/auth-context"; // Ensure this path is correct

const TopBar = ({ onMenuClick }) => {
  const { user, signOut } = useContext(AuthContext);

  return (
    <nav className="fixed top-0 left-0 right-0 z-50 bg-white shadow-md p-4 flex justify-between items-center">
      <div className="flex items-center">
        {/* Menu Icon Button for opening the drawer */}
        <button
          className="mr-2 text-gray-700 hover:text-gray-900 focus:outline-none sm:hidden"
          onClick={onMenuClick}
          aria-label="open drawer"
        >
          <Menu size={24} />
        </button>

        {/* Application Title */}
        <h1 className="text-lg font-semibold text-gray-900">
          PayShap Integration
        </h1>
      </div>

      {/* Authentication Section */}
      <div className="flex items-center">
        {user ? (
          <>
            {/* Display user's email */}
            <span className="mr-4 text-gray-700">{user.email}</span>
            {/* Sign Out Button */}
            <Button
              variant="ghost"
              onClick={signOut}
              className="flex items-center gap-2"
            >
              <LogOut size={20} />
              Sign Out
            </Button>
          </>
        ) : (
          // Login Button
          <Button
            variant="ghost"
            as={RouterLink}
            to="/login"
            className="flex items-center gap-2"
          >
            <LogIn size={20} />
            Login
          </Button>
        )}
      </div>
    </nav>
  );
};

export default TopBar;
