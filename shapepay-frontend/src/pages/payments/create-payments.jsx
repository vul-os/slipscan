"use client";

import React, { useState } from "react";
import { Step, Stepper, useStepper } from "@/components/stepper";
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
        <div className="flex w-full flex-col gap-4 p-6">
          <Stepper initialStep={0} steps={steps}>
            <Step key="Payment Type" label="Payment Type">
              <PaymentTypeStep
                newPayment={newPayment}
                setNewPayment={setNewPayment}
              />
            </Step>
            <Step key="Payment Details" label="Payment Details">
              <PaymentDetailsStep
                newPayment={newPayment}
                setNewPayment={setNewPayment}
              />
            </Step>
            <Step key="Customer Details" label="Customer Details">
              <CustomerDetailsStep
                newPayment={newPayment}
                setNewPayment={setNewPayment}
              />
            </Step>
            <Footer onSubmit={handleSubmit} />
          </Stepper>
        </div>
      </DialogContent>
    </Dialog>
  );
};

// Payment Type Step
const PaymentTypeStep = ({ newPayment, setNewPayment }) => {
  const { setStep } = useStepper();

  return (
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
            className={`px-6 py-3 rounded-lg shadow-md ${
              newPayment.paymentType === type.toLowerCase().replace(' ', '-') ? 'bg-blue-700' : 'bg-blue-600 hover:bg-blue-700'
            } text-white`}
          >
            {type}
          </Button>
        ))}
      </div>
    </div>
  );
};

// Payment Details Step
const PaymentDetailsStep = ({ newPayment, setNewPayment }) => {
  return (
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
  );
};

// Customer Details Step
const CustomerDetailsStep = ({ newPayment, setNewPayment }) => {
  return (
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
  );
};

// Footer Component
const Footer = ({ onSubmit }) => {
  const {
    nextStep,
    prevStep,
    resetSteps,
    hasCompletedAllSteps,
    isLastStep,
    isOptionalStep,
    isDisabledStep,
  } = useStepper();

  return (
    <DialogFooter className="flex justify-between px-6 py-4 bg-gray-900 rounded-b-lg">
      {hasCompletedAllSteps && (
        <div className="h-40 flex items-center justify-center my-2 border bg-secondary text-primary rounded-md">
          <h1 className="text-xl">Woohoo! All steps completed! 🎉</h1>
        </div>
      )}
      <div className="w-full flex justify-end gap-2">
        {hasCompletedAllSteps ? (
          <Button size="sm" onClick={resetSteps}>
            Reset
          </Button>
        ) : (
          <>
            <Button
              disabled={isDisabledStep}
              onClick={prevStep}
              size="sm"
              variant="secondary"
            >
              Prev
            </Button>
            <Button size="sm" onClick={isLastStep ? onSubmit : nextStep}>
              {isLastStep ? "Finish" : isOptionalStep ? "Skip" : "Next"}
            </Button>
          </>
        )}
      </div>
    </DialogFooter>
  );
};

export default CreatePaymentForm;
