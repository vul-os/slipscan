import React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const PaymentDetails = ({ merchantDetails, newPayment, setNewPayment }) => {
  return (
    <div className="flex flex-col items-center justify-center w-full">
      <h2 className="text-xl sm:text-2xl font-bold text-indigo-300 mb-4 sm:mb-6">
        Payment Details
      </h2>
      <div className="flex flex-col items-stretch gap-4 sm:gap-6 w-full">
        <div className="flex justify-between items-center">
          <span className="text-sm sm:text-base text-gray-300 font-medium">Merchant ID</span>
          <span className="text-sm sm:text-base text-white font-bold">{merchantDetails?.id}</span>
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
              setNewPayment({ ...newPayment, referenceCode: e.target.value})
            }
            className="w-full bg-gray-700 text-gray-100 p-2 rounded-md border border-gray-600"
            placeholder="Enter reference code"
          />
        </div>
      </div>
    </div>
  );
};

export default PaymentDetails;