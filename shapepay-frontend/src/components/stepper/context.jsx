import React, { createContext, useContext, useState, useEffect } from "react";

// Step 1: Create the StepperContext
const StepperContext = createContext(null);

// Step 2: Implement the StepperProvider
const StepperProvider = ({ children, initialStep = 0, steps = [], state = null }) => {
  // State management
  const [activeStep, setActiveStep] = useState(initialStep);
  const isError = state === "error";
  const isLoading = state === "loading";

  // State transition methods
  const nextStep = () => {
    setActiveStep((prevStep) => Math.min(prevStep + 1, steps.length - 1));
  };

  const prevStep = () => {
    setActiveStep((prevStep) => Math.max(prevStep - 1, 0));
  };

  const resetSteps = () => {
    setActiveStep(initialStep);
  };

  const setStep = (step) => {
    if (step >= 0 && step < steps.length) {
      setActiveStep(step);
    }
  };

  // Context value
  const contextValue = {
    activeStep,
    steps,
    isError,
    isLoading,
    nextStep,
    prevStep,
    resetSteps,
    setStep,
  };

  return (
    <StepperContext.Provider value={contextValue}>
      {children}
    </StepperContext.Provider>
  );
};

// Step 3: Develop the useStepper Hook
const useStepper = () => {
  const context = useContext(StepperContext);

  if (!context) {
    throw new Error("useStepper must be used within a StepperProvider");
  }

  const { activeStep, steps, setStep, isError, isLoading, nextStep, prevStep } = context;

  // Calculate additional stepper information
  const isLastStep = steps.length > 0 && activeStep === steps.length - 1;
  const isDisabledStep = activeStep === 0;
  const currentStep = steps[activeStep] || null;

  // Log context data for debugging
  console.log("Active Step:", activeStep);
  console.log("Steps:", steps);
  console.log("Current Step:", currentStep);

  return {
    ...context,
    isLastStep,
    isDisabledStep,
    currentStep,
  };
};

// Export StepperContext, StepperProvider, and useStepper
export { StepperContext, StepperProvider, useStepper };
