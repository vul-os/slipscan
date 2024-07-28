import React, { useState } from 'react';
import { Drawer, List, ListItem, ListItemIcon, ListItemText, Box } from '@mui/material';
import { styled } from '@mui/material/styles';
import { Link as RouterLink } from 'react-router-dom';
import DashboardIcon from '@mui/icons-material/Dashboard';
import PeopleIcon from '@mui/icons-material/People';
import ShoppingCartIcon from '@mui/icons-material/ShoppingCart';
import PaymentIcon from '@mui/icons-material/Payment';
import ReplayIcon from '@mui/icons-material/Replay';
import WebhookIcon from '@mui/icons-material/Webhook';
import VpnKeyIcon from '@mui/icons-material/VpnKey';
import SettingsIcon from '@mui/icons-material/Settings';

const drawerWidth = 240;
const closedDrawerWidth = 64;
const topBarHeight = 35; // Adjust this value to match your top bar height

const StyledDrawer = styled(Drawer)(({ theme }) => ({
  width: closedDrawerWidth,
  flexShrink: 0,
  whiteSpace: 'nowrap',
  boxSizing: 'border-box',
  overflowX: 'hidden',
  '& .MuiDrawer-paper': {
    width: closedDrawerWidth,
    overflowX: 'hidden',
    transition: theme.transitions.create('width', {
      easing: theme.transitions.easing.sharp,
      duration: theme.transitions.duration.leavingScreen,
    }),
    '&:hover': {
      width: drawerWidth,
      overflowX: 'hidden',
      transition: theme.transitions.create('width', {
        easing: theme.transitions.easing.sharp,
        duration: theme.transitions.duration.enteringScreen,
      }),
    },
  },
}));

const NavItem = ({ to, icon, text }) => (
  <ListItem button component={RouterLink} to={to}>
    <ListItemIcon>{icon}</ListItemIcon>
    <ListItemText primary={text} sx={{ opacity: { sm: 0, lg: 1 } }} />
  </ListItem>
);

const navItems = [
  { to: '/dashboard', icon: <DashboardIcon />, text: 'Dashboard' },
  { to: '/customers', icon: <PeopleIcon />, text: 'Customers' },
  { to: '/transactions', icon: <ShoppingCartIcon />, text: 'Transactions' },
  { to: '/payments', icon: <PaymentIcon />, text: 'Payments' },
  { to: '/refunds', icon: <ReplayIcon />, text: 'Refunds' },
  { to: '/webhooks', icon: <WebhookIcon />, text: 'Webhooks' },
  { to: '/apikeys', icon: <VpnKeyIcon />, text: 'API Keys' },
  { to: '/settings', icon: <SettingsIcon />, text: 'Settings' },
];

const SideNav = ({ isMobile, mobileOpen, onMobileClose }) => {
  const [isHovered, setIsHovered] = useState(false);

  const handleMouseEnter = () => {
    setIsHovered(true);
  };

  const handleMouseLeave = () => {
    setIsHovered(false);
  };

  const drawerContent = (
    <Box sx={{ mt: `${topBarHeight}px` }}> {/* Add top margin to create space for the top bar */}
      <List onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave}>
        {navItems.map((item) => (
          <NavItem key={item.to} {...item} />
        ))}
      </List>
    </Box>
  );

  return (
    <Box
      component="nav"
      sx={{ width: { sm: isHovered ? drawerWidth : closedDrawerWidth }, flexShrink: { sm: 0 } }}
    >
      {isMobile ? (
        <Drawer
          variant="temporary"
          open={mobileOpen}
          onClose={onMobileClose}
          ModalProps={{
            keepMounted: true, // Better open performance on mobile.
          }}
          sx={{
            '& .MuiDrawer-paper': { 
              boxSizing: 'border-box', 
              width: drawerWidth,
              paddingTop: `${topBarHeight}px`, // Add top padding for mobile drawer
            },
          }}
        >
          {drawerContent}
        </Drawer>
      ) : (
        <StyledDrawer 
          variant="permanent"
          sx={{
            '& .MuiDrawer-paper': {
              paddingTop: `${topBarHeight}px`, // Add top padding for desktop drawer
            },
          }}
        >
          {drawerContent}
        </StyledDrawer>
      )}
    </Box>
  );
};

export default SideNav;