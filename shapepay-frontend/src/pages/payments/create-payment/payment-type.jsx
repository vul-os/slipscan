import React from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { useStepper } from "@/components/stepper"; // Import useStepper from your stepper context

// PaymentTypeStep Component
const PaymentTypeStep = ({ newPayment, setNewPayment }) => {
  const { nextStep } = useStepper(); // Use nextStep from the stepper context

  return (
    <div className="flex flex-col items-center justify-center gap-6 py-8">
      <Label className="text-center text-lg font-medium text-gray-300 mb-4">
        Choose Simple Payment
      </Label>
      <Button
        onClick={() => {
          setNewPayment({ ...newPayment, paymentType: "simple" });
          nextStep(); // Use nextStep to automatically move to the next step
        }}
        className="px-6 py-3 rounded-lg shadow-md bg-blue-600 hover:bg-blue-700 text-white text-lg"
      >
        Simple Payment
      </Button>
      <p className="text-center text-sm text-gray-400 mt-4">
        Other payment methods are coming soon.
      </p>
    </div>
  );
};

export default PaymentTypeStep;
