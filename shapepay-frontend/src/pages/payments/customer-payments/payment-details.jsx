import React from "react";
import { useStepper } from "@/components/stepper";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const PaymentDetailsStep = ({ merchantDetails, newPayment, setNewPayment }) => {

  return (
    <div className="flex flex-col items-center justify-center gap-8 py-10 w-full max-w-md mx-auto">
      <h2 className="text-2xl font-bold text-indigo-300 mb-6">
        Payment Details
      </h2>
      <div className="flex flex-col items-stretch gap-6 w-full">
        <div className="flex justify-between items-center">
          <span className="text-gray-300 font-medium">Merchant ID</span>
          <span className="text-white font-bold">{merchantDetails?.id}</span>
        </div>
        <div className="relative">
          <Label
            htmlFor="amount"
            className="block text-sm font-medium text-gray-300 mb-2"
          >
            Amount
          </Label>
          <div className="relative">
            <span className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 text-2xl font-bold">
              R
            </span>
            <Input
              id="amount"
              type="number"
              step="0.01"
              value={newPayment.amount}
              onChange={(e) =>
                setNewPayment({ ...newPayment, amount: e.target.value })
              }
              className="w-full bg-gray-700 text-gray-100 p-2 pl-10 rounded-md border border-gray-600 text-xl"
              required
            />
          </div>
        </div>
        <div>
          <Label
            htmlFor="referenceCode"
            className="block text-sm font-medium text-gray-300 mb-2"
          >
            Reference Code (Optional)
          </Label>
          <Input
            id="referenceCode"
            value={newPayment.referenceCode}
            onChange={(e) =>
              setNewPayment({ ...newPayment, referenceCode: e.target.value })
            }
            className="w-full bg-gray-700 text-gray-100 p-2 rounded-md border border-gray-600"
          />
        </div>
      </div>
    </div>
  );
};

export default PaymentDetailsStep;