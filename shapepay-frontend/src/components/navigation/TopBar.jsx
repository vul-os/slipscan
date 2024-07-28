import React, { useContext } from 'react';
import { AppBar, Toolbar, Typography, Button, IconButton } from '@mui/material';
import MenuIcon from '@mui/icons-material/Menu';
import AuthContext from '../../context/AuthContext';

const TopBar = ({ onMenuClick }) => {
  const { user, signOut } = useContext(AuthContext);
  
  return (
    <AppBar position="fixed" sx={{ zIndex: (theme) => theme.zIndex.drawer + 1 }}>
      <Toolbar>
        <IconButton
          color="inherit"
          aria-label="open drawer"
          edge="start"
          onClick={onMenuClick}
          sx={{ mr: 2, display: { sm: 'none' } }}
        >
          <MenuIcon />
        </IconButton>
        <Typography variant="h6" noWrap component="div" sx={{ flexGrow: 1 }}>
          PayShap Integration
        </Typography>
        {user ? (
          <>
            <Typography variant="body1" sx={{ mr: 2 }}>
              {user.email}
            </Typography>
            <Button color="inherit" onClick={signOut}>Sign Out</Button>
          </>
        ) : (
          <Button color="inherit" href="/login">Login</Button>
        )}
      </Toolbar>
    </AppBar>
  );
};

export default TopBar;