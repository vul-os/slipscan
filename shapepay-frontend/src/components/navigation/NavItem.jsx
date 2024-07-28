import React from 'react';
import { ListItem, ListItemIcon, ListItemText } from '@mui/material';
import { Link as RouterLink } from 'react-router-dom';

const NavItem = ({ to, icon, primary }) => {
  return (
    <ListItem button component={RouterLink} to={to}>
      <ListItemIcon>{icon}</ListItemIcon>
      <ListItemText primary={primary} />
    </ListItem>
  );
};

export default NavItem;
