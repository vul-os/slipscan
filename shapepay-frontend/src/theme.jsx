import { createTheme } from '@mui/material/styles';

// Create a theme instance.
const theme = createTheme({
  palette: {
    primary: {
      main: '#1976d2', // Customize the primary color
    },
    secondary: {
      main: '#dc004e', // Customize the secondary color
    },
    background: {
      default: '#f0f2f5', // Customize the default background color
    },
  },
  typography: {
    fontFamily: 'Roboto, Arial, sans-serif', // Customize the font family
  },
  components: {
    MuiButton: {
      styleOverrides: {
        root: {
          borderRadius: 8, // Customize the border radius of buttons
        },
      },
    },
    MuiTextField: {
      styleOverrides: {
        root: {
          marginBottom: '16px', // Customize the margin bottom of text fields
        },
      },
    },
    // Add more component style overrides here if needed
  },
});

export default theme;
