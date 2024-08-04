import React from 'react';
import { Outlet } from 'react-router-dom';

const BlankLayout = () => {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <main className="w-full max-w-md p-6">
        <Outlet />
      </main>
    </div>
  );
};

export default BlankLayout;