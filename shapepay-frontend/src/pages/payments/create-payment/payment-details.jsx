import React from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// PaymentDetailsStep Component
const PaymentDetailsStep = ({ newPayment, setNewPayment }) => {
  return (
    <div className="py-4 px-6 space-y-6 bg-gray-800 rounded-lg shadow-md">
      <div className="flex flex-col space-y-2">
        <Label
          htmlFor="amount"
          className="text-sm font-medium text-gray-200"
        >
          Amount
        </Label>
        <div className="relative">
          <span className="absolute inset-y-0 left-0 flex items-center pl-3">
            <span className="text-xl text-gray-400">R</span>
          </span>
          <Input
            id="amount"
            type="number"
            step="0.01"
            value={newPayment.amount || ""}
            onChange={(e) =>
              setNewPayment({ ...newPayment, amount: e.target.value })
            }
            className="w-full pl-10 pr-4 py-3 bg-gray-700 text-gray-100 rounded-md border border-gray-600 focus:border-blue-500 focus:outline-none"
            placeholder="Enter amount"
            required
          />
        </div>
      </div>
      <div className="flex flex-col space-y-2">
        <Label
          htmlFor="description"
          className="text-sm font-medium text-gray-200"
        >
          External Reference
        </Label>
        <Input
          id="description"
          value={newPayment.description || ""}
          onChange={(e) =>
            setNewPayment({ ...newPayment, description: e.target.value })
          }
          className="w-full py-3 px-4 bg-gray-700 text-gray-100 rounded-md border border-gray-600 focus:border-blue-500 focus:outline-none"
          placeholder="Enter external reference"
          required
        />
      </div>
    </div>
  );
};

export default PaymentDetailsStep;
