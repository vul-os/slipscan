import React from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import SouthAfricanFlag from "./rsa-icon";

const CustomerInformation = ({ newPayment, setNewPayment }) => {
  const handleInputChange = (e) => {
    const { name, value } = e.target;
    setNewPayment((prevPayment) => ({
      ...prevPayment,
      [name]: value,
    }));
  };

  return (
    <div className="flex flex-col items-center justify-center w-full">
      <h2 className="text-xl sm:text-2xl font-bold text-indigo-300 mb-4 sm:mb-6">
        Customer Information
      </h2>
      <div className="flex flex-col items-stretch gap-4 sm:gap-6 w-full">
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
            placeholder="Enter customer name"
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
            placeholder="Enter customer email"
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
            <div className="flex items-center bg-gray-800 border border-gray-600 rounded-l-md px-2 sm:px-3">
              <SouthAfricanFlag className="w-4 h-4 sm:w-5 sm:h-5 mr-1 sm:mr-2" />
              <span className="text-gray-300 font-medium text-sm sm:text-base">+27</span>
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
        <p className="text-xs sm:text-sm text-gray-400 text-center mt-2">
          Please provide either an email or phone number.
        </p>
      </div>
    </div>
  );
};

export default CustomerInformation;