import React from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// CustomerDetailsStep Component
const CustomerDetailsStep = ({ newPayment, setNewPayment }) => {
  return (
    <div className="py-4 px-6 space-y-6 bg-gray-800 rounded-lg shadow-md">
      <div className="space-y-2">
        <Label
          htmlFor="customerEmail"
          className="text-sm font-medium text-gray-200"
        >
          Customer Email
        </Label>
        <Input
          id="customerEmail"
          type="email"
          placeholder="Enter customer email"
          value={newPayment.customerEmail}
          onChange={(e) =>
            setNewPayment({ ...newPayment, customerEmail: e.target.value })
          }
          className="w-full p-3 bg-gray-700 text-gray-100 rounded-md border border-gray-600 focus:border-blue-500 focus:outline-none"
        />
      </div>
      <div className="space-y-2">
        <Label
          htmlFor="customerPhone"
          className="text-sm font-medium text-gray-200"
        >
          Customer Phone
        </Label>
        <Input
          id="customerPhone"
          type="tel"
          placeholder="Enter customer phone"
          value={newPayment.customerPhone}
          onChange={(e) =>
            setNewPayment({ ...newPayment, customerPhone: e.target.value })
          }
          className="w-full p-3 bg-gray-700 text-gray-100 rounded-md border border-gray-600 focus:border-blue-500 focus:outline-none"
        />
      </div>
      <p className="text-sm text-gray-400">
        Customer details are optional.
      </p>
    </div>
  );
};

export default CustomerDetailsStep;
