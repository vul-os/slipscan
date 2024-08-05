"use client";

import React, { useState, useCallback } from "react";
import { Stepper, Step } from "@/components/stepper";
import { useStepper } from "@/components/stepper/use-stepper";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import PaymentTypeStep from "./payment-type";
import PaymentDetailsStep from "./payment-details";
import CustomerDetailsStep from "./customer-details";
import { Button } from "@/components/ui/button";

const steps = [
  { label: "Payment Type" },
  { label: "Payment Details" },
  { label: "Customer Details" },
];

const initialPaymentState = {
  paymentType: "",
  amount: "",
  description: "",
  customerEmail: "",
  customerPhone: "",
};

const CreatePaymentForm = ({ isOpen, onClose, onSubmit }) => {
  const [newPayment, setNewPayment] = useState(initialPaymentState);
  const { activeStep } = useStepper();

  const handleSubmit = useCallback((e) => {
    e.preventDefault();
    onSubmit(newPayment);
    setNewPayment(initialPaymentState);
  }, [newPayment, onSubmit]);
  console.log("here:L ", activeStep)
  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl bg-gray-800 text-gray-100 rounded-lg shadow-lg">
        <DialogHeader>
          <DialogTitle className="text-lg font-semibold text-center">
            Create New Payment
          </DialogTitle>
        </DialogHeader>
        <Stepper initialStep={0} steps={steps}>
          {steps.map((stepProps, index) => (
            <Step key={stepProps.label} {...stepProps}>
              <StepContent 
                step={index}
                newPayment={newPayment} 
                setNewPayment={setNewPayment} 
              />
            </Step>
          ))}
            <StepperFooter newPayment={newPayment} onSubmit={handleSubmit} />
        </Stepper>
      </DialogContent>
    </Dialog>
  );
};

const StepContent = ({ step, newPayment, setNewPayment }) => {
  const { activeStep } = useStepper();

  if (step !== activeStep) return null;

  switch (step) {
    case 0:
      return <PaymentTypeStep newPayment={newPayment} setNewPayment={setNewPayment} />;
    case 1:
      return <PaymentDetailsStep newPayment={newPayment} setNewPayment={setNewPayment} />;
    case 2:
      return <CustomerDetailsStep newPayment={newPayment} setNewPayment={setNewPayment} />;
    default:
      return null;
  }
};

const StepperFooter = ({ onSubmit, newPayment }) => {
  const { 
    nextStep, 
    prevStep, 
    resetSteps, 
    activeStep,
    hasCompletedAllSteps, 
    isLastStep,
    isOptionalStep,
    isDisabledStep
  } = useStepper();

  if (activeStep === 0) {
    return null
  }

  const isSecondStepCompleted = newPayment.amount && newPayment.description;
  if (!isSecondStepCompleted) {
    return (
        <div className="mt-4 flex justify-between items-center">
            <div>
            {activeStep > 0 && (
                <Button 
                disabled={isDisabledStep} 
                onClick={prevStep} 
                size="sm" 
                variant="secondary"
                >
                Previous
                </Button>
            )}
            </div>
        </div>
    )
  }

  if (hasCompletedAllSteps) {
    return (
      <div className="mt-4">
        <div className="h-40 flex items-center justify-center my-2 border bg-secondary text-primary rounded-md">
          <h1 className="text-xl">Woohoo! All steps completed! 🎉</h1>
        </div>
        <div className="w-full flex justify-end">
          <Button size="sm" onClick={resetSteps}>
            Reset
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-4 flex justify-between items-center">
      <div>
        {activeStep > 0 && (
          <Button 
            disabled={isDisabledStep} 
            onClick={prevStep} 
            size="sm" 
            variant="secondary"
          >
            Previous
          </Button>
        )}
      </div>
      <div>
        <Button 
          size="sm" 
          onClick={isLastStep ? onSubmit : nextStep}
        >
          {isLastStep ? "Finish" : isOptionalStep ? "Skip" : "Next"}
        </Button>
      </div>
    </div>
  );
};

export default CreatePaymentForm;