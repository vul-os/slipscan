import React, { createContext, useContext, useState } from "react";

// StepperContext setup
const StepperContext = createContext(null);

const StepperProvider = ({ children, initialStep = 0, steps = [], state = null }) => {
  const [activeStep, setActiveStep] = useState(initialStep);

  const isError = state === "error";
  const isLoading = state === "loading";

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

const useStepper = () => {
  const context = useContext(StepperContext);
  if (!context) {
    throw new Error("useStepper must be used within a StepperProvider");
  }

  const { activeStep, steps, setStep, isError, isLoading, nextStep, prevStep } = context;

  const isLastStep = steps.length > 0 && activeStep === steps.length - 1;
  const isDisabledStep = activeStep === 0;
  const currentStep = steps[activeStep] || null;

  return {
    ...context,
    isLastStep,
    isDisabledStep,
    currentStep,
  };
};

export { StepperContext, StepperProvider, useStepper };
