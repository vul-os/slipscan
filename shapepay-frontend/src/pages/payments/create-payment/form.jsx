"use client";

import React, { useState } from "react";
import { Stepper, Step } from "@/components/stepper";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import PaymentTypeStep from "./PaymentTypeStep";
import PaymentDetailsStep from "./PaymentDetailsStep";
import CustomerDetailsStep from "./CustomerDetailsStep";
import Footer from "./Footer";

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

export default CreatePaymentForm;
