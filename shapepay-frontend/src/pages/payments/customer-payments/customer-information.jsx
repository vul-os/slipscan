import React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import SouthAfricanFlag from "./rsa-icon";

const CustomerInformationStep = ({ newPayment, setNewPayment }) => {

  const handleInputChange = (e) => {
    const { name, value } = e.target;
    setNewPayment((prevPayment) => ({
      ...prevPayment,
      [name]: value,
    }));
  };

  return (
    <div className="flex flex-col items-center justify-center gap-8 py-10 w-full max-w-md mx-auto">
      <h2 className="text-2xl font-bold text-indigo-300 mb-6">
        Customer Information
      </h2>
      <div className="flex flex-col items-stretch gap-6 w-full">
        <div>
          <Label
            htmlFor="customerName"
            className="block text-sm font-medium text-gray-300 mb-2"
          >
            Customer Name (Optional)
          </Label>
          <Input
            id="customerName"
            name="customerName"
            value={newPayment.customerName}
            onChange={handleInputChange}
            className="w-full bg-gray-700 text-gray-100 p-2 rounded-md border border-gray-600"
          />
        </div>
        <div>
          <Label
            htmlFor="customerEmail"
            className="block text-sm font-medium text-gray-300 mb-2"
          >
            Customer Email (Optional)
          </Label>
          <Input
            id="customerEmail"
            name="customerEmail"
            type="email"
            value={newPayment.customerEmail}
            onChange={handleInputChange}
            className="w-full bg-gray-700 text-gray-100 p-2 rounded-md border border-gray-600"
          />
        </div>
        <div>
          <Label
            htmlFor="customerPhone"
            className="block text-sm font-medium text-gray-300 mb-2"
          >
            Customer Phone (Optional)
          </Label>
          <div className="flex">
            <div className="flex items-center bg-gray-800 border border-gray-600 rounded-l-md px-3">
              <SouthAfricanFlag className="mr-2" />
              <span className="text-gray-300 font-medium">+27</span>
            </div>
            <Input
              id="customerPhone"
              name="customerPhone"
              type="tel"
              value={newPayment.customerPhone}
              onChange={handleInputChange}
              className="flex-grow bg-gray-700 text-gray-100 p-2 rounded-r-md border border-gray-600"
              placeholder="Enter phone number"
            />
          </div>
        </div>
        <p className="text-sm text-gray-400 text-center">
          Please provide either an email or phone number.
        </p>
      </div>
    </div>
  );
};

export default CustomerInformationStep;