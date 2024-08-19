import React, { useContext } from 'react';
import { Navigate } from 'react-router-dom';
import { Progress } from "@/components/ui/progress"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { AuthContext } from '../../context/use-auth';

const ProtectedRoute = ({ children }) => {
  const { user, loading } = useContext(AuthContext);

  if (loading) {
    return (
      <div className="w-full max-w-md mx-auto mt-8">
        <Progress value={33} className="w-full" />
      </div>
    );
  }

  if (!user) {
    return (
      <>
        <Alert variant="destructive" className="mb-4">
          <AlertDescription>
            You must be logged in to access this page. Redirecting to login...
          </AlertDescription>
        </Alert>
        <Navigate to="/login" />
      </>
    );
  }

  return children;
};

export default ProtectedRoute;