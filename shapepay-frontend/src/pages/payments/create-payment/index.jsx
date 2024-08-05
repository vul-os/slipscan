import React, { useState } from "react";
import { Stepper, Step } from "@/components/stepper";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import PaymentTypeStep from "./payment-type";
import PaymentDetailsStep from "./payment-details";
import CustomerDetailsStep from "./customer-details";
import Footer from "./footer";
import { StepperProvider, useStepper } from "@/components/stepper/context";

// Define steps for the Stepper
const steps = [
  { label: "Payment Type" },
  { label: "Payment Details" },
  { label: "Customer Details" },
];

// CreatePaymentForm Component
const CreatePaymentForm = ({ isOpen, onClose, onSubmit }) => {
  // State to handle form data
  const [newPayment, setNewPayment] = useState({
    paymentType: "",
    amount: "",
    description: "",
    customerEmail: "",
    customerPhone: "",
  });

  // Handle form submission
  const handleSubmit = (e) => {
    e.preventDefault();
    onSubmit(newPayment);
    setNewPayment({
      paymentType: "",
      amount: "",
      description: "",
      customerEmail: "",
      customerPhone: "",
    });
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl bg-gray-800 text-gray-100 rounded-lg shadow-lg">
        <DialogHeader>
          <DialogTitle className="text-lg font-semibold text-center">
            Create New Payment
          </DialogTitle>
        </DialogHeader>
        <StepperProvider initialStep={0} steps={steps}>
          <div className="flex w-full flex-col gap-4 p-6">
            <Stepper>
              {steps.map((stepProps, index) => (
                <Step key={stepProps.label} {...stepProps}>
                  {index === 0 && (
                    <PaymentTypeStep
                      newPayment={newPayment}
                      setNewPayment={setNewPayment}
                    />
                  )}
                  {index === 1 && (
                    <PaymentDetailsStep
                      newPayment={newPayment}
                      setNewPayment={setNewPayment}
                    />
                  )}
                  {index === 2 && (
                    <CustomerDetailsStep
                      newPayment={newPayment}
                      setNewPayment={setNewPayment}
                    />
                  )}
                </Step>
              ))}
            </Stepper>
            <StepperFooter onSubmit={handleSubmit} newPayment={newPayment} />
          </div>
        </StepperProvider>
      </DialogContent>
    </Dialog>
  );
};

// Separate component for the footer to use useStepper hook
const StepperFooter = ({ onSubmit, newPayment }) => {
  const { activeStep } = useStepper();
  
  if (activeStep === 0) return null;
  
  return <Footer onSubmit={onSubmit} newPayment={newPayment} />;
};

export default CreatePaymentForm;