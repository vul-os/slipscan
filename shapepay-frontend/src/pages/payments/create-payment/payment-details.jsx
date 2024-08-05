import React from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// PaymentDetailsStep Component
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
          value={newPayment.amount || ""}
          onChange={(e) =>
            setNewPayment({ ...newPayment, amount: e.target.value })
          }
          className="col-span-3 bg-gray-700 text-gray-100 p-2 rounded-md border border-gray-600"
          required
        />
      </div>
      <div className="grid grid-cols-4 items-center gap-4">
        <Label htmlFor="description" className="text-left text-sm font-medium text-gray-300">
          External Reference
        </Label>
        <Input
          id="description"
          value={newPayment.description || ""}
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

export default PaymentDetailsStep;
