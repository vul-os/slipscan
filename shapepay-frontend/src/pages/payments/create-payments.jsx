"use client";

import React, { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StepperProvider } from "@/components/stepper/context";
import { Stepper, Step, useStepper } from "@/components/stepper";

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

  // Define steps for the Stepper
  const steps = [
    {
      label: "Payment Type",
      description: "Select the type of payment",
    },
    {
      label: "Payment Details",
      description: "Enter the payment amount and description",
    },
    {
      label: "Customer Details",
      description: "Provide customer contact information",
    },
  ];

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl bg-gray-800 text-gray-100 rounded-lg shadow-lg">
        <DialogHeader>
          <DialogTitle className="text-lg font-semibold text-center">
            Create New Payment
          </DialogTitle>
        </DialogHeader>
        <StepperProvider steps={steps} initialStep={0}>
          <form onSubmit={handleSubmit}>
            <Stepper>
              <Step label="Payment Type" description="Select the type of payment">
                <div className="flex flex-col items-center justify-center gap-6 py-8">
                  <Label className="text-center text-sm font-medium text-gray-300 mb-4">
                    Choose Payment Type
                  </Label>
                  {/* Payment Type Buttons */}
                  <div className="flex flex-wrap justify-center gap-4">
                    {["Simple Payment", "Split Payment", "Installment Plan", "Subscription"].map((type) => (
                      <Button
                        key={type}
                        onClick={() => {
                          setNewPayment({ ...newPayment, paymentType: type.toLowerCase().replace(' ', '-') });
                          setStep(1); // Move to the next step after selection
                        }}
                        className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-3 rounded-lg shadow-md"
                      >
                        {type}
                      </Button>
                    ))}
                  </div>
                </div>
              </Step>

              <Step
                label="Payment Details"
                description="Enter the payment amount and description"
              >
                <div className="grid gap-4 py-4 px-6">
                  <div className="grid grid-cols-4 items-center gap-4">
                    <Label htmlFor="amount" className="text-left text-sm font-medium text-gray-300">
                      Amount
                    </Label>
                    <Input
                      id="amount"
                      type="number"
                      step="0.01"
                      value={newPayment.amount}
                      onChange={(e) =>
                        setNewPayment({ ...newPayment, amount: e.target.value })
                      }
                      className="col-span-3 bg-gray-700 text-gray-100 p-2 rounded-md border border-gray-600"
                      required
                    />
                  </div>
                  <div className="grid grid-cols-4 items-center gap-4">
                    <Label htmlFor="description" className="text-left text-sm font-medium text-gray-300">
                      Description
                    </Label>
                    <Input
                      id="description"
                      value={newPayment.description}
                      onChange={(e) =>
                        setNewPayment({ ...newPayment, description: e.target.value })
                      }
                      className="col-span-3 bg-gray-700 text-gray-100 p-2 rounded-md border border-gray-600"
                      required
                    />
                  </div>
                </div>
              </Step>

              <Step
                label="Customer Details"
                description="Provide customer contact information"
              >
                <div className="grid gap-4 py-4 px-6">
                  <div className="grid grid-cols-4 items-center gap-4">
                    <Label htmlFor="customerEmail" className="text-left text-sm font-medium text-gray-300">
                      Customer Email
                    </Label>
                    <Input
                      id="customerEmail"
                      type="email"
                      value={newPayment.customerEmail}
                      onChange={(e) =>
                        setNewPayment({ ...newPayment, customerEmail: e.target.value })
                      }
                      className="col-span-3 bg-gray-700 text-gray-100 p-2 rounded-md border border-gray-600"
                    />
                  </div>
                  <div className="grid grid-cols-4 items-center gap-4">
                    <Label htmlFor="customerPhone" className="text-left text-sm font-medium text-gray-300">
                      Customer Phone
                    </Label>
                    <Input
                      id="customerPhone"
                      type="tel"
                      value={newPayment.customerPhone}
                      onChange={(e) =>
                        setNewPayment({ ...newPayment, customerPhone: e.target.value })
                      }
                      className="col-span-3 bg-gray-700 text-gray-100 p-2 rounded-md border border-gray-600"
                    />
                  </div>
                  <p className="text-sm text-gray-400 col-span-4">
                    Please provide either an email or phone number.
                  </p>
                </div>
              </Step>
            </Stepper>

            <StepperFooter
              setNewPayment={setNewPayment}
              newPayment={newPayment}
              onSubmit={onSubmit}
            />
          </form>
        </StepperProvider>
      </DialogContent>
    </Dialog>
  );
};

// StepperFooter Component
const StepperFooter = ({ setNewPayment, newPayment, onSubmit }) => {
  const { activeStep, setStep, isLastStep, isDisabledStep } = useStepper();

  const handleNext = () => {
    if (!isLastStep) setStep(activeStep + 1);
  };

  const handleBack = () => {
    if (!isDisabledStep) setStep(activeStep - 1);
  };

  return (
    <DialogFooter className="flex justify-between px-6 py-4 bg-gray-900 rounded-b-lg">
      {!isDisabledStep && (
        <Button onClick={handleBack} className="bg-gray-600 hover:bg-gray-700 text-white">
          Back
        </Button>
      )}
      {!isLastStep ? (
        <Button onClick={handleNext} className="bg-blue-600 hover:bg-blue-700 text-white">
          Next
        </Button>
      ) : (
        <Button
          type="submit"
          className="bg-blue-600 hover:bg-blue-700 text-white"
          disabled={!newPayment.customerEmail && !newPayment.customerPhone} // Disable if no email or phone
          onClick={() => {
            onSubmit(newPayment);
            setNewPayment({
              paymentType: "",
              amount: "",
              description: "",
              customerEmail: "",
              customerPhone: "",
            });
            setStep(0);
          }}
        >
          Submit Payment
        </Button>
      )}
    </DialogFooter>
  );
};

export default CreatePaymentForm;
