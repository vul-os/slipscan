import React from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// CustomerDetailsStep Component
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
        Customer details are optional.
      </p>
    </div>
  );
};

export default CustomerDetailsStep;
